\set ON_ERROR_STOP on

do $assertions$
declare
  v_rows integer;
  v_checksum text;
  v_index_valid boolean;
  v_extension_schema text;
  v_public_or_anon_definer_grants integer;
  v_usage_invoker_count integer;
  v_usage_anon_grants integer;
  v_usage_search_path_count integer;
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

  select count(*) filter (where not p.prosecdef),
         count(*) filter (where not pg_catalog.has_function_privilege('anon', p.oid, 'execute')),
         count(*) filter (where p.proconfig @> array['search_path=public, pg_temp'])
    into v_usage_invoker_count, v_usage_anon_grants, v_usage_search_path_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('usage_totals_self', 'usage_totals_for');
  if v_usage_invoker_count <> 2 or v_usage_anon_grants <> 2 or v_usage_search_path_count <> 2 then
    raise exception '0047 usage function security contract drifted';
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

do $$
declare
  v_self record;
  v_other record;
begin
  select * into v_self from public.usage_totals_self(null, null);
  if row(v_self.event_count, v_self.input_tokens, v_self.output_tokens, v_self.total_tokens)
       is distinct from row(2::bigint, 18::bigint, 18::bigint, 36::bigint) then
    raise exception 'authenticated self usage totals are incorrect: %', row_to_json(v_self);
  end if;

  select * into v_other
    from public.usage_totals_for('10000000-0000-0000-0000-000000000001', null, null);
  if row(v_other.event_count, v_other.input_tokens, v_other.output_tokens, v_other.total_tokens)
       is distinct from row(0::bigint, 0::bigint, 0::bigint, 0::bigint) then
    raise exception 'ordinary user can observe another user usage totals: %', row_to_json(v_other);
  end if;
end
$$;
reset role;

set role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);
do $$
declare
  v_all record;
begin
  select * into v_all from public.usage_totals_for(null, null, null);
  if row(v_all.event_count, v_all.input_tokens, v_all.output_tokens, v_all.total_tokens)
       is distinct from row(3::bigint, 118::bigint, 38::bigint, 156::bigint) then
    raise exception 'owner aggregate usage totals are incorrect: %', row_to_json(v_all);
  end if;
end
$$;
reset role;

set role anon;
do $$
begin
  begin
    perform public.usage_totals_self(null, null);
    raise exception 'anon unexpectedly executed usage_totals_self';
  exception when insufficient_privilege then
    null;
  end;

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
  'usage_rows', (select count(*) from public.usage_events),
  'usage_functions_security_invoker', (select bool_and(not p.prosecdef) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('usage_totals_self','usage_totals_for')),
  'usage_anon_execute', (select bool_or(pg_catalog.has_function_privilege('anon', p.oid, 'execute')) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('usage_totals_self','usage_totals_for')),
  'match_search_path', (select p.proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='match_file_chunks' limit 1)
) as rehearsal_result;
