-- ============================================================
-- 0020 — إصلاح تعطّل التسجيل: بوابة الدعوة لا ترى الكود إطلاقًا
--
-- العطل المرصود حيًّا:
--   كل محاولة إنشاء مستخدم ترجع 500 بجسم فارغ — من admin.createUser ومن
--   signUp العام معًا — بلا أي صف جزئي (تراجع كامل). ومع كود دعوة **صالح**،
--   يبقى beta_invites.used_count = 0 بعد المحاولة: دليل قاطع أن البوابة لم
--   ترَ الكود أصلًا، لا أنها رفضته.
--
-- السبب الجذري (تفاعل بين ترحيلين):
--   • 0011 عرّف handle_new_user كـAFTER INSERT، ويقرأ الكود من الصف نفسه:
--       v_code := nullif(new.raw_user_meta_data->>'invite_code', '');
--   • 0012 أضاف strip_invite_code كـ**BEFORE INSERT**، يمحو المفتاح من
--     raw_user_meta_data ويمرّره عبر متغيّر المعاملة:
--       perform set_config('ysd.invite_code', ..., true);
--
--   وBEFORE تُعدّل NEW قبل كتابة الصف، فالمُحفّز AFTER يقرأ صفًّا **مجرّدًا**
--   من المفتاح دائمًا. النتيجة: v_code = NULL في كل تسجيل، فتُرفع
--   'invite_required_or_invalid' ما دام require_invite = true — وهو وضعه
--   الحالي. أي أن التسجيل مستحيل تمامًا، لا صعب.
--
--   و0012 نفسه وثّق النيّة: «مرّر الكود إلى البوابة عبر متغيّر المعاملة قبل
--   تجريده» — فقد أنشأ الآلية ولم يُحدَّث القارئ ليستعملها.
--
-- لماذا لزم ترحيل جديد: الخلل في جسم دالة مخزّنة في القاعدة، ولا يمكن إصلاحه
-- من كود التطبيق. ولا نعدّل 0011 ولا 0012 — بيئات طُبِّقا فيها لن تعيد
-- تشغيلهما، فالتصحيح يجب أن يكون ترحيلًا جديدًا يُطبَّق بعدهما.
--
-- ما لا يغيّره هذا الترحيل: الأدوار (profiles.role يبقى على default 'user'
-- ولا تُسنده الدالة إطلاقًا، فلا يستطيع العميل طلب admin)، ولا سياسات RLS،
-- ولا أي مستخدم قائم. لا حذف بيانات.
-- ============================================================

-- ------------------------------------------------------------
-- 1) المُحفّز BEFORE INSERT يعمل على **كل** إدراج
--
-- كان `when (new.raw_user_meta_data ? 'invite_code')` يمنع تشغيله حين يغيب
-- المفتاح، فلا يُضبط ysd.invite_code إطلاقًا في ذلك الإدراج. وset_config
-- محلّي بالمعاملة، فإن أدرجت معاملة واحدة مستخدمَين — الأول بكود والثاني
-- بلا كود — ورث الثاني كود الأول واستهلك دعوة ليست له.
--
-- الشرط يبقى على مُحفّز UPDATE: هناك لا يوجد ما يُمرَّر، والغرض التنظيف وحده،
-- فالشرط يُبقيه بلا كلفة على مسار المصادقة العادي.
-- ------------------------------------------------------------
drop trigger if exists trg_strip_invite_code_ins on auth.users;
create trigger trg_strip_invite_code_ins
  before insert on auth.users
  for each row
  execute function strip_invite_code();

-- ------------------------------------------------------------
-- 2) البوابة تقرأ الكود من متغيّر المعاملة
-- ------------------------------------------------------------
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
  -- المصدر الأول: متغيّر المعاملة الذي يضبطه strip_invite_code (BEFORE INSERT).
  -- والاحتياط: الصف نفسه — يبقى صحيحًا لو لم يُطبَّق 0012 بعدُ في بيئة ما،
  -- فلا يعتمد هذا الترحيل على ترتيب تطبيق لا نتحكّم فيه.
  v_code := nullif(current_setting('ysd.invite_code', true), '');
  if v_code is null then
    v_code := nullif(new.raw_user_meta_data->>'invite_code', '');
  end if;

  select (value #>> '{}')::boolean into v_require
    from public.platform_settings where key = 'require_invite';

  -- ===== استهلاك ذري: UPDATE مشروط واحد + RETURNING =====
  -- كل الشروط داخل WHERE؛ لا select-ثم-update. طلبان متزامنان: الأول يقفل الصف،
  -- والثاني يُعاد تقييمه بعد الالتزام فلا يتجاوز max_uses أبدًا.
  if v_code is not null then
    v_hash := encode(digest(v_code, 'sha256'), 'hex');
    update public.beta_invites
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

  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted then
    raise exception 'consent_required';
  end if;
  select value #>> '{}' into v_terms_version
    from public.platform_settings where key = 'terms_version';

  -- الدور لا يُسنَد هنا عمدًا: profiles.role على default 'user'، فلا سبيل
  -- لعميل أن يطلب admin أو owner عبر بيانات التسجيل مهما أرسل فيها.
  insert into public.profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into public.subscriptions (user_id, tier) values (new.id, 'free');

  if v_invite_id is not null then
    insert into public.beta_invite_uses (invite_id, user_id) values (v_invite_id, new.id)
      on conflict (invite_id, user_id) do nothing;
  end if;

  insert into public.user_consents (user_id, document, version)
    values (new.id, 'terms',   coalesce(v_terms_version, 'unversioned')),
           (new.id, 'privacy', coalesce(v_terms_version, 'unversioned'))
    on conflict do nothing;

  -- تنظيف احتياطي: 0012 يجرّده قبل الإدراج، وهذا يشفي أي صف سبق الترحيل
  update auth.users
    set raw_user_meta_data = (raw_user_meta_data - 'invite_code')
    where id = new.id and raw_user_meta_data ? 'invite_code';

  return new;
end $$;

-- ------------------------------------------------------------
-- 3) لا EXECUTE عام على دالة مُحفّز
--
-- دوال المُحفّزات ينفّذها المحرّك نفسه، فلا يحتاجها أي دور تطبيقي. وهي
-- SECURITY DEFINER، فتركها قابلة للاستدعاء من anon/authenticated منح بلا
-- مقابل. (استدعاؤها مباشرةً يفشل أصلًا لغياب سياق المُحفّز، لكن المنع أوضح
-- من الاعتماد على ذلك.)
-- ------------------------------------------------------------
revoke all on function handle_new_user() from public;
revoke all on function handle_new_user() from anon;
revoke all on function handle_new_user() from authenticated;
