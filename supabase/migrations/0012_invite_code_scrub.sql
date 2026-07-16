-- ============================================================
-- YSD AI — migration 0012 (إصلاح أمني عاجل، آمنة لإعادة التشغيل)
-- منع تخزين invite_code الخام في auth.users.raw_user_meta_data.
--
-- السبب الجذري (مُثبت بالاختبار الحي، لا بقراءة الكود):
--   GoTrue يُدخل المستخدم → مُحفّزنا after insert يعمل ويمحو الكود → ثم GoTrue
--   يُنشئ سجل الهوية ويدمج مطالباتها في نسخته **داخل الذاكرة** (وهي ما زالت
--   تحوي invite_code) ويعيد كتابة العمود كاملًا عبر UpdateOnly(raw_user_meta_data)
--   فيدهس المحو. الدليل: الحقل النهائي احتوى مفاتيحنا (display_name/terms_accepted/
--   invite_code) مدموجة مع مطالبات GoTrue (sub/email/email_verified/phone_verified).
--   لذلك المحو داخل مُحفّز after insert لا يمكن أن ينجح مبدئيًا — العلاج مُحفّز
--   BEFORE يُجرّد المفتاح عند كل كتابة، فيشمل كتابة GoTrue اللاحقة.
--
-- تنبيه معماري مهم:
--   بوابة الدعوة (handle_new_user) هي after insert وتقرأ الكود من الصف. ولأن
--   مُحفّز before يعدّل الصف قبل أن تراه، فإن التجريد عند الإدخال يُعمي البوابة
--   ويُفشل كل تسجيل. لذلك نمرّر الكود عبر متغيّر محلي بالمعاملة (is_local = true):
--   لا يُكتب في أي جدول، ولا يتجاوز حدود المعاملة، ولا يظهر في أي سجل.
-- ============================================================

-- ---------- 1) دالة التجريد: لا تلمس أي جدول ولا تسجّل أي قيمة ----------
create or replace function strip_invite_code() returns trigger
language plpgsql
set search_path = '' as $$
begin
  -- عند الإدخال فقط: مرّر الكود إلى البوابة عبر متغيّر المعاملة قبل تجريده.
  if tg_op = 'INSERT' then
    perform set_config('ysd.invite_code',
      coalesce(new.raw_user_meta_data->>'invite_code', ''), true);
  end if;
  new.raw_user_meta_data :=
    coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite_code';
  return new;
end $$;

revoke all on function strip_invite_code() from public;
do $$ begin
  -- supabase_auth_admin هو الدور الذي يكتب به GoTrue
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function strip_invite_code() to supabase_auth_admin';
  end if;
end $$;

-- ---------- 2) المُحفّزات: BEFORE فقط، وبشرط وجود المفتاح ----------
-- شرط when يعني أن العمليات العادية (تسجيل الدخول، تحديث الجلسة) لا تُشغّل
-- الدالة إطلاقًا — فلا كلفة على مسار المصادقة.
drop trigger if exists trg_strip_invite_code_ins on auth.users;
create trigger trg_strip_invite_code_ins
  before insert on auth.users
  for each row
  when (new.raw_user_meta_data ? 'invite_code')
  execute function strip_invite_code();

drop trigger if exists trg_strip_invite_code_upd on auth.users;
create trigger trg_strip_invite_code_upd
  before update of raw_user_meta_data on auth.users
  for each row
  when (new.raw_user_meta_data ? 'invite_code')
  execute function strip_invite_code();

-- ---------- 3) البوابة: تقرأ الكود من متغيّر المعاملة ----------
-- التغيير الوحيد عن 0011: مصدر v_code، وحذف محاولة المحو التي كان GoTrue يدهسها.
-- الاستهلاك الذرّي والموافقة بنسخة الخادم كما هما بلا تغيير.
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
  -- الكود من متغيّر المعاملة (يضعه strip_invite_code)، مع رجوع إلى الصف
  -- إن كان مُحفّز التجريد غائبًا لأي سبب.
  v_code := nullif(coalesce(
    nullif(current_setting('ysd.invite_code', true), ''),
    new.raw_user_meta_data->>'invite_code'), '');

  select (value #>> '{}')::boolean into v_require
    from platform_settings where key = 'require_invite';

  -- استهلاك ذري: UPDATE مشروط واحد + RETURNING (بلا select-ثم-update)
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

  -- أي فشل هنا يُرجِع استهلاك الدعوة (نفس المعاملة)
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

  -- نظّف متغيّر المعاملة فور استهلاكه
  perform set_config('ysd.invite_code', '', true);
  return new;
end $$;

-- ---------- 4) تنظيف لمرة واحدة للمستخدمين الحاليين ----------
update auth.users
  set raw_user_meta_data = raw_user_meta_data - 'invite_code'
  where raw_user_meta_data ? 'invite_code';

-- ---------- 5) تحقّق: يفشل بصوت عالٍ إن بقي أي كود ----------
do $$
declare n int;
begin
  select count(*) into n from auth.users where raw_user_meta_data ? 'invite_code';
  if n > 0 then
    raise exception 'ما زال % مستخدمًا يحمل invite_code — التنظيف لم ينجح', n;
  end if;
end $$;

-- ============================================================
-- auth.identities: لم تُمسّ عمدًا.
-- مطالبات هوية مزوّد email في GoTrue هي {sub, email, email_verified,
-- phone_verified} ولا تشمل بيانات التسجيل المخصّصة، فالمتوقع ألا تحوي
-- invite_code. لا يُضاف تنظيف/مُحفّز هنا إلا إذا أثبت الاستعلام أن
-- identity_has_code = true.
-- ============================================================
