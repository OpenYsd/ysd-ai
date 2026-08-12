-- 0035 - Browser Assistant device authorization.
--
-- Stores only short-lived device authorization metadata. No password, refresh
-- token, provider key, page text, URL, cookies, auth headers, or browser history.

create table if not exists public.browser_device_authorizations (
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
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists browser_device_authorizations_user_code_idx
  on public.browser_device_authorizations (user_code);
create index if not exists browser_device_authorizations_expires_idx
  on public.browser_device_authorizations (expires_at);
create index if not exists browser_device_authorizations_user_idx
  on public.browser_device_authorizations (user_id, created_at desc)
  where user_id is not null;

alter table public.browser_device_authorizations enable row level security;
revoke all on public.browser_device_authorizations from anon, authenticated;

create or replace function public.cleanup_browser_device_authorizations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.browser_device_authorizations
   where expires_at < now() or consumed_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.cleanup_browser_device_authorizations() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cleanup_browser_device_authorizations() to service_role';
  end if;
end $$;

comment on table public.browser_device_authorizations is
  'Short-lived YSD Browser device authorization records. Stores hashes/codes/status only; no secrets or browsing content.';
