\set ON_ERROR_STOP on

-- Representative, data-bearing clone of the Production contracts touched by
-- live 0047 plus the three future migrations. This fixture contains no Production secrets or
-- copied user content.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text not null unique
);

create or replace function auth.uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create extension vector with schema public;

create table public.profiles (
  id uuid primary key references auth.users(id),
  role text not null default 'user'
);

create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public, pg_temp stable
as $$ select exists(select 1 from public.profiles where id = auth.uid() and role in ('admin', 'owner')) $$;

create table public.files (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  original_name text not null,
  deleted_at timestamptz
);

create table public.file_chunks (
  id uuid primary key,
  file_id uuid not null references public.files(id),
  user_id uuid not null references auth.users(id),
  chunk_index integer not null,
  content text not null,
  page_number integer,
  embedding vector(384)
);

create table public.usage_events (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid,
  model_id text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_usage_user_period
  on public.usage_events(user_id, created_at);

create index idx_chunks_embedding
  on public.file_chunks using hnsw (embedding vector_cosine_ops);

alter table public.files enable row level security;
alter table public.file_chunks enable row level security;
alter table public.usage_events enable row level security;

create policy files_owner_select on public.files
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy chunks_owner_select on public.file_chunks
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy usage_select_own on public.usage_events
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy usage_admin_read on public.usage_events
  for select to authenticated
  using ((select public.is_admin()));

insert into auth.users(id, email) values
  ('10000000-0000-0000-0000-000000000001', 'clone-owner@example.invalid'),
  ('20000000-0000-0000-0000-000000000002', 'clone-user@example.invalid');

insert into public.profiles(id, role) values
  ('10000000-0000-0000-0000-000000000001', 'owner'),
  ('20000000-0000-0000-0000-000000000002', 'user');

insert into public.files(id, user_id, original_name) values
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 'representative.txt');

insert into public.file_chunks(id, file_id, user_id, chunk_index, content, page_number, embedding) values
  ('40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 0, 'alpha', 1, array_fill(0.0::real, array[384])::vector),
  ('50000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 1, 'beta', 1, array_fill(0.1::real, array[384])::vector),
  ('60000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', 2, 'gamma', 2, array_fill(0.2::real, array[384])::vector);

insert into public.usage_events(id, user_id, model_id, input_tokens, output_tokens, created_at) values
  ('70000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000002', 'clone/model', 7, 5, '2026-08-20T01:00:00Z'),
  ('80000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000002', 'clone/model', 11, 13, '2026-08-20T02:00:00Z'),
  ('90000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'clone/model', 100, 20, '2026-08-20T03:00:00Z');

create or replace function public.match_file_chunks(
  p_query_embedding vector(384),
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
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  return query
  select fc.id, fc.file_id, fc.chunk_index, fc.content, fc.page_number,
         (1 - (fc.embedding <=> p_query_embedding))::double precision,
         f.original_name
  from file_chunks fc join files f on f.id = fc.file_id
  where fc.user_id = auth.uid() and f.user_id = auth.uid()
    and f.deleted_at is null and fc.embedding is not null
    and fc.file_id = any(p_file_ids)
    and (1 - (fc.embedding <=> p_query_embedding)) >= p_min_similarity
  order by fc.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
end
$$;

create or replace function public.claim_rag_job()
returns uuid language sql security definer set search_path = public
as $$ select null::uuid $$;

create or replace function public.reclaim_expired_rag_jobs()
returns integer language sql security definer set search_path = public
as $$ select 0 $$;

grant usage on schema public, auth to anon, authenticated, service_role;
revoke create on schema public from public;
grant select on public.files, public.file_chunks, public.usage_events to authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function public.match_file_chunks(vector,uuid[],integer,double precision) to public, anon, authenticated, service_role;
grant execute on function public.is_admin() to public, anon, authenticated, service_role;
grant execute on function public.claim_rag_job() to public, anon, authenticated, service_role;
grant execute on function public.reclaim_expired_rag_jobs() to public, anon, authenticated, service_role;
