-- Forward-only least-privilege hardening for the known caller-owned
-- SECURITY DEFINER functions. Authenticated access remains only where the
-- existing product contract requires it; PUBLIC and anon are unnecessary.

do $least_privilege$
declare
  v_function record;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    raise exception using errcode = '55000', message = 'expected Supabase anon role is missing';
  end if;

  for v_function in
    select p.oid, p.oid::pg_catalog.regprocedure as signature
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname in ('claim_rag_job', 'reclaim_expired_rag_jobs', 'match_file_chunks', 'is_admin')
  loop
    execute pg_catalog.format('revoke execute on function %s from public, anon', v_function.signature);
  end loop;
end
$least_privilege$;

do $verify$
declare
  v_missing_search_path integer;
  v_exposed integer;
begin
  select pg_catalog.count(*) into v_missing_search_path
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.proname in ('claim_rag_job', 'reclaim_expired_rag_jobs', 'match_file_chunks', 'is_admin')
     and (
       p.proconfig is null
       or not exists (
         select 1 from pg_catalog.unnest(p.proconfig) setting
          where setting like 'search_path=%'
       )
     );

  if v_missing_search_path <> 0 then
    raise exception using errcode = '55000', message = 'a hardened SECURITY DEFINER function lacks a fixed search_path';
  end if;

  select pg_catalog.count(distinct p.oid) into v_exposed
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    left join pg_catalog.pg_roles r on r.oid = acl.grantee
   where n.nspname = 'public'
     and p.prosecdef
     and p.proname in ('claim_rag_job', 'reclaim_expired_rag_jobs', 'match_file_chunks', 'is_admin')
     and acl.privilege_type = 'EXECUTE'
     and (acl.grantee = 0 or r.rolname = 'anon');

  if v_exposed <> 0 then
    raise exception using errcode = '55000', message = 'PUBLIC or anon SECURITY DEFINER execution remains';
  end if;
end
$verify$;
