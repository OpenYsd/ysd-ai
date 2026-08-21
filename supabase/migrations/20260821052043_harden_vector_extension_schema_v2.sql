-- Forward-only pgvector schema hardening (Sprint 2), sequenced after live 0047.
--
-- Production currently owns vector 0.8.2 in public and reports it as
-- relocatable. ALTER EXTENSION preserves the extension object OIDs, so the
-- existing vector column, data, and HNSW index remain attached to the same
-- type/operator classes. The application RPC is then replaced with explicit
-- schema qualification because its old search_path=public would no longer
-- resolve the cosine-distance operator after the move.

set lock_timeout = '5s';
set statement_timeout = '60s';

create schema if not exists extensions;
revoke create on schema extensions from public;

do $preflight$
declare
  v_schema text;
  v_relocatable boolean;
begin
  select n.nspname, e.extrelocatable
    into v_schema, v_relocatable
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'vector';

  if v_schema is null then
    raise exception using
      errcode = '55000',
      message = 'vector extension is required before schema hardening';
  end if;

  if v_schema not in ('public', 'extensions') then
    raise exception using
      errcode = '55000',
      message = 'vector extension is installed in an unexpected schema';
  end if;

  if v_schema = 'public' and not v_relocatable then
    raise exception using
      errcode = '55000',
      message = 'vector extension is not relocatable on this database';
  end if;
end
$preflight$;

do $relocate$
begin
  if exists (
    select 1
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'vector'
       and n.nspname = 'public'
  ) then
    alter extension vector set schema extensions;
  end if;
end
$relocate$;

do $schema_grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant usage on schema extensions to authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant usage on schema extensions to service_role;
  end if;
end
$schema_grants$;

create or replace function public.match_file_chunks(
  p_query_embedding extensions.vector(384),
  p_file_ids uuid[],
  p_match_count integer default 8,
  p_min_similarity double precision default 0.75
)
returns table(
  chunk_id uuid,
  file_id uuid,
  chunk_index integer,
  content text,
  page_number integer,
  similarity double precision,
  original_name text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
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
    (1 - (fc.embedding operator(extensions.<=>) p_query_embedding))::double precision,
    f.original_name
  from public.file_chunks fc
  join public.files f on f.id = fc.file_id
  where fc.user_id = auth.uid()
    and f.user_id = auth.uid()
    and f.deleted_at is null
    and fc.embedding is not null
    and fc.file_id = any(p_file_ids)
    and (1 - (fc.embedding operator(extensions.<=>) p_query_embedding)) >= p_min_similarity
  order by fc.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
end
$function$;

comment on function public.match_file_chunks(extensions.vector,uuid[],integer,double precision) is
  'ysd_match_file_chunks_v2_extensions_vector_safe_path';

revoke execute on function public.match_file_chunks(extensions.vector,uuid[],integer,double precision)
  from public;

do $function_grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke execute on function public.match_file_chunks(extensions.vector,uuid[],integer,double precision)
      from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant execute on function public.match_file_chunks(extensions.vector,uuid[],integer,double precision)
      to authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.match_file_chunks(extensions.vector,uuid[],integer,double precision)
      to service_role;
  end if;
end
$function_grants$;

do $verify$
declare
  v_function oid;
begin
  if not exists (
    select 1
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'vector'
       and n.nspname = 'extensions'
  ) then
    raise exception using errcode = '55000', message = 'vector extension relocation did not persist';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_type t on t.oid = a.atttypid
      join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
     where n.nspname = 'public'
       and c.relname = 'file_chunks'
       and a.attname = 'embedding'
       and not a.attisdropped
       and tn.nspname = 'extensions'
       and t.typname = 'vector'
       and a.atttypmod = 384
  ) then
    raise exception using errcode = '55000', message = 'file_chunks embedding contract is invalid after relocation';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_class i
      join pg_catalog.pg_namespace n on n.oid = i.relnamespace
      join pg_catalog.pg_index x on x.indexrelid = i.oid
     where n.nspname = 'public'
       and i.relname = 'idx_chunks_embedding'
       and x.indisvalid
       and x.indisready
  ) then
    raise exception using errcode = '55000', message = 'vector HNSW index is not valid after relocation';
  end if;

  v_function := pg_catalog.to_regprocedure(
    'public.match_file_chunks(extensions.vector,uuid[],integer,double precision)'
  );
  if v_function is null then
    raise exception using errcode = '55000', message = 'match_file_chunks signature is missing after relocation';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = v_function
       and p.prosecdef
       and p.proconfig = array['search_path=""']
  ) then
    raise exception using errcode = '55000', message = 'match_file_chunks safe search_path is not enforced';
  end if;
end
$verify$;

reset statement_timeout;
reset lock_timeout;
