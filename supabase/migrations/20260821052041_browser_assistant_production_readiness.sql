-- Forward-only Browser Assistant production-readiness migration, sequenced after live 0047.
-- This is intentionally independent of historical migration 0035.
-- It is additive, performs no data deletion while applying, and aborts on
-- an unexpected pre-existing schema instead of guessing how to repair it.

do $migration$
declare
  v_bad_columns integer;
  v_expected_constraints text[] := array[
    'browser_device_authorizations_pkey',
    'browser_device_authorizations_user_code_key',
    'browser_device_code_hash_format',
    'browser_user_code_format',
    'browser_client_id_format',
    'browser_code_challenge_format',
    'browser_state_format',
    'browser_device_status',
    'browser_poll_count_nonnegative',
    'browser_device_authorizations_user_id_fkey'
  ];
begin
  if pg_catalog.to_regclass('public.browser_device_authorizations') is null then
    create table public.browser_device_authorizations (
      device_code_hash text primary key
        constraint browser_device_code_hash_format check (device_code_hash ~ '^[a-f0-9]{64}$'),
      user_code text not null unique
        constraint browser_user_code_format check (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
      client_id text not null
        constraint browser_client_id_format check (client_id = 'ysd-browser'),
      code_challenge text not null
        constraint browser_code_challenge_format check (code_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
      state text not null
        constraint browser_state_format check (state ~ '^[A-Za-z0-9_-]{16,128}$'),
      status text not null default 'pending'
        constraint browser_device_status check (status in ('pending', 'approved', 'denied', 'consumed')),
      user_id uuid references auth.users(id) on delete cascade,
      poll_count integer not null default 0
        constraint browser_poll_count_nonnegative check (poll_count >= 0),
      last_poll_at timestamptz,
      authorized_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz not null default pg_catalog.now(),
      expires_at timestamptz not null,
      updated_at timestamptz not null default pg_catalog.now()
    );
  else
    -- This migration owns the exact schema contract. A pre-existing table
    -- without our marker is unexpected even if its column names happen to
    -- look compatible; abort instead of adopting or rewriting it.
    if pg_catalog.obj_description(
      'public.browser_device_authorizations'::pg_catalog.regclass,
      'pg_class'
    ) is distinct from 'ysd_browser_device_authorizations_v1_service_role_only' then
      raise exception using
        errcode = '55000',
        message = 'browser_device_authorizations conflicts with the production-readiness contract';
    end if;

    -- Exact compatibility check for every required column. Extra columns are
    -- tolerated only when they do not alter this contract.
    with expected(name, udt_name, nullable) as (values
      ('device_code_hash','text',false), ('user_code','text',false),
      ('client_id','text',false), ('code_challenge','text',false),
      ('state','text',false), ('status','text',false),
      ('user_id','uuid',true), ('poll_count','int4',false),
      ('last_poll_at','timestamptz',true), ('authorized_at','timestamptz',true),
      ('consumed_at','timestamptz',true), ('created_at','timestamptz',false),
      ('expires_at','timestamptz',false), ('updated_at','timestamptz',false)
    )
    select pg_catalog.count(*) into v_bad_columns
      from expected e
      left join information_schema.columns c
        on c.table_schema = 'public'
       and c.table_name = 'browser_device_authorizations'
       and c.column_name = e.name
     where c.column_name is null
        or c.udt_name is distinct from e.udt_name
        or (c.is_nullable = 'YES') is distinct from e.nullable;

    if v_bad_columns <> 0 then
      raise exception using
        errcode = '55000',
        message = 'browser_device_authorizations conflicts with the production-readiness contract';
    end if;

    if exists (
      select 1 from pg_catalog.unnest(v_expected_constraints) expected(name)
      where not exists (
        select 1
          from pg_catalog.pg_constraint c
          join pg_catalog.pg_class t on t.oid = c.conrelid
          join pg_catalog.pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'public'
           and t.relname = 'browser_device_authorizations'
           and c.conname = expected.name
      )
    ) then
      raise exception using
        errcode = '55000',
        message = 'browser_device_authorizations has missing or renamed constraints';
    end if;
  end if;
end
$migration$;

do $indexes$
declare
  v_definition text;
begin
  select indexdef into v_definition from pg_catalog.pg_indexes
   where schemaname = 'public' and indexname = 'browser_device_authorizations_user_code_idx';
  if v_definition is not null and v_definition !~ '\(user_code\)$' then
    raise exception using errcode = '55000', message = 'conflicting browser user-code index';
  end if;

  select indexdef into v_definition from pg_catalog.pg_indexes
   where schemaname = 'public' and indexname = 'browser_device_authorizations_expires_idx';
  if v_definition is not null and v_definition !~ '\(expires_at\)$' then
    raise exception using errcode = '55000', message = 'conflicting browser expiry index';
  end if;

  select indexdef into v_definition from pg_catalog.pg_indexes
   where schemaname = 'public' and indexname = 'browser_device_authorizations_user_idx';
  if v_definition is not null
     and (v_definition !~ '\(user_id, created_at DESC\)'
          or v_definition !~ 'WHERE \(user_id IS NOT NULL\)') then
    raise exception using errcode = '55000', message = 'conflicting browser user index';
  end if;
end
$indexes$;

create index if not exists browser_device_authorizations_user_code_idx
  on public.browser_device_authorizations (user_code);
create index if not exists browser_device_authorizations_expires_idx
  on public.browser_device_authorizations (expires_at);
create index if not exists browser_device_authorizations_user_idx
  on public.browser_device_authorizations (user_id, created_at desc)
  where user_id is not null;

alter table public.browser_device_authorizations enable row level security;
alter table public.browser_device_authorizations force row level security;
revoke all on table public.browser_device_authorizations from public, anon, authenticated;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.browser_device_authorizations to service_role';
  end if;
end
$grants$;

comment on table public.browser_device_authorizations is
  'ysd_browser_device_authorizations_v1_service_role_only';

-- A conflicting two-argument function is not silently overwritten. Reruns are
-- recognized by the marker comment written below.
do $cleanup_conflict$
declare
  v_oid oid := pg_catalog.to_regprocedure('public.cleanup_browser_device_authorizations(integer,integer)');
begin
  if v_oid is not null
     and pg_catalog.obj_description(v_oid, 'pg_proc') is distinct from
       'ysd_browser_cleanup_v1_bounded_indexed' then
    raise exception using errcode = '55000', message = 'conflicting bounded browser cleanup function';
  end if;
end
$cleanup_conflict$;

create or replace function public.cleanup_browser_device_authorizations(
  p_limit integer default 250,
  p_retention_seconds integer default 3600
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_removed integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000
     or p_retention_seconds is null
     or p_retention_seconds < 300 or p_retention_seconds > 604800 then
    raise exception using errcode = '22023', message = 'invalid browser cleanup bounds';
  end if;

  with doomed as (
    select d.device_code_hash
      from public.browser_device_authorizations d
     where d.expires_at < pg_catalog.now()
        or d.consumed_at < pg_catalog.now()
           - pg_catalog.make_interval(secs => p_retention_seconds)
     order by d.expires_at, d.device_code_hash
     for update skip locked
     limit p_limit
  )
  delete from public.browser_device_authorizations d
   using doomed
   where d.device_code_hash = doomed.device_code_hash;

  get diagnostics v_removed = row_count;
  return v_removed;
end
$function$;

comment on function public.cleanup_browser_device_authorizations(integer,integer) is
  'ysd_browser_cleanup_v1_bounded_indexed';

-- Replace the known historical zero-argument cleanup with a bounded wrapper.
create or replace function public.cleanup_browser_device_authorizations()
returns integer
language sql
security definer
set search_path = ''
as $function$
  select public.cleanup_browser_device_authorizations(250, 3600)
$function$;

revoke all on function public.cleanup_browser_device_authorizations(integer,integer) from public, anon, authenticated;
revoke all on function public.cleanup_browser_device_authorizations() from public, anon, authenticated;
do $cleanup_grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cleanup_browser_device_authorizations(integer,integer) to service_role';
    execute 'grant execute on function public.cleanup_browser_device_authorizations() to service_role';
  end if;
end
$cleanup_grants$;
