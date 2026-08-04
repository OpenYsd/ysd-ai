-- ============================================================
-- 0024 — تسجيل Google بالدعوة، والتسجيل العام يبقى مغلقًا
--
-- ── الغاية ──
--
-- تمكين المختبرين من إنشاء حساب عبر Google **بدعوة**، مع بقاء
-- `allow_registration = false` و`require_invite = true` طوال الوقت. أي أن
-- بوابة الدعوة لا تُفتح ولو لحظة — بل يُضاف إليها بابٌ ثانٍ يُفتح بمفتاح.
--
-- ── لماذا لا يكفي كود الدعوة وحده في مسار Google ──
--
-- في تسجيل البريد وكلمة المرور يصل الكود إلينا مع الطلب، فنستبدله بتذكرة
-- ونستهلكها في المُحفِّز. أمّا في OAuth فالمستخدم يغادر إلى Google ويعود عبر
-- GoTrue، ولا سبيل لتمرير شيء موثوق معه: `raw_user_meta_data` يكتبه العميل،
-- وما نضعه في `redirectTo` يظهر في شريط العنوان ويصل سجلّات المزوّد.
--
-- الحل: **تصريح خادمي مسبق** مربوط ببريد Google المتوقَّع. يُنشأ قبل مغادرة
-- المستخدم، ويُستهلك عند عودته حين يطابق البريد الذي أكّدته Google. فالرابط
-- الوحيد بين الطرفين هو البريد نفسه — تكتبه الخدمة لا العميل.
--
-- ── لماذا hash للبريد لا البريد الخام ──
--
-- الجدول يحفظ `sha256(lower(btrim(email)))` لا البريد. فتسريب الجدول لا يكشف
-- قائمة بريد المختبرين، والبحث يبقى ممكنًا لأن الهاش حتمي. والتطبيع قبل الهاش
-- ضروري: `  Foo@Gmail.com ` و`foo@gmail.com` بريدٌ واحد عند Google، ولو اختلف
-- الهاش لرُفض المستخدم بلا سبب مفهوم.
--
-- ولا نضيف ملحًا (salt): المُحفِّز يجب أن يحسب الهاش نفسه من `new.email`، فلو
-- كان الملح سرًّا لوجب تخزينه حيث يصله المُحفِّز — أي في القاعدة نفسها مع
-- الجدول. حمايةٌ من التسريب نفسه لا تحمي منه. الهاش هنا يمنع القراءة العابرة،
-- لا خصمًا يملك القاعدة كاملة.
--
-- ── حدود الثقة ──
--
-- `raw_app_meta_data.provider` يكتبه GoTrue بعد نجاح OAuth ولا يصله العميل —
-- وهو محور الأمان كما في 0022/0023. و`new.email` في مسار OAuth بريدٌ أكّدته
-- Google، لا حقلٌ أرسله المستخدم.
--
-- ولا مزوّد آخر يستفيد: الشرط مساواة صريحة بـ'google'.
-- ============================================================

-- ---------- ١) جدول التصاريح ----------

create table if not exists public.google_signup_authorizations (
  id          uuid primary key default gen_random_uuid(),
  -- sha256 للبريد بعد التطبيع — لا البريد الخام
  email_hash  text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  invite_id   uuid not null references public.beta_invites(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  revoked_at  timestamptz
);

-- البحث في المُحفِّز: بالبريد وحده، على الصالح غير المستهلَك فقط
create index if not exists google_signup_auth_lookup_idx
  on public.google_signup_authorizations (email_hash, expires_at desc)
  where consumed_at is null and revoked_at is null;

-- عدّ المقاعد المحجوزة لكل دعوة
create index if not exists google_signup_auth_invite_idx
  on public.google_signup_authorizations (invite_id);

comment on table public.google_signup_authorizations is
  'تصاريح تسجيل Google المسبقة — مربوطة ببريد مُطبَّع (hash) ودعوة، أحادية الاستخدام وقصيرة الأجل.';

-- ---------- ٢) RLS: لا وصول مباشر لأحد ----------
-- **بلا سياسات إطلاقًا**: تفعيل RLS دون سياسة يمنع anon وauthenticated من كل
-- قراءة وكتابة. الوصول الوحيد عبر دوال SECURITY DEFINER أدناه، فلا يستطيع
-- أحد سرد التصاريح ولا تخمين وجود بريد بعينه ولا إطالة أجل تصريح.

alter table public.google_signup_authorizations enable row level security;
alter table public.google_signup_authorizations force row level security;

revoke all on table public.google_signup_authorizations from public;
revoke all on table public.google_signup_authorizations from anon;
revoke all on table public.google_signup_authorizations from authenticated;

-- ---------- ٣) تطبيع البريد وهاشه — مصدر واحد ----------
-- دالة واحدة يستدعيها منشئ التصريح والمُحفِّز معًا. لو تفرّق الحسابان لأمكن أن
-- يتغيّر التطبيع في أحدهما فيصير كل تصريح غير قابل للاستهلاك — عطلٌ صامت
-- يظهر عند أول مستخدم لا في أي اختبار وحدة.

create or replace function public.normalized_email_hash(p_email text)
returns text
language sql immutable
set search_path = public, extensions, pg_temp as $$
  select case
    when p_email is null or btrim(p_email) = '' then null
    else encode(digest(lower(btrim(p_email)), 'sha256'), 'hex')
  end;
$$;

revoke all on function public.normalized_email_hash(text) from public;
revoke all on function public.normalized_email_hash(text) from anon;
revoke all on function public.normalized_email_hash(text) from authenticated;

-- ---------- ٤) إنشاء التصريح ----------
--
-- يعيد boolean لا تفصيلًا: أي تمييز بين «كود خاطئ» و«لا مقاعد» و«بريد محجوز»
-- يمنح المهاجم مِسبارًا يعدّ به الدعوات ويستكشف حالتها.
--
-- **لا تُستهلك الدعوة هنا**: `used_count` لا يتغيّر. التصريح حجزُ مقعد لا
-- استهلاكه؛ الاستهلاك يقع في المُحفِّز عند نجاح Google وحده.

create or replace function public.google_signup_authorize(
  p_code text, p_email text, p_ttl_seconds int default 600
) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_invite_id uuid;
  v_email_hash text;
  v_max_uses int;
  v_used_count int;
  v_reserved int;
  v_recent int;
  c_max_hourly constant int := 20;  -- تصاريح مُصدَرة لكل دعوة خلال ساعة
begin
  if p_code is null or length(p_code) < 8 then return false; end if;

  v_email_hash := public.normalized_email_hash(p_email);
  if v_email_hash is null then return false; end if;

  -- فحص صيغة بسيط: وجود @ ونقطة بعده. الغرض منع الإدخال العابث لا التحقق من
  -- التسليم — Google هي من تتحقق فعلًا.
  if lower(btrim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return false; end if;

  /**
   * (١) اقفل صف الدعوة **قبل أي عدّ**. الطلبات المتزامنة تتسلسل على هذا القفل،
   * فلا يمكن لطلبين أن يقرآ العدد نفسه ثم يحجزا المقعد الأخير معًا. هذا هو
   * نفس النمط الذي أثبته beta_claim_invite في 0013.
   */
  select id, max_uses, used_count
    into v_invite_id, v_max_uses, v_used_count
    from public.beta_invites
    where code_hash = encode(digest(btrim(p_code), 'sha256'), 'hex')
      and revoked_at is null
      and (expires_at is null or expires_at > now())
      and used_count < max_uses
    for update;
  if v_invite_id is null then return false; end if;

  -- (٢) نظّف تصاريح هذه الدعوة الأقدم من ساعة (منتهية أو مستهلَكة أو ملغاة).
  -- لا نحذف داخل النافذة كي لا يُصفَّر الحدّ الزمني في (٥).
  delete from public.google_signup_authorizations
    where invite_id = v_invite_id
      and created_at <= now() - interval '1 hour'
      and (expires_at <= now() or consumed_at is not null or revoked_at is not null);

  /**
   * (٣) ألغِ تصاريح هذا البريد النشطة على هذه الدعوة قبل إصدار الجديد.
   *
   * بدونها يحجز المستخدمُ الواحدُ مقعدًا جديدًا كلما أعاد المحاولة — فتنفد
   * مقاعد الدعوة بمستخدم واحد متردّد. وبها تبقى إعادة المحاولة مجانية،
   * ويُبطَل التصريح القديم فلا يصلح لاستهلاك ثانٍ.
   */
  update public.google_signup_authorizations
    set revoked_at = now()
    where invite_id = v_invite_id
      and email_hash = v_email_hash
      and consumed_at is null
      and revoked_at is null;

  /**
   * (٤) حدّ المقاعد: المستهلَك + المحجوز لا يتجاوز max_uses.
   *
   * عدّ التصاريح النشطة **بعد** الإلغاء أعلاه، وداخل قفل الدعوة — فالعدد
   * الذي نقرؤه هو العدد الذي سنكتب عليه، لا لقطة قديمة.
   */
  select count(*) into v_reserved
    from public.google_signup_authorizations
    where invite_id = v_invite_id
      and consumed_at is null
      and revoked_at is null
      and expires_at > now();
  if v_used_count + v_reserved >= v_max_uses then return false; end if;

  -- (٥) حدّ الإصدار الزمني — يمنع استنزاف الدعوة بطلبات متتابعة
  select count(*) into v_recent
    from public.google_signup_authorizations
    where invite_id = v_invite_id and created_at > now() - interval '1 hour';
  if v_recent >= c_max_hourly then return false; end if;

  insert into public.google_signup_authorizations (email_hash, invite_id, expires_at)
    values (v_email_hash, v_invite_id,
            now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 1800))));
  return true;
end $$;

revoke all on function public.google_signup_authorize(text, text, int) from public;
grant execute on function public.google_signup_authorize(text, text, int) to anon, authenticated;

-- ---------- ٥) تنظيف دوري ----------
create or replace function public.purge_google_signup_authorizations(p_hours int default 24)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if auth.uid() is not null and not is_admin() then return 0; end if;
  delete from public.google_signup_authorizations
    where created_at < now() - make_interval(hours => p_hours)
      and (expires_at < now() or consumed_at is not null or revoked_at is not null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_google_signup_authorizations(int) from public, anon;
grant execute on function public.purge_google_signup_authorizations(int) to authenticated;

-- ---------- ٦) بوابة إنشاء المستخدم ----------
--
-- تُستبدل الدالة كاملةً (0022 و0023 مطبَّقتان ولا تُعدَّلان).
--
-- ما يتغيّر عن 0023: مسار Google حين يكون التسجيل العام **مغلقًا** لم يعد
-- مرفوضًا بالضرورة — يبحث عن تصريح صالح لبريده، فإن وجده استهلكه واستهلك
-- الدعوة المرتبطة به. وإن لم يجد، يُرفض كما كان تمامًا.
--
-- وما لا يتغيّر: مصدر المزوّد، وترتيب الفحوص، ومسار البريد وكلمة المرور،
-- وتأجيل الموافقة لمستخدم Google، والدور على default 'user'.

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
  v_email_hash text;
  v_auth_invite uuid;
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

  if v_provider = 'google' and new.email is not null then
    if coalesce(v_allow_registration, false) then
      -- التسجيل العام مفتوح: تجاوز بلا دعوة (سلوك 0023، خامل ما دام مغلقًا)
      v_google_signup := true;
    else
      /**
       * التسجيل مغلق: يلزم تصريح مسبق لهذا البريد بالذات.
       *
       * الاستهلاك بجملة واحدة `update … where id = (select … for update
       * skip locked)`: الشرط والكتابة في نفس العبارة، فلا نافذة بين القراءة
       * والكتابة. و`skip locked` يمنع طلبين متزامنين لنفس البريد من الانتظار
       * ثم استهلاك الصف نفسه بالتتابع — الثاني يتخطّاه فلا يجد شيئًا فيُرفض.
       */
      v_email_hash := public.normalized_email_hash(new.email);
      update public.google_signup_authorizations
        set consumed_at = now()
        where id = (
          select id from public.google_signup_authorizations
            where email_hash = v_email_hash
              and consumed_at is null
              and revoked_at is null
              and expires_at > now()
            order by created_at desc
            limit 1
            for update skip locked
        )
        returning invite_id into v_auth_invite;

      if v_auth_invite is not null then
        v_google_signup := true;
      end if;
    end if;
  end if;

  -- ===== التسجيل المغلق: يُفحص قبل أي استهلاك =====
  if not coalesce(v_require, true) and not coalesce(v_allow_registration, false) then
    raise exception 'registration_closed';
  end if;

  -- ===== استهلاك الدعوة =====
  if v_auth_invite is not null then
    /**
     * مسار Google بالتصريح: الدعوة معروفة من التصريح نفسه لا من تذكرة.
     * الشروط كلها داخل WHERE، فطلبان متزامنان لا يتجاوزان max_uses أبدًا.
     */
    update public.beta_invites
      set used_count = used_count + 1
      where id = v_auth_invite
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and used_count < max_uses
      returning id into v_invite_id;

    /**
     * التصريح صالح لكن الدعوة نفدت أو أُلغيت بين الحجز والعودة. نرفع استثناءً
     * فتتراجع المعاملة كاملةً — بما فيها `consumed_at` أعلاه. فلا يُحرق تصريح
     * على محاولة فاشلة، ولا يُنشأ حساب بلا مقعد.
     */
    if v_invite_id is null then
      raise exception 'invite_required_or_invalid';
    end if;

  elsif coalesce(v_require, true) and not v_google_signup then
    -- مسار البريد وكلمة المرور — كما هو تمامًا
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
