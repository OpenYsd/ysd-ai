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
--   تجريده» — فقد أنشأ الآلية ولم يُحدَّث القارئ ليستعملها. هذا الترحيل يُكمل
--   نصف الإصلاح الناقص.
--
-- لماذا لزم ترحيل جديد: الخلل في جسم دالة مخزّنة في القاعدة، ولا يمكن إصلاحه
-- من كود التطبيق. ولا نعدّل 0011 ولا 0012 — بيئات طُبِّقا فيها لن تعيد
-- تشغيلهما، فالتصحيح يجب أن يكون ترحيلًا جديدًا يُطبَّق بعدهما.
--
-- ما لا يغيّره هذا الترحيل: الأدوار (profiles.role يبقى على default 'user'
-- ولا تُسنده الدالة إطلاقًا، فلا يستطيع العميل طلب admin)، ولا سياسات RLS،
-- ولا صلاحيات، ولا أي مستخدم قائم. لا حذف بيانات.
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
  -- المصدر الأول: متغيّر المعاملة الذي يضبطه strip_invite_code (BEFORE INSERT).
  -- والاحتياط: الصف نفسه — يبقى صحيحًا لو لم يُطبَّق 0012 بعدُ في بيئة ما،
  -- فلا يعتمد هذا الترحيل على ترتيب تطبيق لا نتحكّم فيه.
  v_code := nullif(current_setting('ysd.invite_code', true), '');
  if v_code is null then
    v_code := nullif(new.raw_user_meta_data->>'invite_code', '');
  end if;

  select (value #>> '{}')::boolean into v_require
    from platform_settings where key = 'require_invite';

  -- ===== استهلاك ذري: UPDATE مشروط واحد + RETURNING =====
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

  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted then
    raise exception 'consent_required';
  end if;
  select value #>> '{}' into v_terms_version
    from platform_settings where key = 'terms_version';

  -- الدور لا يُسنَد هنا عمدًا: profiles.role على default 'user'، فلا سبيل
  -- لعميل أن يطلب admin أو owner عبر بيانات التسجيل.
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

  -- تنظيف احتياطي: 0012 يجرّده قبل الإدراج، وهذا يشفي أي صف سبق الترحيل
  update auth.users
    set raw_user_meta_data = (raw_user_meta_data - 'invite_code')
    where id = new.id and raw_user_meta_data ? 'invite_code';

  return new;
end $$;
