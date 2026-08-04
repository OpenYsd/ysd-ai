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
-- قائمة بريد المختبرين، والبحث يبقى ممكنًا لأن الهاش حتمي.
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
-- Google، لا حقلٌ أرسله المستخدم. ولا مزوّد آخر يستفيد: مساواة صريحة بـ'google'.
--
-- ── ثلاثة تشديدات فرضتها المراجعة ──
--
-- (أ) **الدالة ممنوعة عن anon وauthenticated** ومقصورة على `service_role`.
--     كان منحُها لـanon يعني أن أي متصفّح يستطيع استدعاءها مباشرةً متجاوزًا
--     حدود المعدّل في مسار الخادم — فتُستنزف مقاعد الدعوات بحلقة بسيطة.
--     الحدود التي تعيش في التطبيق وحده ليست حدودًا.
--
-- (ب) **قفل استشاري على البريد** قبل قفل الدعوة. القفل على صفّ الدعوة وحده
--     لا يمنع طلبين لنفس البريد على **دعوتين مختلفتين** من التوازي: كلٌّ يقفل
--     صفًّا آخر، فيحجز البريد الواحد مقعدين في دعوتين. ومعه فهرس فريد جزئي
--     يجعل «تصريح نشط واحد لكل بريد» ثابتًا في القاعدة لا عادةً في الشيفرة.
--
-- (ج) **`search_path = ''`** في كل دالة، وأسماء مؤهَّلة بالكامل. مسارٌ يحوي
--     `public` يسمح لمن يملك الإنشاء فيه بزرع دالة تحجب دالةً نظامية،
--     فتُنفَّذ بصلاحيات المالك. `SECURITY DEFINER` بمسار مفتوح ثغرةُ تصعيد.
--
-- ── استثناء واجب: coalesce · nullif · least · greatest ──
--
-- هذه الأربعة **تراكيب في مُحلِّل SQL لا دوال في الفهرس**، فلا تقبل التأهيل:
-- `pg_catalog.least(...)` يفشل بـ«function pg_catalog.least does not exist».
-- كُتبت مؤهَّلةً أولًا فانكسرت الدالة عند أول استدعاء حيّ — كشفها اختبار
-- PostgreSQL الحقيقي (scripts/v08-pg-concurrency.mjs) لا اختبارُ نصّ.
--
-- وتركُها مجرّدةً آمن: المُحلِّل يفهمها قبل أي بحث في المسار، فلا يمكن حجبها
-- بدالة مزروعة — وهو الخطر الذي وُضع `search_path = ''` لأجله أصلًا.
-- ============================================================

-- ---------- ٠) تحقّق من موضع pgcrypto ----------
-- الدوال أدناه تنادي `extensions.digest` باسم مؤهَّل (يفرضه search_path = '').
-- لو كانت pgcrypto في مخطط آخر لفشل أول استدعاء **وقت التشغيل** لا هنا — أي
-- عند أول مستخدم. نفشل الآن برسالة واضحة بدل ذلك.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'digest' and n.nspname = 'extensions'
  ) then
    raise exception
      'pgcrypto غير مثبَّتة في مخطط extensions — 0024 تعتمد على extensions.digest';
  end if;
end $$;

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

/**
 * **تصريح نشط واحد لكل بريد — قيدٌ في القاعدة لا عادةٌ في الشيفرة.**
 *
 * بلا هذا الفهرس يبقى منعُ الازدواج معتمدًا على انضباط الدالة وحدها: أي مسار
 * جديد ينسى الإلغاء قبل الإدراج يخرق القاعدة صامتًا. ومعه تفشل المحاولة
 * بـunique_violation فتُرَدّ ردًّا عامًّا.
 *
 * ولا يقيّده `invite_id`: المقصود ألّا يحجز البريد الواحد مقعدين في **دعوتين**
 * مختلفتين — وهو بالضبط السباق الذي لا يمنعه قفل صفّ الدعوة.
 *
 * والمنتهي غير المستهلَك يظل مطابقًا للشرط، فيجب إلغاؤه قبل الإدراج لا انتظار
 * انقضائه.
 */
create unique index if not exists google_signup_auth_one_active_idx
  on public.google_signup_authorizations (email_hash)
  where consumed_at is null and revoked_at is null;

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
set search_path = '' as $$
  select case
    when p_email is null or pg_catalog.btrim(p_email) = '' then null
    else pg_catalog.encode(
           extensions.digest(pg_catalog.lower(pg_catalog.btrim(p_email)), 'sha256'),
           'hex')
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
--
-- **ولا تُمنح لأحد غير service_role**: انظر المنح أسفل الدالة.

create or replace function public.google_signup_authorize(
  p_code text, p_email text, p_ttl_seconds int default 600
) returns boolean
language plpgsql security definer
set search_path = '' as $$
declare
  v_invite_id uuid;
  v_email_hash text;
  v_max_uses int;
  v_used_count int;
  v_reserved int;
  v_recent int;
  c_max_hourly constant int := 20;  -- تصاريح مُصدَرة لكل دعوة خلال ساعة
begin
  if p_code is null or pg_catalog.length(p_code) < 8 then return false; end if;

  v_email_hash := public.normalized_email_hash(p_email);
  if v_email_hash is null then return false; end if;

  -- فحص صيغة بسيط: وجود @ ونقطة بعده. الغرض منع الإدخال العابث لا التحقق من
  -- التسليم — Google هي من تتحقق فعلًا.
  if pg_catalog.lower(pg_catalog.btrim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return false;
  end if;

  /**
   * (١) **قفل استشاري على البريد — قبل كل شيء.**
   *
   * ترتيب الأقفال الثابت في هذا الملف: **البريد ثم صفّ الدعوة**، هنا وفي
   * المُحفِّز على السواء. الثبات هو ما يمنع الجمود (deadlock): لو أخذ أحدهما
   * الدعوة أولًا والآخر البريد أولًا لانتظر كلٌّ منهما الآخر.
   *
   * ولماذا لا يكفي قفل الدعوة: طلبان لنفس البريد على **دعوتين مختلفتين**
   * يقفل كلٌّ منهما صفًّا مختلفًا فيتوازيان، فيحجز البريد الواحد مقعدين.
   * القفل على البريد هو الشيء الوحيد المشترك بينهما.
   *
   * و`xact` يعني أنه يُحرَّر بنهاية المعاملة تلقائيًا — لا تسريب قفل عند خطأ.
   */
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_email_hash, 0));

  -- (٢) اقفل صفّ الدعوة. الطلبات المتزامنة على نفس الدعوة تتسلسل هنا، فلا
  -- يمكن لطلبين أن يقرآ العدد نفسه ثم يحجزا المقعد الأخير معًا.
  select id, max_uses, used_count
    into v_invite_id, v_max_uses, v_used_count
    from public.beta_invites
    where code_hash = pg_catalog.encode(
            extensions.digest(pg_catalog.btrim(p_code), 'sha256'), 'hex')
      and revoked_at is null
      and (expires_at is null or expires_at > pg_catalog.now())
      and used_count < max_uses
    for update;
  if v_invite_id is null then return false; end if;

  -- (٣) نظّف تصاريح هذه الدعوة الأقدم من ساعة (منتهية أو مستهلَكة أو ملغاة).
  -- لا نحذف داخل النافذة كي لا يُصفَّر الحدّ الزمني في (٦).
  delete from public.google_signup_authorizations
    where invite_id = v_invite_id
      and created_at <= pg_catalog.now() - interval '1 hour'
      and (expires_at <= pg_catalog.now()
           or consumed_at is not null
           or revoked_at is not null);

  /**
   * (٤) ألغِ **كل** تصاريح هذا البريد النشطة — على أي دعوة، ومنتهيةً كانت أو
   * سارية.
   *
   * «على أي دعوة» لا على هذه وحدها: الفهرس الفريد لا يقيّد بالدعوة، ومن أدخل
   * كود دعوة أخرى بنفس البريد يجب أن يُحوَّل حجزُه لا أن يُضاف إليه. وبذلك
   * يتحرّر مقعد الدعوة الأولى تلقائيًا.
   *
   * و«منتهية»: المنتهي غير المستهلَك يظل مطابقًا لشرط الفهرس، فلا يكفي انتظار
   * انقضائه — يجب إلغاؤه صراحةً وإلا منع الإدراج.
   */
  update public.google_signup_authorizations
    set revoked_at = pg_catalog.now()
    where email_hash = v_email_hash
      and consumed_at is null
      and revoked_at is null;

  /**
   * (٥) حدّ المقاعد: المستهلَك + المحجوز لا يتجاوز max_uses.
   * العدّ **بعد** الإلغاء أعلاه وداخل القفلين — فالعدد الذي نقرؤه هو العدد
   * الذي سنكتب عليه، لا لقطة قديمة.
   */
  select pg_catalog.count(*) into v_reserved
    from public.google_signup_authorizations
    where invite_id = v_invite_id
      and consumed_at is null
      and revoked_at is null
      and expires_at > pg_catalog.now();
  if v_used_count + v_reserved >= v_max_uses then return false; end if;

  -- (٦) حدّ الإصدار الزمني — يمنع استنزاف الدعوة بطلبات متتابعة
  select pg_catalog.count(*) into v_recent
    from public.google_signup_authorizations
    where invite_id = v_invite_id
      and created_at > pg_catalog.now() - interval '1 hour';
  if v_recent >= c_max_hourly then return false; end if;

  /**
   * (٧) الإدراج. الفهرس الفريد حارسٌ أخير: القفل الاستشاري يمنع السباق، لكن
   * مسارًا جديدًا قد يغفل عنه يومًا. نردّ ردًّا عامًّا كسائر أسباب الرفض —
   * أي تمييز يمنح مِسبارًا يكشف أن لهذا البريد تصريحًا قائمًا.
   */
  begin
    insert into public.google_signup_authorizations (email_hash, invite_id, expires_at)
      values (v_email_hash, v_invite_id,
              pg_catalog.now() + pg_catalog.make_interval(
                secs => greatest(60, least(p_ttl_seconds, 1800))));
  exception when unique_violation then
    return false;
  end;

  return true;
end $$;

/**
 * **الدالة لا تُمنح لأحد سوى service_role.**
 *
 * منحُها لـanon كان يعني أن أي متصفّح يستدعيها مباشرةً عبر REST متجاوزًا
 * `/api/auth/google-invite` — ومعه كل حدود المعدّل على الـIP والبريد والكود.
 * حلقةٌ من عشرة أسطر كانت تكفي لاستنزاف مقاعد كل دعوة قائمة.
 *
 * والحدّ الذي يعيش في التطبيق وحده ليس حدًّا: الطريق إلى القاعدة لا يمرّ
 * بالتطبيق إلا بقدر ما نجبره على ذلك.
 */
revoke all on function public.google_signup_authorize(text, text, int) from public;
revoke all on function public.google_signup_authorize(text, text, int) from anon;
revoke all on function public.google_signup_authorize(text, text, int) from authenticated;
grant execute on function public.google_signup_authorize(text, text, int) to service_role;

-- ---------- ٥) تنظيف دوري ----------
create or replace function public.purge_google_signup_authorizations(p_hours int default 24)
returns int
language plpgsql security definer
set search_path = '' as $$
declare v_n int;
begin
  if auth.uid() is not null and not public.is_admin() then return 0; end if;
  delete from public.google_signup_authorizations
    where created_at < pg_catalog.now() - pg_catalog.make_interval(hours => p_hours)
      and (expires_at < pg_catalog.now()
           or consumed_at is not null
           or revoked_at is not null);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_google_signup_authorizations(int) from public;
revoke all on function public.purge_google_signup_authorizations(int) from anon;
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
language plpgsql security definer
set search_path = '' as $$
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
    nullif(pg_catalog.current_setting('ysd.invite_ticket', true), ''),
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
       * القفل الاستشاري على البريد أولًا — **نفس ترتيب `google_signup_authorize`**.
       * بدونه يمكن أن يمسك هذا المُحفِّز صفَّ تصريح ثم ينتظر صفَّ الدعوة،
       * بينما تمسك دالةُ الإصدار صفَّ الدعوة وتنتظر صفَّ التصريح ذاته —
       * جمودٌ تامّ. الترتيب الموحّد يقطع الدورة قبل أن تنشأ.
       */
      v_email_hash := public.normalized_email_hash(new.email);
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_email_hash, 0));

      /**
       * الاستهلاك بجملة واحدة: الشرط والكتابة في نفس العبارة، فلا نافذة بين
       * القراءة والكتابة. و`skip locked` يمنع طلبين متزامنين من الانتظار ثم
       * استهلاك الصف نفسه بالتتابع — الثاني يتخطّاه فلا يجد شيئًا فيُرفض.
       */
      update public.google_signup_authorizations
        set consumed_at = pg_catalog.now()
        where id = (
          select id from public.google_signup_authorizations
            where email_hash = v_email_hash
              and consumed_at is null
              and revoked_at is null
              and expires_at > pg_catalog.now()
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
  if not coalesce(v_require, true)
     and not coalesce(v_allow_registration, false) then
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
        and (expires_at is null or expires_at > pg_catalog.now())
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
        set used_at = pg_catalog.now()
        where ticket_hash = pg_catalog.encode(
                extensions.digest(v_ticket, 'sha256'), 'hex')
          and used_at is null
          and expires_at > pg_catalog.now()
        returning invite_id into v_ticket_invite;
    end if;

    if v_ticket_invite is not null then
      update public.beta_invites
        set used_count = used_count + 1
        where id = v_ticket_invite
          and revoked_at is null
          and (expires_at is null or expires_at > pg_catalog.now())
          and used_count < max_uses
        returning id into v_invite_id;
    end if;
  end if;

  -- بوابة الدعوة — يتخطّاها تسجيل Google المستوفي للشروط وحده
  if coalesce(v_require, true)
     and v_invite_id is null
     and not v_google_signup then
    raise exception 'invite_required_or_invalid';
  end if;

  -- بوابة الموافقة — تُؤجَّل لمسار Google إلى صفحة /accept-terms
  v_accepted := coalesce(
    (new.raw_user_meta_data->>'terms_accepted')::boolean, false);
  if not v_accepted and not v_google_signup then
    raise exception 'consent_required';
  end if;

  select value #>> '{}' into v_terms_version
    from public.platform_settings where key = 'terms_version';

  insert into public.profiles (id, display_name)
    values (new.id, coalesce(
      new.raw_user_meta_data->>'display_name',
      new.raw_user_meta_data->>'full_name',
      pg_catalog.split_part(new.email, '@', 1)));
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

  perform pg_catalog.set_config('ysd.invite_code', '', true);
  perform pg_catalog.set_config('ysd.invite_ticket', '', true);
  return new;
end $$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;
