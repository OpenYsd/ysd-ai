-- ============================================================
-- 0021 — استرجاع مسار التذاكر + إنفاذ حالات التسجيل الثلاث
--
-- ⚠️ يُصلح انحدارًا أدخله 0020. اقرأ هذا القسم قبل أي شيء:
--
--   0013 نقل بوابة الدعوة من «كود خام في metadata» إلى **تذكرة**: مسار
--   /api/invite/claim يستبدل الكود بتذكرة قصيرة العمر أحادية الاستخدام
--   (beta_claim_invite بحدّ 3 تذاكر نشطة و20 في الساعة لكل دعوة — حماية من
--   التعداد وتخمين الأكواد)، ثم يقرأ handle_new_user التذكرة لا الكود.
--
--   و0020 أُسّس خطأً على نسخة 0011 (الكود الخام) لا على 0013، فاستبدل الدالة
--   بنسخة **لا تفهم التذاكر إطلاقًا**. النتيجة المرصودة حيًّا بعد تطبيقه:
--   تسجيل بتذكرة صالحة يفشل 500 وused_count يبقى 0 — أي أن نموذج التسجيل
--   الحقيقي (register-form يرسل invite_ticket) معطّل.
--
--   وأصل الخطأ تشخيصٌ ناقص: كانت اختباراتي ترسل invite_code، وهو غير مدعوم
--   منذ 0013، فقرأتُ الفشل على أنه عطل في البوابة لا في بيانات الاختبار.
--
--   لا يُعدَّل 0020 (مُطبَّق فعلًا). هذا الترحيل يستعيد منطق 0013 كاملًا.
--
-- ولا يُعاد دعم invite_code الخام عمدًا: إعادته تلتف على حدود إصدار التذاكر
-- وتُرجع تخمين الأكواد الذي وُضع 0013 لمنعه.
--
-- ============================================================
-- حالات التسجيل الثلاث (قرار منتج مُلزِم):
--
--   require_invite = true                        → invite_only
--       التسجيل بدعوة صالحة فقط، أيًّا كانت allow_registration.
--   require_invite = false و allow_registration = true   → open
--       التسجيل مسموح بلا دعوة.
--   require_invite = false و allow_registration = false  → closed
--       كل إنشاء مستخدم مرفوض، **بما فيه admin.createUser**.
--
-- المُحفّز يسري على كل INSERT في auth.users أيًّا كان مصدره، فلا استثناء
-- لواجهة الإدارة — وهو المطلوب صراحةً.
--
-- الدور: profiles.role يبقى على default 'user' ولا تُسنده الدالة إطلاقًا،
-- فلا metadata ولا Admin API يستطيع تعيين admin أو owner.
-- ============================================================

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_require boolean;
  v_allow boolean;
  v_ticket text;
  v_invite_id uuid;
  v_ticket_invite uuid;
  v_terms_version text;
  v_accepted boolean;
begin
  -- التذكرة من متغيّر المعاملة (يضبطه strip_invite_code قبل الإدراج)، ثم من
  -- الصف احتياطًا لبيئة لم يُطبَّق فيها مُحفّز التجريد.
  v_ticket := nullif(coalesce(
    nullif(current_setting('ysd.invite_ticket', true), ''),
    new.raw_user_meta_data->>'invite_ticket'), '');

  select (value #>> '{}')::boolean into v_require
    from public.platform_settings where key = 'require_invite';
  select (value #>> '{}')::boolean into v_allow
    from public.platform_settings where key = 'allow_registration';

  -- ===== الحالة closed: تُرفع **قبل** أي استهلاك أو إدراج =====
  -- coalesce(v_allow, false) يفشل مغلقًا: غياب الصف مع require_invite=false
  -- حالة إعداد متناقضة، والرفض فيها أسلم من فتح التسجيل على مصراعيه.
  if not coalesce(v_require, true) and not coalesce(v_allow, false) then
    raise exception 'registration_closed';
  end if;

  -- ===== الحالة invite_only: استهلاك ذرّي للتذكرة ثم الدعوة =====
  if coalesce(v_require, true) then
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

    if v_invite_id is null then
      raise exception 'invite_required_or_invalid';
    end if;
  end if;
  -- الحالة open: لا دعوة مطلوبة، ولا تُستهلك تذكرة حتى لو أُرسلت.

  -- ===== الموافقة: النسخة من platform_settings لا من metadata =====
  v_accepted := coalesce((new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted then
    raise exception 'consent_required';
  end if;
  select value #>> '{}' into v_terms_version
    from public.platform_settings where key = 'terms_version';

  -- أي فشل هنا يُرجِع استهلاك التذكرة والدعوة معًا (نفس المعاملة)
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

  perform set_config('ysd.invite_code', '', true);
  perform set_config('ysd.invite_ticket', '', true);
  return new;
end $$;

-- ------------------------------------------------------------
-- المُحفّز BEFORE INSERT يعمل على **كل** إدراج (أُقرّ في 0020، يُثبَّت هنا)
--
-- الشرط `when (... ?| array['invite_code','invite_ticket'])` كان يمنع تشغيله
-- حين يغيب المفتاحان، فلا يُضبط المتغيّران في ذلك الإدراج. وset_config محلّي
-- بالمعاملة لا بالعبارة: فمعاملة تُدرج مستخدمَين — الأول بتذكرة والثاني بلا —
-- تجعل الثاني يرث تذكرة الأول. الإزالة تضمن ضبطًا صريحًا (فارغًا) لكل إدراج.
-- ------------------------------------------------------------
drop trigger if exists trg_strip_invite_code_ins on auth.users;
create trigger trg_strip_invite_code_ins
  before insert on auth.users
  for each row
  execute function strip_invite_code();

-- ------------------------------------------------------------
-- لا EXECUTE عام على دالة مُحفّز SECURITY DEFINER
-- ------------------------------------------------------------
revoke all on function handle_new_user() from public;
revoke all on function handle_new_user() from anon;
revoke all on function handle_new_user() from authenticated;
