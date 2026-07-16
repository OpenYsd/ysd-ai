-- ============================================================
-- YSD AI — migration 0013 (آمنة لإعادة التشغيل، لا تحذف بيانات)
-- رمز تسجيل مؤقت أحادي الاستخدام — بديل إرسال كود الدعوة إلى GoTrue.
--
-- لماذا (مُثبت بالاختبار الحي بعد 0012):
--   مُحفّزات BEFORE نظّفت القاعدة فعلًا (auth.users و auth.identities نظيفان
--   بعد تسجيل الدخول و getUser و refreshSession)، لكن استجابة signUp والـJWT
--   الأول ظلّا يحملان invite_code لأن GoTrue يبنيهما من كائنه **في الذاكرة**
--   لا من الصف المخزَّن. لا يوجد مُحفّز يُصلح ذلك.
--
-- العلاج الجذري:
--   لا يُرسَل كود الدعوة إلى GoTrue إطلاقًا. العميل يستبدله أولًا بتذكرة
--   عشوائية (32 بايت) قصيرة العمر أحادية الاستخدام عبر /api/invite/claim،
--   ونُخزّن hash التذكرة فقط. المُحفّز يستهلك التذكرة ذريًا ثم الدعوة ذريًا.
--   فإن بقيت التذكرة في الاستجابة أو الـJWT فهي حينها **مستهلَكة ومنتهية** —
--   بلا أي قيمة لمهاجم، بخلاف كود الدعوة القابل لإعادة الاستخدام.
-- ============================================================

-- ---------- 1) جدول التذاكر — hash فقط، لا التذكرة الخام ----------
create table if not exists invite_tickets (
  ticket_hash text primary key,                 -- sha256(ticket) hex
  invite_id uuid not null references beta_invites(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invite_tickets_expires_idx on invite_tickets (expires_at);

-- RLS مفعّلة **بلا أي سياسة**: لا وصول مباشر لأي دور (anon/authenticated).
-- الوصول حصرًا عبر دوال security definer أدناه.
alter table invite_tickets enable row level security;
-- دفاع في العمق: RLS بلا سياسات تُرجع صفرًا من الصفوف، لكن سحب الامتيازات
-- يجعلها «permission denied» فلا تظهر كجدول فارغ عبر PostgREST أصلًا.
revoke all on table invite_tickets from anon, authenticated;

-- ---------- 2) استبدال الكود بتذكرة (قبل التسجيل) ----------
-- يستقبل hash التذكرة محسوبًا في الخادم (Node) — لا التذكرة الخام ولا تُخزَّن.
-- لا يستهلك الدعوة: الاستهلاك يبقى ذريًا عند البوابة وحدها.
create or replace function beta_claim_invite(
  p_code text, p_ticket_hash text, p_ttl_seconds int default 600
) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_id uuid;
begin
  if p_code is null or length(p_code) < 8 then return false; end if;
  if p_ticket_hash is null or p_ticket_hash !~ '^[0-9a-f]{64}$' then return false; end if;

  select id into v_id from beta_invites
    where code_hash = encode(digest(p_code, 'sha256'), 'hex')
      and revoked_at is null
      and (expires_at is null or expires_at > now())
      and used_count < max_uses;
  if v_id is null then return false; end if;

  insert into invite_tickets (ticket_hash, invite_id, expires_at)
    values (p_ticket_hash, v_id,
            now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 1800))))
    on conflict (ticket_hash) do nothing;
  return true;
end $$;

-- ---------- 3) تنظيف التذاكر المنتهية/المستهلَكة ----------
create or replace function beta_purge_invite_tickets(p_hours int default 24)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  -- للمشرف أو لعملية خدمة/cron (auth.uid() is null)
  if auth.uid() is not null and not is_admin() then return 0; end if;
  delete from invite_tickets
    where expires_at < now() - make_interval(hours => p_hours)
       or (used_at is not null and used_at < now() - make_interval(hours => p_hours));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------- 4) تجريد مفاتيح التسجيل من auth.users ----------
-- نُجرّد invite_ticket أيضًا (دفاع في العمق: لا نُبقي أي أثر تسجيل في الصف)،
-- ونُبقي تجريد invite_code لحماية أي عميل قديم قد يرسله.
create or replace function strip_invite_code() returns trigger
language plpgsql
set search_path = '' as $$
begin
  -- عند الإدخال: مرّر القيم إلى البوابة عبر متغيّرات المعاملة قبل تجريدها.
  if tg_op = 'INSERT' then
    perform set_config('ysd.invite_code',
      coalesce(new.raw_user_meta_data->>'invite_code', ''), true);
    perform set_config('ysd.invite_ticket',
      coalesce(new.raw_user_meta_data->>'invite_ticket', ''), true);
  end if;
  new.raw_user_meta_data :=
    coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite_code' - 'invite_ticket';
  return new;
end $$;

create or replace function strip_invite_code_identity() returns trigger
language plpgsql
set search_path = '' as $$
begin
  -- لا تُمسّ بقية identity_data (sub/email/email_verified/phone_verified…)
  new.identity_data :=
    coalesce(new.identity_data, '{}'::jsonb) - 'invite_code' - 'invite_ticket';
  return new;
end $$;

-- إعادة إنشاء المُحفّزات بشرط يشمل المفتاحين
drop trigger if exists trg_strip_invite_code_ins on auth.users;
create trigger trg_strip_invite_code_ins
  before insert on auth.users
  for each row
  when (new.raw_user_meta_data ?| array['invite_code', 'invite_ticket'])
  execute function strip_invite_code();

drop trigger if exists trg_strip_invite_code_upd on auth.users;
create trigger trg_strip_invite_code_upd
  before update on auth.users
  for each row
  when (new.raw_user_meta_data ?| array['invite_code', 'invite_ticket'])
  execute function strip_invite_code();

drop trigger if exists trg_strip_invite_code_identity_ins on auth.identities;
create trigger trg_strip_invite_code_identity_ins
  before insert on auth.identities
  for each row
  when (new.identity_data ?| array['invite_code', 'invite_ticket'])
  execute function strip_invite_code_identity();

drop trigger if exists trg_strip_invite_code_identity_upd on auth.identities;
create trigger trg_strip_invite_code_identity_upd
  before update of identity_data on auth.identities
  for each row
  when (new.identity_data ?| array['invite_code', 'invite_ticket'])
  execute function strip_invite_code_identity();

-- ---------- 5) البوابة: تذكرة فقط، لا كود ----------
-- مسار كود الدعوة **أُزيل عمدًا**: أي مفتاح يصل GoTrue ينتهي في الاستجابة
-- والـJWT، فلا يجوز أن يصله الكود إطلاقًا. التسجيل يقبل التذكرة وحدها.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_require boolean;
  v_ticket text;
  v_invite_id uuid;
  v_ticket_invite uuid;
  v_terms_version text;
  v_accepted boolean;
begin
  v_ticket := nullif(coalesce(
    nullif(current_setting('ysd.invite_ticket', true), ''),
    new.raw_user_meta_data->>'invite_ticket'), '');

  select (value #>> '{}')::boolean into v_require
    from platform_settings where key = 'require_invite';

  -- استهلاك التذكرة ذريًا: UPDATE مشروط واحد + RETURNING (أحادية الاستخدام)
  if v_ticket is not null then
    update invite_tickets
      set used_at = now()
      where ticket_hash = encode(digest(v_ticket, 'sha256'), 'hex')
        and used_at is null
        and expires_at > now()
      returning invite_id into v_ticket_invite;
  end if;

  -- استهلاك الدعوة ذريًا: كل الشروط داخل WHERE (بلا select-ثم-update)
  if v_ticket_invite is not null then
    update beta_invites
      set used_count = used_count + 1
      where id = v_ticket_invite
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and used_count < max_uses
      returning id into v_invite_id;
  end if;

  if coalesce(v_require, true) and v_invite_id is null then
    raise exception 'invite_required_or_invalid';
  end if;

  -- الموافقة: النسخة من platform_settings لا من metadata
  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted then
    raise exception 'consent_required';
  end if;
  select value #>> '{}' into v_terms_version
    from platform_settings where key = 'terms_version';

  -- أي فشل هنا يُرجِع استهلاك التذكرة والدعوة معًا (نفس المعاملة)
  insert into profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into subscriptions (user_id, tier) values (new.id, 'free');

  if v_invite_id is not null then
    insert into beta_invite_uses (invite_id, user_id) values (v_invite_id, new.id)
      on conflict (invite_id, user_id) do nothing;
  end if;

  insert into user_consents (user_id, document, version)
    values (new.id, 'terms',   coalesce(v_terms_version, 'unversioned')),
           (new.id, 'privacy', coalesce(v_terms_version, 'unversioned'))
    on conflict do nothing;

  perform set_config('ysd.invite_code', '', true);
  perform set_config('ysd.invite_ticket', '', true);
  return new;
end $$;

-- ---------- 6) صلاحيات التنفيذ ----------
do $$ begin
  execute 'revoke all on function beta_claim_invite(text,text,int) from public';
  execute 'grant execute on function beta_claim_invite(text,text,int) to anon, authenticated';
  execute 'revoke all on function beta_purge_invite_tickets(int) from public, anon';
  execute 'grant execute on function beta_purge_invite_tickets(int) to authenticated';
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function strip_invite_code() to supabase_auth_admin';
    execute 'grant execute on function strip_invite_code_identity() to supabase_auth_admin';
  end if;
end $$;

-- ---------- 7) تنظيف لمرة واحدة (مفتاحا التسجيل معًا) ----------
-- يجب أن يسبق التحقّق: التحقّق يفحص invite_ticket أيضًا، فلو فحصنا ما لا ننظّفه
-- لفشلت المهاجرة بلا أي مخرج. ويجعلها مكتفية بذاتها عند إعادة التشغيل.
update auth.users
  set raw_user_meta_data = raw_user_meta_data - 'invite_code' - 'invite_ticket'
  where raw_user_meta_data ?| array['invite_code', 'invite_ticket'];

update auth.identities
  set identity_data = identity_data - 'invite_code' - 'invite_ticket'
  where identity_data ?| array['invite_code', 'invite_ticket'];

-- ---------- 8) تحقّق نهائي ----------
do $$
declare n_users int; n_ident int;
begin
  select count(*) into n_users from auth.users
    where raw_user_meta_data ?| array['invite_code', 'invite_ticket'];
  select count(*) into n_ident from auth.identities
    where identity_data ?| array['invite_code', 'invite_ticket'];
  if n_users > 0 or n_ident > 0 then
    raise exception 'ما زالت مفاتيح تسجيل مخزّنة — auth.users: %، auth.identities: %', n_users, n_ident;
  end if;
end $$;
