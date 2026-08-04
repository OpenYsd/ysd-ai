-- ============================================================
-- 0023 — إصلاح توقيت التحقّق في تسجيل Google (يستبدل شرط 0022 وحده)
--
-- ── العطل المُثبَت من سجلّات Auth ──
--
-- 0022 اشترط `new.email_confirmed_at is not null` للتعرّف على تدفّق Google.
-- والواقع أن هذا العمود ما يزال **null داخل مُحفِّز AFTER INSERT**: GoTrue
-- يُدرج الصفّ أولًا ثم يكتب `email_confirmed_at` في تحديثٍ لاحق. فكان
-- `v_google_signup` يبقى false دائمًا، وينتهي كل تسجيل Google إلى
-- `invite_required_or_invalid` — أي أن الميزة لم تعمل ولا مرة واحدة.
--
-- الدرس: قراءة عمودٍ **تكتبه الخدمة بعد الإدراج** من داخل مُحفِّز يعمل
-- **عند الإدراج** خطأٌ في التوقيت لا في المنطق؛ الشرط سليم نظريًا ومستحيل
-- عمليًا. ولا يظهر في أي اختبار محاكاة لأن المحاكاة تُملي القيمة بنفسها.
--
-- ── لماذا إسقاطه لا يُضعف الحماية ──
--
-- **GoTrue يتحقّق من OAuth قبل إدراج auth.users**: تبادل الرمز مع Google،
-- والتثبّت من هوية المزوّد، والتأكّد من ملكية البريد — كلها تقع قبل أن يوجد
-- الصفّ أصلًا. فوجود `provider = 'google'` في `raw_app_meta_data` **هو نفسه**
-- شهادةُ أن التدفّق اكتمل بنجاح؛ و`email_confirmed_at` تسجيلٌ متأخّر لواقعةٍ
-- سبقت، لا شرطٌ إضافي عليها. الاعتماد عليه كان توكيدًا لما هو مضمون سلفًا،
-- بثمنِ أن الميزة لا تعمل.
--
-- ── محور الأمان لم يتغيّر ──
--
-- المصدر يبقى `raw_app_meta_data` **حصرًا**: يملؤه GoTrue ولا يصله العميل.
-- أمّا `raw_user_meta_data` فيكتبه العميل — أي مستخدم يستطيع أن يرسل
-- `{"provider":"google"}` في تسجيل عادي بالبريد. قراءة المزوّد من الحقل
-- الخطأ تحوّل هذا الترحيل من ميزة إلى ثغرة تجاوز كاملة.
--
-- الثقة المتبقّية: من يملك مفتاح service_role يستطيع كتابة `app_metadata`
-- عبر `admin.createUser`. هذا صحيح في 0022 و0023 على السواء، وهو حدّ ثقةٍ
-- مقبول: مالك ذلك المفتاح يستطيع إنشاء الحساب مباشرة على أي حال.
--
-- ولا مزوّد آخر يتجاوز: الشرط مساواة صريحة بـ'google'، فأي مزوّد يُضاف
-- لاحقًا (GitHub, Apple…) يبقى خاضعًا للدعوة حتى يُقرَّر خلاف ذلك صراحةً.
--
-- ── ما لم يتغيّر إطلاقًا عن 0022 ──
--
--   • ترتيب الفحوص: `registration_closed` قبل أي استهلاك.
--   • الاستهلاك مشروط: لا تُحرق تذكرة في الوضع المفتوح ولا لمسار Google.
--   • مسار البريد وكلمة المرور: الدعوة والموافقة كما هما.
--   • الموافقة لمسار Google تُؤجَّل — لا صفوف user_consents عند الإنشاء،
--     وغيابها هو ما يوقف المستخدم عند /accept-terms قبل أي صفحة.
--   • الدور: profiles.role يبقى على default 'user' ولا تُسنده الدالة.
--
-- 0022 **لا تُعدَّل** — مطبَّقة بالفعل. هذا الترحيل يستبدل الدالة كاملةً.
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

  -- شرط تدفّق Google. لا ذكر لـemail_confirmed_at: العمود ما يزال null هنا
  -- (يكتبه GoTrue بعد الإدراج)، والتحقّق من OAuth تمّ قبل وجود هذا الصفّ.
  -- coalesce على allow_registration = false: الغياب يُعامل إغلاقًا، فلا يفتح
  -- إعدادٌ ناقصٌ بابًا بالخطأ.
  v_google_signup :=
    v_provider = 'google'
    and new.email is not null
    and coalesce(v_allow_registration, false);

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
