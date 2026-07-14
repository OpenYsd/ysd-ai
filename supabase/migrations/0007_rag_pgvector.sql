-- ============================================================
-- YSD AI — migration 0007 (آمنة لإعادة التشغيل)
-- RAG محلي: pgvector + توسيع file_chunks + حالات RAG +
-- دالة بحث آمنة تتحقق من auth.uid() + حدود المقاطع لكل باقة.
-- ============================================================

-- 1) امتداد المتجهات
create extension if not exists vector;

-- 2) توسيع file_chunks (أبعاد multilingual-e5-small = 384)
alter table file_chunks add column if not exists user_id uuid references profiles(id) on delete cascade;
alter table file_chunks add column if not exists character_count int not null default 0;
alter table file_chunks add column if not exists embedding vector(384);
alter table file_chunks add column if not exists metadata jsonb not null default '{}';
alter table file_chunks add column if not exists page_number int;
alter table file_chunks add column if not exists content_hash text;
alter table file_chunks add column if not exists updated_at timestamptz not null default now();

-- 3) حالات RAG على الملفات + تقدم حقيقي + hash للمحتوى
alter type file_status add value if not exists 'chunking';
alter type file_status add value if not exists 'embedding';
alter type file_status add value if not exists 'ready_for_rag';
alter type file_status add value if not exists 'rag_failed';

alter table files add column if not exists rag_total_chunks int;
alter table files add column if not exists rag_done_chunks int;
alter table files add column if not exists rag_error text;
alter table files add column if not exists rag_content_hash text;

-- 4) metadata على الرسائل (لحفظ مصادر الرد واستعادتها بعد التحديث)
alter table messages add column if not exists metadata jsonb not null default '{}';

-- 5) الفهارس
create index if not exists idx_chunks_file on file_chunks(file_id, chunk_index);
create index if not exists idx_chunks_user on file_chunks(user_id);
create index if not exists idx_chunks_embedding on file_chunks
  using hnsw (embedding vector_cosine_ops);

-- 6) سياسات RLS الناقصة على file_chunks (القراءة موجودة من 0001)
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'file_chunks' and policyname = 'file_chunks_insert_own') then
    create policy "file_chunks_insert_own" on file_chunks for insert
      with check (
        user_id = auth.uid()
        and exists (select 1 from files f where f.id = file_id and f.user_id = auth.uid())
      );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'file_chunks' and policyname = 'file_chunks_update_own') then
    create policy "file_chunks_update_own" on file_chunks for update
      using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'file_chunks' and policyname = 'file_chunks_delete_own') then
    create policy "file_chunks_delete_own" on file_chunks for delete
      using (user_id = auth.uid());
  end if;
end $$;

-- 7) حدود المقاطع لكل باقة (خطة Supabase المجانية — قيم متحفظة)
alter table usage_limits add column if not exists max_chunks_per_file int not null default 200;
alter table usage_limits add column if not exists max_total_chunks int not null default 2000;
update usage_limits set max_chunks_per_file = 200,  max_total_chunks = 2000   where tier = 'free';
update usage_limits set max_chunks_per_file = 500,  max_total_chunks = 20000  where tier = 'plus';
update usage_limits set max_chunks_per_file = 1000, max_total_chunks = 100000 where tier = 'pro';
update usage_limits set max_chunks_per_file = 2000, max_total_chunks = 500000 where tier = 'business';

-- 8) دالة البحث الآمنة — تتحقق من auth.uid() ولا تعيد مقاطع غير مملوكة أبدًا
create or replace function match_file_chunks(
  p_query_embedding vector(384),
  p_file_ids uuid[],
  p_match_count int default 8,
  p_min_similarity float default 0.75
) returns table (
  chunk_id uuid,
  file_id uuid,
  chunk_index int,
  content text,
  page_number int,
  similarity float,
  original_name text
)
language plpgsql security definer set search_path = public as $$
begin
  -- بلا جلسة → لا نتائج إطلاقًا
  if auth.uid() is null then
    return;
  end if;

  return query
  select
    fc.id,
    fc.file_id,
    fc.chunk_index,
    fc.content,
    fc.page_number,
    (1 - (fc.embedding <=> p_query_embedding))::float,
    f.original_name
  from file_chunks fc
  join files f on f.id = fc.file_id
  where fc.user_id = auth.uid()          -- ملكية المقطع
    and f.user_id = auth.uid()           -- وملكية الملف — دفاع مزدوج
    and f.deleted_at is null
    and fc.embedding is not null
    and fc.file_id = any(p_file_ids)
    and (1 - (fc.embedding <=> p_query_embedding)) >= p_min_similarity
  order by fc.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
end $$;
