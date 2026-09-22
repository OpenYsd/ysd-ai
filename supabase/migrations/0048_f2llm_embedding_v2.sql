-- ============================================================
-- YSD AI — migration 0048 (آمنة لإعادة التشغيل · إضافية فقط · قابلة للتراجع)
-- فضاء تضمين ثانٍ (F2LLM-v2-80M، 320 بُعدًا) بجوار الفضاء القائم (e5، 384).
--
-- ★ لا يمسّ هذا الملف شيئًا قائمًا:
--     • العمود file_chunks.embedding vector(384) وفهرسه idx_chunks_embedding
--     • الدالة match_file_chunks (0007) وكل صلاحياتها
--   بل يضيف بجوارها:
--     • file_chunks.embedding_v2 vector(320) — قابل للإلغاء، ويُملأ تدريجيًا
--     • file_chunks.embedding_v2_model text — وسمُ النموذج/الإصدار الذي أنتج المتجه
--     • files.rag_v2_model text — الملف مكتمل التضمين في هذا الفضاء (وإلا null)
--     • فهرس HNSW مستقل جزئي على embedding_v2
--     • match_file_chunks_v2 — لا تقرأ إلا embedding_v2، ولا تعيد إلا مقاطع تحمل الوسم المطلوب
--
-- ★ لا خلط بين الفضاءين بحكم البناء:
--     أبعاد مختلفة (320 ≠ 384) فيرفض Postgres أي مقارنة عابرة، ودالة v2 تشترط
--     تطابق الوسم على المقطع وعلى الملف معًا.
--
-- التراجع: supabase/rollbacks/0048_f2llm_embedding_v2.down.sql (يزيل الجديد فقط).
-- ============================================================

alter table file_chunks add column if not exists embedding_v2 vector(320);
alter table file_chunks add column if not exists embedding_v2_model text;
alter table files add column if not exists rag_v2_model text;

-- المتجه ووسمُه يسافران معًا: لا متجه بلا وسم ولا وسم بلا متجه
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'file_chunks_embedding_v2_model_pair'
      and conrelid = 'public.file_chunks'::regclass
  ) then
    alter table file_chunks add constraint file_chunks_embedding_v2_model_pair
      check ((embedding_v2 is null) = (embedding_v2_model is null));
  end if;
end $$;

-- فهرس مستقل: الفضاء القديم لا يتأثر ببنائه ولا بحجمه
create index if not exists idx_chunks_embedding_v2 on file_chunks
  using hnsw (embedding_v2 vector_cosine_ops)
  where embedding_v2 is not null;

-- دالة البحث v2 — نفس ضمانات match_file_chunks (auth.uid() + ملكية المقطع والملف)
-- وزيادة: تطابق الوسم على المقطع والملف، فلا يُقرأ متجهٌ من نموذج آخر أبدًا.
-- extensions في search_path: بعض القواعد (الإنتاج، بعد ترحيل التصليب) تنقل امتداد
-- vector من public إلى extensions. بلا هذا الاسم لا يُحلّ vector_dims ولا <=> عند أول
-- استدعاءٍ للدالة (يُحلَّل جسمها كسولًا، لا وقت الإنشاء) فتفشل بصمتٍ حتى أول استعلام.
-- الإضافة آمنةٌ في القواعد التي لم تُنقَل: public تبقى أولًا، ولا نوع vector آخر في
-- extensions يتعارض معه.
create or replace function match_file_chunks_v2(
  p_query_embedding vector(320),
  p_file_ids uuid[],
  p_model text,
  p_match_count int default 8,
  p_min_similarity float default 0.0
) returns table (
  chunk_id uuid,
  file_id uuid,
  chunk_index int,
  content text,
  page_number int,
  similarity float,
  original_name text
)
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  -- بلا جلسة → لا نتائج إطلاقًا
  if auth.uid() is null then
    return;
  end if;
  -- بلا وسم نموذج صريح → لا نتائج (لا «أي فضاء» ضمنيًا)
  if p_model is null or length(p_model) = 0 then
    return;
  end if;
  -- Postgres لا يفرض أبعاد النوع في معاملات الدوال؛ فنفرضها صراحةً بدل أن يعود بحثٌ فارغٌ صامت
  if vector_dims(p_query_embedding) <> 320 then
    raise exception 'match_file_chunks_v2 expects a 320-dimensional query vector, got %', vector_dims(p_query_embedding)
      using errcode = '22023';
  end if;

  return query
  select
    fc.id,
    fc.file_id,
    fc.chunk_index,
    fc.content,
    fc.page_number,
    (1 - (fc.embedding_v2 <=> p_query_embedding))::float,
    f.original_name
  from file_chunks fc
  join files f on f.id = fc.file_id
  where fc.user_id = auth.uid()             -- ملكية المقطع
    and f.user_id = auth.uid()              -- وملكية الملف — دفاع مزدوج
    and f.deleted_at is null
    and fc.embedding_v2 is not null
    and fc.embedding_v2_model = p_model     -- المقطع من هذا النموذج بعينه
    and f.rag_v2_model = p_model            -- والملف مكتمل التضمين فيه (لا نتائج جزئية)
    and fc.file_id = any(p_file_ids)
    and (1 - (fc.embedding_v2 <=> p_query_embedding)) >= p_min_similarity
  order by fc.embedding_v2 <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
end $$;

-- صلاحيات أضيق من match_file_chunks: لا public ولا anon.
-- (Supabase تمنح anon تنفيذ كل دالة جديدة في public عبر default privileges — و«from public» لا تنزعه.)
revoke all on function match_file_chunks_v2(vector, uuid[], text, int, float) from public, anon;
grant execute on function match_file_chunks_v2(vector, uuid[], text, int, float) to authenticated;
