\set ON_ERROR_STOP on

do $assertions$
declare
  v_rows integer;
  v_checksum text;
  v_index_valid boolean;
  v_extension_schema text;
  v_public_or_anon_definer_grants integer;
begin
  select count(*), md5(string_agg(id::text || ':' || content || ':' || embedding::text, '|' order by id))
    into v_rows, v_checksum
    from public.file_chunks;
  if v_rows <> 3 or v_checksum <> 'b9a53c817ec7116a6645aa2cf3b160ef' then
    raise exception 'representative vector data was not preserved';
  end if;

  select n.nspname into v_extension_schema
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'vector';
  if v_extension_schema <> 'extensions' then
    raise exception 'vector extension remains outside extensions schema';
  end if;

  select i.indisvalid and i.indisready into v_index_valid
    from pg_catalog.pg_index i
   where i.indexrelid = 'public.idx_chunks_embedding'::regclass;
  if v_index_valid is distinct from true then
    raise exception 'vector index is invalid';
  end if;

  select count(*) into v_public_or_anon_definer_grants
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  left join pg_catalog.pg_roles r on r.oid = a.grantee
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in ('claim_rag_job','reclaim_expired_rag_jobs','match_file_chunks','is_admin')
    and a.privilege_type = 'EXECUTE'
    and (a.grantee = 0 or r.rolname = 'anon');
  if v_public_or_anon_definer_grants <> 0 then
    raise exception 'public or anon can still execute a hardened SECURITY DEFINER function';
  end if;
end
$assertions$;

set role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
select count(*) as rag_match_count
from public.match_file_chunks(
  array_fill(0.1::real, array[384])::extensions.vector,
  array['30000000-0000-0000-0000-000000000003']::uuid[],
  8,
  0.0
);
reset role;

set role anon;
do $$
begin
  begin
    perform public.match_file_chunks(
      array_fill(0.1::real, array[384])::extensions.vector,
      array['30000000-0000-0000-0000-000000000003']::uuid[],
      8,
      0.0
    );
    raise exception 'anon unexpectedly executed match_file_chunks';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
reset role;

select jsonb_build_object(
  'vector_schema', (select n.nspname from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='vector'),
  'vector_version', (select extversion from pg_catalog.pg_extension where extname='vector'),
  'file_chunks', (select count(*) from public.file_chunks),
  'index_valid', (select indisvalid and indisready from pg_catalog.pg_index where indexrelid='public.idx_chunks_embedding'::regclass),
  'browser_rls', (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class where oid='public.browser_device_authorizations'::regclass),
  'browser_feature_enabled', false,
  'match_search_path', (select p.proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='match_file_chunks' limit 1)
) as rehearsal_result;
