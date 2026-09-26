-- 0050 — فهرسُ الجمل لفضاء F2LLM: البحثُ بأفضل جملةٍ على كلّ مقاطع النطاق، بلا تضمينٍ وقتَ السؤال
--
-- ★ العطل (مقيسٌ، scripts/f2llm/calibration/longdoc-eval.ts، 39 سؤالًا × 3 نطاقات بالعربية والإنجليزية):
--   المسارُ الحاليّ يرتّب بمتجه المقطع ثمّ يعيد ترتيبَ أعلى 16 مقطعًا بأفضل جملة. في المحادثات متعدّدة
--   الملفّات يقع مقطعُ الجواب في المرتبة 21–69 بمتجه المقطع (حقيقةُ سطرٍ واحد يذيبها مقطعٌ متعدّد الموضوعات)،
--   فلا يبلغ الـ16 أصلًا: 107/117. وتوسيعُ النافذة وقتَ السؤال يعني تضمينَ مئات الجمل في كلّ سؤال.
--
-- ★ الإصلاح: متجهُ كلّ جملةٍ يُحسب مرّةً واحدة عند الفهرسة (بعد أن يصير الملفّ جاهزًا)، ويُحفظ نصفَ دقّة
--   (halfvec: 640 بايتًا بدل 1280 — مقيسٌ بلا أيّ فرقٍ في الدقّة: 117/117 بـfp32 وfp16). وعند السؤال:
--   استعلامٌ واحدٌ دقيقٌ داخل ملفّات المحادثة وحدها يرتّب كلَّ مقاطعها بأفضل جملة: 117/117، وصفرُ تضمينٍ وقتيّ.
--
-- ★ إضافيٌّ محض: جدولٌ جديد، وعمودٌ جديدٌ فارغ في files، ودالّةٌ جديدة. لا يُعدَّل كائنٌ قائم ولا تُمسّ بيانات.
--   الكودُ يعمل قبل تطبيقه كما يعمل اليوم (يسقط إلى المسار الحاليّ)، وبعده يستعمله حين يكتمل فهرسُ ملفّات المحادثة.
-- ★ لا فهرسَ HNSW على الجدول: البحثُ مقيّدٌ بملفّات المحادثة عبر (file_id, model)، فالمسحُ الدقيق رخيص،
--   ولا تُدفع كلفةُ فهرسٍ تقريبيّ في الكتابة ولا في الذاكرة.
-- ★ التراجع: supabase/rollbacks/0050_sentence_index_v2.down.sql (يُسقط هذه الكائنات الثلاثة وحدها).

-- 1) علامةُ «فهرسُ جمل هذا الملفّ مكتملٌ بهذا النموذج» — كـrag_v2_model للمقاطع
alter table files add column if not exists rag_v2_sentences_model text;

-- 2) متجهاتُ الجمل. نصُّ الجملة لا يُخزَّن: يُشتقّ حتميًّا من محتوى المقطع (splitSentences).
create table if not exists file_chunk_sentences (
  chunk_id uuid not null references file_chunks(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  sentence_index smallint not null check (sentence_index >= 0),
  model text not null,
  embedding halfvec(320) not null,
  primary key (chunk_id, model, sentence_index)
);
create index if not exists idx_chunk_sentences_file_model on file_chunk_sentences (file_id, model);

alter table file_chunk_sentences enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'file_chunk_sentences' and policyname = 'chunk_sentences_select_own') then
    create policy "chunk_sentences_select_own" on file_chunk_sentences for select
      using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'file_chunk_sentences' and policyname = 'chunk_sentences_insert_own') then
    create policy "chunk_sentences_insert_own" on file_chunk_sentences for insert
      with check (
        user_id = auth.uid()
        -- مؤهَّلٌ صراحةً: `file_id` غيرُ المؤهَّل داخل الاستعلام الفرعيّ يُحلّ إلى c.file_id فيصير الشرطُ صادقًا دائمًا
        and exists (
          select 1 from file_chunks c
          where c.id = file_chunk_sentences.chunk_id
            and c.file_id = file_chunk_sentences.file_id
            and c.user_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'file_chunk_sentences' and policyname = 'chunk_sentences_delete_own') then
    create policy "chunk_sentences_delete_own" on file_chunk_sentences for delete
      using (user_id = auth.uid());
  end if;
end $$;
revoke all on file_chunk_sentences from anon;
grant select, insert, delete on file_chunk_sentences to authenticated;

-- 3) البحثُ بأفضل جملة داخل ملفّات المستخدم المطلوبة — ضماناتُ match_file_chunks_v2 نفسُها، وزيادة:
--    الملفُّ مكتملُ فهرس الجمل بهذا النموذج (لا نتائج جزئيّة).
create or replace function match_chunk_sentences_v2(
  p_query_embedding vector(320),
  p_file_ids uuid[],
  p_model text,
  p_match_count int default 16
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
  -- بلا وسم نموذج صريح → لا نتائج
  if p_model is null or length(p_model) = 0 then
    return;
  end if;
  if vector_dims(p_query_embedding) <> 320 then
    raise exception 'match_chunk_sentences_v2 expects a 320-dimensional query vector, got %', vector_dims(p_query_embedding)
      using errcode = '22023';
  end if;

  return query
  with best as materialized (
    -- المرشّحون: جملُ الملفّات المطلوبة وحدها، المملوكة للمستخدم، بهذا النموذج
    select s.chunk_id, max(1 - (s.embedding <=> p_query_embedding::halfvec(320)))::float as sim
    from file_chunk_sentences s
    where s.file_id = any(p_file_ids)
      and s.user_id = auth.uid()
      and s.model = p_model
    group by s.chunk_id
  )
  select fc.id, fc.file_id, fc.chunk_index, fc.content, fc.page_number, b.sim, f.original_name
  from best b
  join file_chunks fc on fc.id = b.chunk_id
  join files f on f.id = fc.file_id
  where fc.user_id = auth.uid()              -- ملكية المقطع
    and f.user_id = auth.uid()               -- وملكية الملف — دفاع مزدوج
    and f.deleted_at is null
    and fc.embedding_v2_model = p_model      -- المقطع من هذا النموذج
    and f.rag_v2_model = p_model             -- الملف مكتمل التضمين فيه
    and f.rag_v2_sentences_model = p_model   -- وفهرسُ جمله مكتمل
  order by b.sim desc, fc.file_id, fc.chunk_index
  limit least(greatest(p_match_count, 1), 20);
end $$;

revoke all on function match_chunk_sentences_v2(vector, uuid[], text, int) from public, anon;
grant execute on function match_chunk_sentences_v2(vector, uuid[], text, int) to authenticated;
