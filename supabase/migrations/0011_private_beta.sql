-- ============================================================
-- YSD AI — migration 0011 (آمنة لإعادة التشغيل، لا تحذف بيانات)
-- Private Beta: دعوات (hash فقط)، موافقة الشروط، تعطيل التسجيل العام.
-- ============================================================

-- 1) تعطيل التسجيل العام افتراضيًا (يبقى إن غُيّر يدويًا لاحقًا)
update platform_settings set value = 'false' where key = 'allow_registration';
-- إعداد جديد: هل يتطلب التسجيل دعوة؟ (افتراضيًا نعم في Beta)
insert into platform_settings (key, value, owner_only)
values ('require_invite', 'true', false)
on conflict (key) do nothing;
-- نسخة الشروط/الخصوصية الحالية (لتتبّع الموافقات)
insert into platform_settings (key, value, owner_only)
values ('terms_version', '"2026-07-15"', true)
on conflict (key) do nothing;

-- 2) جدول دعوات Beta — نُخزّن hash فقط، لا الكود الخام أبدًا
create table if not exists beta_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,          -- sha256(code) hex — لا الكود الخام
  code_hint text,                          -- آخر 4 أحرف فقط للتعرّف الإداري
  label text,                              -- ملاحظة إدارية اختيارية
  max_uses int not null default 1 check (max_uses >= 1),
  used_count int not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_beta_invites_hash on beta_invites(code_hash);

-- ربط الدعوة بمن استخدمها (سجل الاستخدامات)
create table if not exists beta_invite_uses (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references beta_invites(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  used_at timestamptz not null default now(),
  unique (invite_id, user_id)
);

-- 3) موافقة المستخدم على الشروط/الخصوصية (نسخة + تاريخ)
create table if not exists user_consents (
  user_id uuid not null references profiles(id) on delete cascade,
  document text not null check (document in ('terms', 'privacy')),
  version text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, document, version)
);

-- ---------- RLS ----------
alter table beta_invites enable row level security;
alter table beta_invite_uses enable row level security;
alter table user_consents enable row level security;

do $$ begin
  -- beta_invites: قراءة/كتابة للمشرفين فقط (التحقق عند التسجيل عبر RPC آمنة)
  if not exists (select 1 from pg_policies where tablename='beta_invites' and policyname='invites_admin_all') then
    create policy "invites_admin_all" on beta_invites for all using (is_admin()) with check (is_admin());
  end if;
  -- beta_invite_uses: المشرف يرى الكل، المستخدم يرى استخداماته
  if not exists (select 1 from pg_policies where tablename='beta_invite_uses' and policyname='invite_uses_read') then
    create policy "invite_uses_read" on beta_invite_uses for select using (is_admin() or user_id = auth.uid());
  end if;
  -- user_consents: المستخدم يرى/يضيف موافقاته؛ المشرف يقرأ
  if not exists (select 1 from pg_policies where tablename='user_consents' and policyname='consents_own') then
    create policy "consents_own" on user_consents for select using (user_id = auth.uid() or is_admin());
  end if;
  if not exists (select 1 from pg_policies where tablename='user_consents' and policyname='consents_insert_own') then
    create policy "consents_insert_own" on user_consents for insert with check (user_id = auth.uid());
  end if;
end $$;

-- ============================================================
-- 4) دوال آمنة (security definer) — التحقق والاستهلاك على الخادم.
-- الكود الخام يصل الدالة فقط؛ لا يُخزَّن ولا يُسجَّل. hash فقط في الجدول.
-- ============================================================

-- تحقق أولي (قبل التسجيل، للواجهة): هل الدعوة صالحة؟ (بلا استهلاك)
-- يُرجع boolean فقط — لا يكشف تفاصيل الدعوة ولا الكود.
create or replace function beta_invite_valid(p_code text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp stable as $$
declare v beta_invites%rowtype;
begin
  if p_code is null or length(p_code) < 8 then return false; end if;
  select * into v from beta_invites where code_hash = encode(digest(p_code, 'sha256'), 'hex');
  if not found then return false; end if;
  if v.revoked_at is not null then return false; end if;
  if v.expires_at is not null and v.expires_at < now() then return false; end if;
  if v.used_count >= v.max_uses then return false; end if;
  return true;
end $$;

-- ============================================================
-- الإنفاذ الحقيقي: توسيع handle_new_user (المُحفّز على auth.users).
-- لا يمكن للعميل تجاوزه — يُرفض التسجيل إن لزمت الدعوة وكانت غير صالحة،
-- ويُستهلك ويُربط الكود، ثم يُمحى الكود الخام من بيانات المصادقة (لا يُخزَّن).
-- ============================================================
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_require boolean;
  v_code text;
  v_invite beta_invites%rowtype;
begin
  v_code := nullif(new.raw_user_meta_data->>'invite_code', '');
  select (value)::boolean into v_require from platform_settings where key = 'require_invite';

  -- بوابة الدعوة (إنفاذ خادمي)
  if coalesce(v_require, true) then
    if v_code is null then
      raise exception 'invite_required';
    end if;
    select * into v_invite from beta_invites
      where code_hash = encode(digest(v_code, 'sha256'), 'hex') for update;
    if not found
       or v_invite.revoked_at is not null
       or (v_invite.expires_at is not null and v_invite.expires_at < now())
       or v_invite.used_count >= v_invite.max_uses then
      raise exception 'invite_invalid';
    end if;
  end if;

  -- إنشاء الملف والاشتراك (كما في 0001)
  insert into profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into subscriptions (user_id, tier) values (new.id, 'free');

  -- استهلاك الدعوة وربطها بالمستخدم الجديد (ذري داخل نفس المعاملة)
  if v_code is not null then
    if v_invite.id is null then
      select * into v_invite from beta_invites
        where code_hash = encode(digest(v_code, 'sha256'), 'hex') for update;
    end if;
    if v_invite.id is not null
       and not exists (select 1 from beta_invite_uses where invite_id = v_invite.id and user_id = new.id) then
      insert into beta_invite_uses (invite_id, user_id) values (v_invite.id, new.id);
      update beta_invites set used_count = used_count + 1 where id = v_invite.id;
    end if;
  end if;

  -- حفظ موافقة الشروط/الخصوصية (النسخة من بيانات التسجيل)
  if new.raw_user_meta_data ? 'terms_version' then
    insert into user_consents (user_id, document, version)
      values (new.id, 'terms', new.raw_user_meta_data->>'terms_version'),
             (new.id, 'privacy', new.raw_user_meta_data->>'terms_version')
      on conflict do nothing;
  end if;

  -- امحُ الكود الخام من بيانات المصادقة حتى لا يُخزَّن
  update auth.users
    set raw_user_meta_data = (raw_user_meta_data - 'invite_code')
    where id = new.id and raw_user_meta_data ? 'invite_code';

  return new;
end $$;

-- إنشاء دعوة (إداري): يستقبل hash محسوبًا في الخادم (Node)، لا الكود الخام
create or replace function admin_create_invite(
  p_code_hash text, p_code_hint text, p_label text, p_max_uses int, p_expires_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not is_admin() then return null; end if;
  if p_max_uses < 1 then return null; end if;
  insert into beta_invites (code_hash, code_hint, label, max_uses, expires_at, created_by)
    values (p_code_hash, p_code_hint, nullif(p_label, ''), p_max_uses, p_expires_at, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- إلغاء دعوة (إداري)
create or replace function admin_revoke_invite(p_id uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then return 'forbidden'; end if;
  update beta_invites set revoked_at = now() where id = p_id and revoked_at is null;
  return case when found then 'ok' else 'not_found' end;
end $$;

-- ---------- صلاحيات التنفيذ ----------
do $$
declare fn text;
begin
  -- beta_invite_valid: يُستدعى قبل التسجيل → للمصادَقين والمجهولين (anon)
  execute 'revoke all on function beta_invite_valid(text) from public';
  execute 'grant execute on function beta_invite_valid(text) to anon, authenticated';
  -- الإدارية: للمصادَقين فقط (تتحقق is_admin داخليًا)
  for fn in select unnest(array[
    'admin_create_invite(text,text,text,int,timestamptz)',
    'admin_revoke_invite(uuid)'
  ]) loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ملاحظة تشغيلية: أعد تفعيل تأكيد البريد من لوحة Supabase
--   Authentication → Providers → Email → Confirm email = ON
