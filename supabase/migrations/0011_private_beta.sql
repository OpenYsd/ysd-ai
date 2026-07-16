-- ============================================================
-- YSD AI — migration 0011 (آمنة لإعادة التشغيل، لا تحذف بيانات)
-- Private Beta: دعوات (hash فقط)، موافقة الشروط، تعطيل التسجيل العام.
-- ============================================================

-- 0) فحص مسبق: digest() (pgcrypto) يجب أن تُحلّ بنفس search_path المستخدم في
-- الدوال أدناه. إن فشل هذا، يتوقف التطبيق هنا بدل أن ينكسر التسجيل لاحقًا.
do $$
begin
  perform set_config('search_path', 'public, extensions, pg_temp', true);
  perform encode(digest('probe', 'sha256'), 'hex');
exception when undefined_function then
  raise exception 'pgcrypto/digest غير متاحة. نفّذ: create extension if not exists pgcrypto with schema extensions;';
end $$;

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
  -- sha256(code) hex — لا الكود الخام. unique يمنع تكرار نفس الكود ويوفّر الفهرس.
  code_hash text not null unique,
  code_hint text,                          -- آخر 4 أحرف فقط للتعرّف الإداري
  label text,                              -- ملاحظة إدارية اختيارية
  max_uses int not null default 1 check (max_uses >= 1),
  used_count int not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
-- (لا حاجة لفهرس إضافي على code_hash — قيد unique أعلاه ينشئ فهرسًا فريدًا)

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
-- ملاحظة: extensions مُدرَجة في search_path لأن pgcrypto (digest) يُثبَّت هناك في
-- Supabase وليس في public — بدونها يفشل الحل ويتعطّل التسجيل. وهي مخطط نظام
-- مملوك لـ supabase_admin وغير قابل للكتابة من المستخدمين، فلا يُضعف التثبيت.
create or replace function beta_invite_valid(p_code text)
returns boolean
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare v_ok boolean;
begin
  if p_code is null or length(p_code) < 8 then return false; end if;
  -- لا نُحمّل الصف كاملًا: تقييم داخل SQL فيُرجع boolean فقط (بلا تسريب تفاصيل)
  select exists (
    select 1 from beta_invites
    where code_hash = encode(digest(p_code, 'sha256'), 'hex')
      and revoked_at is null
      and (expires_at is null or expires_at > now())
      and used_count < max_uses
  ) into v_ok;
  return v_ok;
end $$;

-- ============================================================
-- الإنفاذ الحقيقي: توسيع handle_new_user (المُحفّز على auth.users).
-- لا يمكن للعميل تجاوزه — يُرفض التسجيل إن لزمت الدعوة وكانت غير صالحة،
-- ويُستهلك ويُربط الكود، ثم يُمحى الكود الخام من بيانات المصادقة (لا يُخزَّن).
-- ============================================================
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_require boolean;
  v_code text;
  v_hash text;
  v_invite_id uuid;
  v_terms_version text;
  v_accepted boolean;
begin
  v_code := nullif(new.raw_user_meta_data->>'invite_code', '');
  select (value #>> '{}')::boolean into v_require
    from platform_settings where key = 'require_invite';

  -- ===== استهلاك ذري: UPDATE مشروط واحد + RETURNING =====
  -- كل الشروط داخل WHERE؛ لا select-ثم-update. طلبان متزامنان: الأول يقفل الصف،
  -- والثاني يُعاد تقييمه بعد الالتزام فلا يتجاوز max_uses أبدًا.
  if v_code is not null then
    v_hash := encode(digest(v_code, 'sha256'), 'hex');
    update beta_invites
      set used_count = used_count + 1
      where code_hash = v_hash
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and used_count < max_uses
      returning id into v_invite_id;
  end if;

  -- بوابة الدعوة (إنفاذ خادمي — لا يمكن تجاوزه من العميل)
  if coalesce(v_require, true) and v_invite_id is null then
    raise exception 'invite_required_or_invalid';
  end if;

  -- ===== الموافقة: النسخة من platform_settings لا من metadata =====
  -- من العميل نقبل «أنه وافق» فقط؛ رقم النسخة يُختم خادميًا.
  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted then
    raise exception 'consent_required';
  end if;
  select value #>> '{}' into v_terms_version
    from platform_settings where key = 'terms_version';

  -- إنشاء الملف والاشتراك — أي فشل هنا يُرجِع استهلاك الدعوة (نفس المعاملة)
  insert into profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into subscriptions (user_id, tier) values (new.id, 'free');

  -- ربط الدعوة بالمستخدم — unique(invite_id,user_id) يمنع الربط المكرر
  if v_invite_id is not null then
    insert into beta_invite_uses (invite_id, user_id) values (v_invite_id, new.id)
      on conflict (invite_id, user_id) do nothing;
  end if;

  -- حفظ الموافقة على الوثيقتين بنسخة الخادم
  insert into user_consents (user_id, document, version)
    values (new.id, 'terms',   coalesce(v_terms_version, 'unversioned')),
           (new.id, 'privacy', coalesce(v_terms_version, 'unversioned'))
    on conflict do nothing;

  -- امحُ الكود الخام من بيانات المصادقة — داخل نفس المعاملة، فلا يُخزَّن أبدًا
  update auth.users
    set raw_user_meta_data = (raw_user_meta_data - 'invite_code')
    where id = new.id and raw_user_meta_data ? 'invite_code';

  return new;
end $$;

-- ============================================================
-- سلوك الدعوة مع تأكيد البريد (قرار موثّق):
-- المُحفّز يعمل عند INSERT في auth.users أي **عند التسجيل قبل تأكيد البريد**،
-- فالدعوة تُحجَز فورًا. هذا ضروري لفرض max_uses ذريًا عند البوابة (لا يمكن
-- الحجز بعد التأكيد دون السماح بتجاوز الحد).
-- الخطر: استنزاف كود متعدد الاستخدامات بحسابات لا تؤكد بريدها.
-- المعالجة: دالة تنظيف تُحرِّر الحجوزات غير المؤكدة بعد مدة (تُجدوَل عبر cron).
-- ============================================================
create or replace function beta_release_unconfirmed_invites(p_hours int default 48)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int := 0; r record;
begin
  -- للمشرف أو لعملية خدمة/cron (auth.uid() is null)
  if auth.uid() is not null and not is_admin() then return 0; end if;

  for r in
    select u.id as use_id, u.invite_id
    from beta_invite_uses u
    join auth.users au on au.id = u.user_id
    where au.email_confirmed_at is null
      and u.used_at < now() - make_interval(hours => p_hours)
  loop
    delete from beta_invite_uses where id = r.use_id;
    update beta_invites
      set used_count = greatest(0, used_count - 1)
      where id = r.invite_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
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
    'admin_revoke_invite(uuid)',
    'beta_release_unconfirmed_invites(int)'
  ]) loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ملاحظة تشغيلية: أعد تفعيل تأكيد البريد من لوحة Supabase
--   Authentication → Providers → Email → Confirm email = ON
