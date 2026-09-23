-- READ-ONLY cutover snapshot: run before (step A) and after (step 7); compare.
-- No file names, no text, no vectors leave the database — counts, states and digests only.
with tag as (select 'f2llm-v2-80m@ad88d7a1.onnx-fcd9084eb3f4'::text as t)
select jsonb_build_object(
  'taken_at', now(),
  'files_by_status', (select jsonb_object_agg(s, n) from (
      select status::text s, count(*) n from files where deleted_at is null group by 1) x),
  'chunks_total',   (select count(*) from file_chunks),
  'chunks_e5',      (select count(*) from file_chunks where embedding is not null),
  -- ★ old 384-d vectors preserved ⇔ this digest is identical before and after
  'e5_digest',      (select md5(coalesce(string_agg(id::text || ':' || md5(embedding::text), ',' order by id), ''))
                       from file_chunks where embedding is not null),
  'chunks_v2_current_tag', (select count(*) from file_chunks where embedding_v2_model = (select t from tag)),
  -- ★ no vector-space mixing: a v2 vector always carries the current model tag
  'chunks_v2_other_tag',   (select count(*) from file_chunks where embedding_v2 is not null
                              and embedding_v2_model is distinct from (select t from tag)),
  'rag_jobs', (select jsonb_object_agg(k, n) from (
      select job_type || ':' || status::text k, count(*) n from rag_jobs group by 1) x),
  'rag_jobs_active', (select count(*) from rag_jobs where status::text in ('queued','running','retrying')),
  'idx_0049', (select count(*) from pg_indexes where indexname = 'files_content_fingerprint_uniq'),
  'fingerprinted_rows', (select count(*) from files where deleted_at is null and metadata->>'content_sha256' is not null),
  'fingerprint_conflicts', (select count(*) from (
      select 1 from files where deleted_at is null and metadata->>'content_sha256' is not null
      group by user_id, coalesce(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid),
               metadata->>'content_sha256', size_bytes having count(*) > 1) d),
  'migrations_f2llm', (select jsonb_agg(version || ':' || name order by version)
      from supabase_migrations.schema_migrations where name in ('f2llm_embedding_v2', 'file_content_fingerprint')),
  'repair_targets', (select jsonb_object_agg(left(f.id::text, 8), jsonb_build_object(
        'status', f.status::text,
        'linked', f.conversation_id is not null,
        'text_chars', length(coalesce(f.extracted_text, '')),
        'chunks', (select count(*) from file_chunks c where c.file_id = f.id),
        'e5', (select count(*) from file_chunks c where c.file_id = f.id and c.embedding is not null),
        'v2', (select count(*) from file_chunks c where c.file_id = f.id and c.embedding_v2_model = (select t from tag)),
        'v2_tagged', f.rag_v2_model = (select t from tag),
        'jobs', (select jsonb_agg(j.job_type || ':' || j.status::text order by j.created_at) from rag_jobs j where j.file_id = f.id)))
      from files f where f.id in (
        '63ede10a-7738-4b07-8fb5-fc66f56d8850', 'b824f939-253c-4113-82cf-1091135e0af3',
        '88422b61-17c2-4e67-a3fb-5e8fb25b38b1', 'ad691ac6-d1ef-4b7c-b053-06b5b4cd8f8f',
        'a9d179f1-ae50-4b2c-8982-a7757da8be1a', '812bea2f-5af7-4412-b7a8-149f17f1e854'))
) as snapshot;
