-- ============================================================
-- 0022 — السماح بإنشاء حساب عبر Google دون كود دعوة، بشروط صارمة
--
-- القرار: Google وحده يتجاوز بوابة الدعوة، وبثلاثة شروط مجتمعة:
--   ١) المزوّد google **من raw_app_meta_data**
--   ٢) البريد مُتحقَّق منه (email_confirmed_at غير فارغ عند الإدراج)
--   ٣) التسجيل العام مفتوح (allow_registration = true)
--
-- **لماذا raw_app_meta_data لا raw_user_meta_data**: هذا هو محور الأمان كله.
-- `raw_user_meta_data` يكتبه العميل — أي مستخدم يستطيع أن يرسل
-- `{"provider":"google"}` في تسجيل عادي بالبريد وكلمة المرور فيتخطّى الدعوة.
-- أمّا `raw_app_meta_data` فيملؤه GoTrue من تدفّق OAuth ولا يصله العميل. قراءة
-- المزوّد من الحقل الخطأ تحوّل هذا الترحيل من ميزة إلى ثغرة تجاوز كاملة.
--
-- ولماذا email_confirmed_at لا `email_verified` في user_metadata: الأول عمود
-- تكتبه الخدمة، والثاني حقل ضمن بيانات المستخدم — فيقع تحت الشبهة نفسها.
--
-- **ولا مزوّد آخر يتجاوز**: الشرط مساواة صريحة بـ'google'، فأي مزوّد يُضاف
-- لاحقًا (GitHub, Apple…) يبقى خاضعًا للدعوة حتى يُقرَّر خلاف ذلك صراحةً.
--
-- **الموافقة**: لا تُفرض على مسار Google عند الإنشاء — لا يملك المستخدم فرصة
-- قبولها قبل أن يعود من المزوّد. فلا تُدرَج صفوف user_consents له، و**غيابها
-- هو العلامة**: تخطيط التطبيق يحوّله إلى /accept-terms قبل أي صفحة أخرى.
-- بذلك تبقى الموافقة إلزامية فعلًا، لكن في موضعها الصحيح من الرحلة.
--
-- ── ترتيب الفحوص: لماذا هو جزء من العقد لا تفصيل أسلوبي ──
--
-- `registration_closed` يُفحص **قبل أي استهلاك**، كما أقرّه 0021. لو أُخِّر
-- بعد تحديث invite_tickets/beta_invites لكانت محاولةٌ في وضع مغلق تحرق تذكرة
-- وتزيد used_count ثم تتراجع بالاستثناء — والتراجع يعيد الصفوف لكنه لا يعيد
-- ما استُهلك في محاولات تُنفَّذ خارج المعاملة نفسها، ويجعل قراءة العدّادات
-- أثناء التشغيل كاذبة. الاستهلاك آخر ما يقع، لا أوّله.
--
-- والاستهلاك نفسه **مشروط**: لا يقع إلا حين تكون الدعوة مطلوبة فعلًا وليس
-- المسار تجاوزَ Google. في الوضع المفتوح لا معنى لحرق تذكرة أرسلها المستخدم
-- بلا حاجة إليها، ولا لخصم استخدام من دعوة لم تُشترط.
--
-- مسار البريد وكلمة المرور **لم يتغيّر إطلاقًا**: الدعوة والموافقة كما هما.
-- ولا يتغيّر الدور: profiles.role يبقى على default 'user' ولا تُسنده الدالة.
-- ============================================================

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_require boolean;
  v_allow_registration boolean;
  v_ticket text;
  v_invite_id uuid;
  v_ticket_invite uuid;
  v_terms_version text;
  v_accepted boolean;
  v_provider text;
  v_google_signup boolean := false;
begin
  v_ticket := nullif(coalesce(
    nullif(current_setting('ysd.invite_ticket', true), ''),
    new.raw_user_meta_data->>'invite_ticket'), '');

  select (value #>> '{}')::boolean into v_require
    from public.platform_settings where key = 'require_invite';
  select (value #>> '{}')::boolean into v_allow_registration
    from public.platform_settings where key = 'allow_registration';

  -- المزوّد من بيانات التطبيق (تكتبها الخدمة) لا من بيانات المستخدم
  v_provider := new.raw_app_meta_data->>'provider';

  -- الشروط الثلاثة مجتمعة. coalesce على allow_registration = false:
  -- الغياب يُعامل إغلاقًا، فلا يفتح إعدادٌ ناقصٌ بابًا بالخطأ.
  if v_provider = 'google'
     and new.email_confirmed_at is not null
     and coalesce(v_allow_registration, false) then
    v_google_signup := true;
  end if;

  -- ===== التسجيل المغلق: يُفحص قبل أي استهلاك =====
  if not coalesce(v_require, true) and not coalesce(v_allow_registration, false) then
    raise exception 'registration_closed';
  end if;

  -- ===== استهلاك التذكرة والدعوة — عند الحاجة إليهما وحدها =====
  -- كل الشروط داخل WHERE (بلا select-ثم-update)، فطلبان متزامنان لا يتجاوزان
  -- max_uses أبدًا.
  if coalesce(v_require, true) and not v_google_signup then
    if v_ticket is not null then
      update public.invite_tickets
        set used_at = now()
        where ticket_hash = encode(digest(v_ticket, 'sha256'), 'hex')
          and used_at is null
          and expires_at > now()
        returning invite_id into v_ticket_invite;
    end if;

    if v_ticket_invite is not null then
      update public.beta_invites
        set used_count = used_count + 1
        where id = v_ticket_invite
          and revoked_at is null
          and (expires_at is null or expires_at > now())
          and used_count < max_uses
        returning id into v_invite_id;
    end if;
  end if;

  -- بوابة الدعوة — يتخطّاها تسجيل Google المستوفي للشروط وحده
  if coalesce(v_require, true) and v_invite_id is null and not v_google_signup then
    raise exception 'invite_required_or_invalid';
  end if;

  -- بوابة الموافقة — تُؤجَّل لمسار Google إلى صفحة /accept-terms
  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted and not v_google_signup then
    raise exception 'consent_required';
  end if;

  select value #>> '{}' into v_terms_version
    from public.platform_settings where key = 'terms_version';

  insert into public.profiles (id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name',
                             new.raw_user_meta_data->>'full_name',
                             split_part(new.email, '@', 1)));
  insert into public.subscriptions (user_id, tier) values (new.id, 'free');

  if v_invite_id is not null then
    insert into public.beta_invite_uses (invite_id, user_id) values (v_invite_id, new.id)
      on conflict (invite_id, user_id) do nothing;
  end if;

  -- الموافقة تُسجَّل هنا لمن قبلها فعلًا. مستخدم Google لا صفوف له عمدًا،
  -- وغيابها هو ما يوقفه عند /accept-terms قبل أي صفحة.
  if v_accepted then
    insert into public.user_consents (user_id, document, version)
      values (new.id, 'terms',   coalesce(v_terms_version, 'unversioned')),
             (new.id, 'privacy', coalesce(v_terms_version, 'unversioned'))
      on conflict do nothing;
  end if;

  perform set_config('ysd.invite_code', '', true);
  perform set_config('ysd.invite_ticket', '', true);
  return new;
end $$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;
