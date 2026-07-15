-- ============================================================
-- YSD AI — migration 0009 (آمنة لإعادة التشغيل)
-- لوحة الإدارة: حالة المستخدم، إعدادات المنصة، توسيع سجل التدقيق،
-- سياسات قراءة إدارية، ودوال أمنية لتغيير الأدوار/الباقات/الحالة
-- مع قواعد التسلسل الهرمي (owner-only) — بلا service role.
-- ============================================================

-- ---------- حالة المستخدم (بلا حذف حساب) ----------
alter table profiles add column if not exists status text not null default 'active'
  check (status in ('active', 'banned', 'ai_suspended'));

-- ---------- إصلاح أمني حرج: منع تصعيد الصلاحيات عبر تعديل الملف الشخصي ----------
-- سياسة 0001 كانت تسمح للمستخدم بتعديل صفّه كاملًا (بما فيه role/status).
-- نقيّد التعديل على الأعمدة الآمنة فقط؛ role/status لا تُغيَّر إلا عبر دوال
-- security definer (admin_set_user_role/status). أمّا handle_new_user فتعمل كـ definer.
revoke update on profiles from authenticated, anon;
grant update (display_name, avatar_url, locale, updated_at) on profiles to authenticated;

-- ---------- إعدادات المنصة المركزية ----------
create table if not exists platform_settings (
  key text primary key,
  value jsonb not null,
  owner_only boolean not null default false,   -- إعداد حرج يتطلب owner
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

insert into platform_settings (key, value, owner_only) values
  ('maintenance_mode',   'false',        true),
  ('allow_registration', 'true',         false),
  ('rag_enabled',        'true',         false),
  ('default_model_id',   '"ysd/free"',   false),
  ('announcement',       '""',           false)
on conflict (key) do nothing;

alter table platform_settings enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='platform_settings' and policyname='settings_read_all') then
    create policy "settings_read_all" on platform_settings for select using (true);
  end if;
  -- الكتابة عبر RPC فقط (security definer) — لا سياسة كتابة مباشرة
end $$;

-- ---------- توسيع سجل التدقيق ----------
alter table admin_audit_logs add column if not exists correlation_id uuid;
alter table admin_audit_logs add column if not exists ip text;
alter table admin_audit_logs add column if not exists user_agent text;
alter table admin_audit_logs add column if not exists before jsonb;
alter table admin_audit_logs add column if not exists after jsonb;
create index if not exists idx_audit_created on admin_audit_logs(created_at desc);
create index if not exists idx_audit_admin on admin_audit_logs(admin_id, created_at desc);

-- السماح للمشرف بإدراج سجلات تدقيقه (القراءة موجودة من 0001: audit_admin_only)
do $$ begin
  if not exists (select 1 from pg_policies where tablename='admin_audit_logs' and policyname='audit_insert_admin') then
    create policy "audit_insert_admin" on admin_audit_logs for insert
      with check (is_admin() and admin_id = auth.uid());
  end if;
end $$;

-- ---------- سياسات قراءة إدارية (is_admin) عبر الجداول للوحة النظرة العامة ----------
-- لا تُقرأ نصوص المقاطع أبدًا في استعلامات الإدارة (الأعمدة تُختار صراحة).
do $$ begin
  if not exists (select 1 from pg_policies where tablename='conversations' and policyname='conversations_admin_read') then
    create policy "conversations_admin_read" on conversations for select using (is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='messages' and policyname='messages_admin_read') then
    create policy "messages_admin_read" on messages for select using (is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='projects' and policyname='projects_admin_read') then
    create policy "projects_admin_read" on projects for select using (is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='files' and policyname='files_admin_read') then
    create policy "files_admin_read" on files for select using (is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='rag_jobs' and policyname='rag_jobs_admin_read') then
    create policy "rag_jobs_admin_read" on rag_jobs for select using (is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='usage_events' and policyname='usage_admin_read') then
    create policy "usage_admin_read" on usage_events for select using (is_admin());
  end if;
end $$;

-- تقوية is_admin (البوابة الأمنية) بنفس search_path الآمن — كانت 'public' فقط في 0001
create or replace function is_admin() returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

-- دالة: هل المستخدم الحالي owner؟
create or replace function is_owner() returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner');
$$;

-- ============================================================
-- دوال إدارية أمنية — التحقق على الخادم مع قواعد التسلسل الهرمي.
-- كلها security definer + set search_path، وتتحقق من is_admin()/is_owner().
-- ============================================================

-- تغيير دور مستخدم
create or replace function admin_set_user_role(p_target uuid, p_role user_role)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_target_role user_role;
begin
  if not is_admin() then return 'forbidden'; end if;
  if p_target = auth.uid() then return 'cannot_self'; end if;          -- لا يعدّل نفسه
  select role into v_target_role from profiles where id = p_target;
  if v_target_role is null then return 'not_found'; end if;
  -- owner فقط يُنشئ owner أو يعدّل owner
  if (p_role = 'owner' or v_target_role = 'owner') and not is_owner() then
    return 'owner_only';
  end if;
  update profiles set role = p_role, updated_at = now() where id = p_target;
  return 'ok';
end $$;

-- تغيير باقة مستخدم
create or replace function admin_set_user_tier(p_target uuid, p_tier plan_tier)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  if not exists (select 1 from profiles where id = p_target) then return 'not_found'; end if;
  update subscriptions set tier = p_tier, updated_at = now() where user_id = p_target;
  if not found then
    insert into subscriptions (user_id, tier) values (p_target, p_tier);
  end if;
  return 'ok';
end $$;

-- تغيير حالة مستخدم (حظر/تعليق AI) — لا يمس owner
create or replace function admin_set_user_status(p_target uuid, p_status text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_target_role user_role;
begin
  if not is_admin() then return 'forbidden'; end if;
  if p_status not in ('active', 'banned', 'ai_suspended') then return 'invalid'; end if;
  if p_target = auth.uid() then return 'cannot_self'; end if;
  select role into v_target_role from profiles where id = p_target;
  if v_target_role is null then return 'not_found'; end if;
  if v_target_role = 'owner' and not is_owner() then return 'owner_only'; end if;
  update profiles set status = p_status, updated_at = now() where id = p_target;
  return 'ok';
end $$;

-- إعادة تعيين استهلاك الشهر الحالي لمستخدم
create or replace function admin_reset_user_usage(p_target uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  delete from usage_events
    where user_id = p_target and created_at >= date_trunc('month', now());
  return 'ok';
end $$;

-- تعديل حدود باقة (مع تحقق القيم)
create or replace function admin_update_usage_limit(
  p_tier plan_tier, p_monthly_messages int, p_monthly_tokens bigint,
  p_daily_messages int, p_max_file_mb int, p_max_files int,
  p_max_storage_mb int, p_max_chunks_per_file int, p_max_total_chunks int
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  if least(p_monthly_messages, p_monthly_tokens, p_daily_messages, p_max_file_mb,
           p_max_files, p_max_storage_mb, p_max_chunks_per_file, p_max_total_chunks) < 0 then
    return 'negative';
  end if;
  update usage_limits set
    monthly_messages = p_monthly_messages, monthly_tokens = p_monthly_tokens,
    daily_messages = p_daily_messages, max_file_mb = p_max_file_mb,
    max_files = p_max_files, max_storage_mb = p_max_storage_mb,
    max_chunks_per_file = p_max_chunks_per_file, max_total_chunks = p_max_total_chunks,
    updated_at = now()
  where tier = p_tier;
  if not found then return 'not_found'; end if;
  return 'ok';
end $$;

-- تفعيل/تعطيل موفر أو نموذج
create or replace function admin_set_provider_enabled(p_id text, p_enabled boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update ai_providers set enabled = p_enabled where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end $$;

create or replace function admin_set_model_enabled(p_id text, p_enabled boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update ai_models set enabled = p_enabled where id = p_id;
  return case when found then 'ok' else 'not_found' end;
end $$;

-- كتابة إعداد منصة (الإعدادات الحرجة owner-only)
create or replace function admin_set_platform_setting(p_key text, p_value jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner_only boolean;
begin
  if not is_admin() then return 'forbidden'; end if;
  select owner_only into v_owner_only from platform_settings where key = p_key;
  if v_owner_only is null then return 'not_found'; end if;
  if v_owner_only and not is_owner() then return 'owner_only'; end if;
  update platform_settings set value = p_value, updated_by = auth.uid(), updated_at = now()
    where key = p_key;
  return 'ok';
end $$;

-- إعادة محاولة/إلغاء وظيفة RAG لأي مستخدم (إداري)
create or replace function admin_requeue_rag_job(p_job_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update rag_jobs set status = 'queued', locked_by = null, locked_at = null,
    available_at = now(), error_code = null, error_message = null
    where id = p_job_id and status in ('failed', 'cancelled', 'retrying');
  return case when found then 'ok' else 'not_found' end;
end $$;

create or replace function admin_cancel_rag_job(p_job_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update rag_jobs set status = 'cancelled', locked_by = null
    where id = p_job_id and status in ('queued', 'running', 'retrying');
  return case when found then 'ok' else 'not_found' end;
end $$;

-- ---------- صلاحيات التنفيذ: للمصادَقين فقط، لا public/anon ----------
do $$
declare fn text;
begin
  for fn in select unnest(array[
    'is_owner()',
    'admin_set_user_role(uuid,user_role)',
    'admin_set_user_tier(uuid,plan_tier)',
    'admin_set_user_status(uuid,text)',
    'admin_reset_user_usage(uuid)',
    'admin_update_usage_limit(plan_tier,int,bigint,int,int,int,int,int,int)',
    'admin_set_provider_enabled(text,boolean)',
    'admin_set_model_enabled(text,boolean)',
    'admin_set_platform_setting(text,jsonb)',
    'admin_requeue_rag_job(uuid)',
    'admin_cancel_rag_job(uuid)'
  ]) loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ملاحظة أمنية: is_admin()/is_owner() تبقى قابلة للتنفيذ (كما في 0001) لأنها
-- تُستدعى داخل سياسات RLS؛ سحب تنفيذها يجعل تقييم السياسة يفشل لغير المصرّح.
-- وهي آمنة: تُرجع false لغير المشرف ولا تكشف أي بيانات. لا تُغيّر شيئًا.

-- ============================================================
-- تمهيد أول owner يدويًا (شغّله مرة واحدة ببريدك):
--   update profiles set role = 'owner'
--   where id = (select id from auth.users where email = 'YOUR@EMAIL');
-- ============================================================
