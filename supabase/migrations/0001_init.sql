-- ============================================================
-- YSD AI — المخطط الأساسي لقاعدة البيانات
-- migration 0001: الجداول، الفهارس، RLS، الدوال المساعدة
-- التشغيل: supabase db push  أو  supabase migration up
-- ============================================================

create extension if not exists "pgcrypto";
-- فعّل pgvector عند إضافة البحث الدلالي:
-- create extension if not exists "vector";

-- ---------- الأنواع ----------
create type user_role as enum ('user', 'admin', 'owner');
create type message_role as enum ('user', 'assistant', 'system');
create type plan_tier as enum ('free', 'plus', 'pro', 'business');
create type file_status as enum ('uploading', 'processing', 'ready', 'failed');

-- ---------- الملفات الشخصية ----------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text not null default 'ar',
  role user_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- إنشاء الملف الشخصي تلقائيًا عند التسجيل
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into subscriptions (user_id, tier) values (new.id, 'free');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- مساحات العمل ----------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------- المشاريع ----------
create table projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  description text,
  custom_instructions text,
  model_settings jsonb not null default '{}',
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_projects_user on projects(user_id) where deleted_at is null;

-- ---------- المحادثات ----------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  title text not null default 'محادثة جديدة',
  model_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_conversations_user on conversations(user_id, updated_at desc) where deleted_at is null;
create index idx_conversations_project on conversations(project_id) where deleted_at is null;

create table project_conversations (
  project_id uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  primary key (project_id, conversation_id)
);

-- ---------- الرسائل ----------
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role message_role not null,
  content text not null,
  model_id text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_messages_conversation on messages(conversation_id, created_at) where deleted_at is null;

-- ---------- الملفات ----------
create table files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400), -- 25MB
  status file_status not null default 'uploading',
  error_message text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_files_user on files(user_id) where deleted_at is null;

create table file_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  -- embedding vector(1536), -- فعّلها مع pgvector للبحث الدلالي
  created_at timestamptz not null default now(),
  unique (file_id, chunk_index)
);

-- ---------- موفرو الذكاء الاصطناعي والنماذج ----------
create table ai_providers (
  id text primary key,               -- 'anthropic' | 'openai' | ...
  display_name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table ai_models (
  id text primary key,               -- 'claude-sonnet-4-6' | ...
  provider_id text not null references ai_providers(id) on delete cascade,
  display_name_ar text not null,
  display_name_en text not null,
  min_tier plan_tier not null default 'free',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into ai_providers (id, display_name) values ('anthropic', 'Anthropic');
insert into ai_models (id, provider_id, display_name_ar, display_name_en)
values ('claude-sonnet-4-6', 'anthropic', 'YSD سريع', 'YSD Swift');

-- ---------- التفضيلات ----------
create table user_preferences (
  user_id uuid primary key references profiles(id) on delete cascade,
  theme text not null default 'dark',
  default_model_id text references ai_models(id),
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ---------- الباقات والاستهلاك ----------
create table subscriptions (
  user_id uuid primary key references profiles(id) on delete cascade,
  tier plan_tier not null default 'free',
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table usage_limits (
  tier plan_tier primary key,
  monthly_messages int not null,
  monthly_tokens bigint not null,
  max_file_mb int not null,
  updated_at timestamptz not null default now()
);

-- الحدود المركزية — تُعدّل من لوحة الإدارة وليس من الكود
insert into usage_limits (tier, monthly_messages, monthly_tokens, max_file_mb) values
  ('free',     200,    500000,    5),
  ('plus',     2000,   5000000,   25),
  ('pro',      10000,  25000000,  25),
  ('business', 100000, 250000000, 25);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  model_id text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_usage_user_period on usage_events(user_id, created_at);

-- دالة التحقق من الحدود — تُستدعى من مسار المحادثة
create or replace function check_usage_allowed(p_user_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tier plan_tier;
  v_limit_messages int;
  v_used int;
begin
  select tier into v_tier from subscriptions where user_id = p_user_id;
  if v_tier is null then v_tier := 'free'; end if;
  select monthly_messages into v_limit_messages from usage_limits where tier = v_tier;
  select count(*) into v_used from usage_events
    where user_id = p_user_id and created_at >= date_trunc('month', now());
  return v_used < v_limit_messages;
end $$;

-- ---------- سجل عمليات الإدارة ----------
create table admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references profiles(id),
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security — منع أي مستخدم من قراءة بيانات غيره
-- ============================================================
alter table profiles enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table projects enable row level security;
alter table conversations enable row level security;
alter table project_conversations enable row level security;
alter table messages enable row level security;
alter table files enable row level security;
alter table file_chunks enable row level security;
alter table ai_providers enable row level security;
alter table ai_models enable row level security;
alter table user_preferences enable row level security;
alter table subscriptions enable row level security;
alter table usage_limits enable row level security;
alter table usage_events enable row level security;
alter table admin_audit_logs enable row level security;

-- دالة مساعدة: هل المستخدم الحالي مشرف؟
create or replace function is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

-- profiles: المستخدم يرى ويعدّل ملفه فقط، والمشرف يرى الجميع
create policy "profiles_select_own" on profiles for select using (id = auth.uid() or is_admin());
create policy "profiles_update_own" on profiles for update using (id = auth.uid());

-- projects
create policy "projects_all_own" on projects for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- conversations
create policy "conversations_all_own" on conversations for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- messages: عبر ملكية المحادثة
create policy "messages_select_own" on messages for select using (
  exists (select 1 from conversations c where c.id = conversation_id and c.user_id = auth.uid())
);
create policy "messages_insert_own" on messages for insert with check (
  exists (select 1 from conversations c where c.id = conversation_id and c.user_id = auth.uid())
);

-- project_conversations: عبر ملكية المشروع
create policy "pc_all_own" on project_conversations for all using (
  exists (select 1 from projects p where p.id = project_id and p.user_id = auth.uid())
);

-- files
create policy "files_all_own" on files for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "file_chunks_select_own" on file_chunks for select using (
  exists (select 1 from files f where f.id = file_id and f.user_id = auth.uid())
);

-- workspaces
create policy "workspaces_owner" on workspaces for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "workspace_members_self" on workspace_members for select
  using (user_id = auth.uid());

-- النماذج والموفرون: قراءة للجميع، تعديل للمشرف فقط
create policy "providers_read" on ai_providers for select using (true);
create policy "providers_admin_write" on ai_providers for all using (is_admin());
create policy "models_read" on ai_models for select using (true);
create policy "models_admin_write" on ai_models for all using (is_admin());

-- التفضيلات والاشتراك والاستهلاك
create policy "prefs_all_own" on user_preferences for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "subs_select_own" on subscriptions for select
  using (user_id = auth.uid() or is_admin());
create policy "limits_read" on usage_limits for select using (true);
create policy "limits_admin_write" on usage_limits for all using (is_admin());
create policy "usage_select_own" on usage_events for select
  using (user_id = auth.uid() or is_admin());

-- سجل الإدارة: للمشرفين فقط
create policy "audit_admin_only" on admin_audit_logs for all using (is_admin());
