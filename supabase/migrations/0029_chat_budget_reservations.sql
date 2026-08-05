-- ============================================================
-- 0029 — حجز ميزانية المحادثة ذرّيًا (إضافية بحتة، تُطبَّق قبل النشر)
--
-- ── الثغرة ──
--
-- `check_usage_allowed` تفحص **الرسائل** وحدها: الشهرية واليومية. أمّا
-- `usage_limits.monthly_tokens` فعمودٌ لا يفرضه أحد — مستخدمٌ يرسل 250 رسالة
-- قصيرة ومستخدمٌ يرسل 250 رسالة بسياق ضخم يستهلكان الحدّ نفسه، والكلفة
-- بينهما تختلف مئة ضعف.
--
-- وأخطر من ذلك: الفحص في JavaScript ثم الكتابة في عبارة منفصلة **سباقٌ
-- مفتوح**. عشرون طلبًا متزامنًا يقرأ كلٌّ منها العدّاد نفسه قبل أن يكتب أيٌّ
-- منها، فيمرّ العشرون جميعًا وقد بقي في الحدّ متّسع لواحد. الحدّ الذي يُفحص
-- خارج المعاملة ليس حدًّا.
--
-- ── الحلّ: حجز مسبق ثم تسوية ──
--
-- قبل نداء المزوّد نحجز **أسوأ حالة**: المدخل المقدَّر + سقف الإخراج. الحجز
-- والتحقق في عبارةٍ واحدة داخل معاملة واحدة تحت قفل صفّ المستخدم، فلا نافذة
-- بين القراءة والكتابة مهما بلغ التزامن.
--
-- وبعد انتهاء الرد نسوّي: نسجّل المستهلك الحقيقي ونُلغي فرق الحجز غير
-- المستعمل. فالمستخدم لا يُحاسَب على ما لم يستهلك، والحدّ يبقى دقيقًا أثناء
-- الطلب لا بعده.
--
-- ── لماذا الحجز لا العدّ بعد الاستهلاك ──
--
-- العدّ بعد الاستهلاك يعني أن الكلفة **وقعت** قبل أن نعرف أنها تجاوزت الحدّ.
-- الحجز يمنعها قبل وقوعها — وهذا هو الفرق بين حدٍّ محاسبي وحدٍّ واقٍ.
--
-- ── الحجوزات المتروكة ──
--
-- انهيار العملية بين الحجز والتسوية يترك حجزًا معلّقًا يخصم من الحدّ بلا
-- مقابل. لكل حجز `expires_at`، والحجوزات المنتهية لا تُحتسب في المجموع
-- ولا تحتاج عملية تنظيف كي يعمل النظام — التنظيف للصحة لا للصحّة الوظيفية.
-- ============================================================

create table if not exists public.chat_budget_reservations (
  /** مفتاح المنع المزدوج: نفس الطلب لا يحجز مرتين */
  request_id      text primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  /** ما حُجز مقدَّمًا — أسوأ حالة */
  reserved_tokens int  not null check (reserved_tokens >= 0),
  /** ما استُهلك فعلًا بعد التسوية (null = لم يُسوَّ بعد) */
  actual_tokens   int  check (actual_tokens >= 0),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  settled_at      timestamptz,
  released_at     timestamptz
);

/**
 * فهرس المجموع الشهري — الاستعلام الحارّ الوحيد: كم يحجز هذا المستخدم الآن؟
 * جزئي على غير المسوّى كي يبقى صغيرًا مهما تراكم التاريخ.
 */
create index if not exists chat_budget_res_active_idx
  on public.chat_budget_reservations (user_id, expires_at)
  where settled_at is null and released_at is null;

create index if not exists chat_budget_res_user_created_idx
  on public.chat_budget_reservations (user_id, created_at desc);

alter table public.chat_budget_reservations enable row level security;
alter table public.chat_budget_reservations force row level security;
revoke all on table public.chat_budget_reservations from public;
revoke all on table public.chat_budget_reservations from anon;
revoke all on table public.chat_budget_reservations from authenticated;

comment on table public.chat_budget_reservations is
  'حجوزات ميزانية الرموز — تُحجز قبل نداء المزوّد وتُسوّى بعده. service_role فقط.';

-- ------------------------------------------------------------
-- reserve_chat_budget — الفحص والحجز في معاملة واحدة
-- ------------------------------------------------------------
--
-- يُعيد صفًّا واحدًا: allowed + reason + الأرقام التي بُني عليها القرار.
-- `reason` من مجموعة مغلقة كي لا يتسرّب نصّ قاعدة إلى أي مستدعٍ.

create or replace function public.reserve_chat_budget(
  p_user_id uuid,
  p_request_id text,
  p_estimated_input_tokens int,
  p_max_output_tokens int
) returns table (
  allowed boolean,
  reason text,
  reserved_tokens int,
  used_tokens bigint,
  limit_tokens bigint
)
language plpgsql security definer
set search_path = '' as $$
declare
  v_tier public.plan_tier;
  v_limit_messages int;
  v_limit_daily int;
  v_limit_tokens bigint;
  v_used_month int;
  v_used_today int;
  v_tokens_used bigint;
  v_tokens_held bigint;
  v_reserve int;
  v_existing public.chat_budget_reservations%rowtype;
begin
  if p_user_id is null or p_request_id is null or pg_catalog.length(p_request_id) < 8 then
    return query select false, 'bad_request'::text, 0, 0::bigint, 0::bigint;
    return;
  end if;

  /**
   * (١) الحجز المكرر: نفس request_id يُعاد إليه قراره الأول بلا حجز ثانٍ.
   *
   * إعادة المحاولة بعد انقطاع شبكة ترسل الطلب نفسه مرة أخرى؛ بلا هذا الفحص
   * يُخصم الحدّ مرتين لرسالة واحدة.
   */
  select * into v_existing from public.chat_budget_reservations where request_id = p_request_id;
  if found then
    return query select true, 'already_reserved'::text, v_existing.reserved_tokens, 0::bigint, 0::bigint;
    return;
  end if;

  /**
   * (٢) قفل صفّ المستخدم **قبل أي عدّ**. الطلبات المتزامنة تتسلسل هنا، فالعدد
   * الذي نقرؤه هو العدد الذي نكتب عليه — لا لقطة قديمة.
   *
   * القفل على `subscriptions` لأنه صفٌّ واحد مضمون لكل مستخدم.
   */
  select tier into v_tier from public.subscriptions where user_id = p_user_id for update;
  if v_tier is null then v_tier := 'free'; end if;

  select monthly_messages, daily_messages, monthly_tokens
    into v_limit_messages, v_limit_daily, v_limit_tokens
    from public.usage_limits where tier = v_tier;
  if v_limit_messages is null or v_limit_daily is null or v_limit_tokens is null then
    return query select false, 'no_limits'::text, 0, 0::bigint, 0::bigint;
    return;
  end if;

  -- (٣) حدّ الرسائل الشهري واليومي — نفس دلالة check_usage_allowed
  select pg_catalog.count(*) into v_used_month
    from public.usage_events
    where user_id = p_user_id
      and created_at >= pg_catalog.date_trunc('month', pg_catalog.now());
  if v_used_month >= v_limit_messages then
    return query select false, 'monthly_messages'::text, 0, 0::bigint, v_limit_tokens;
    return;
  end if;

  select pg_catalog.count(*) into v_used_today
    from public.usage_events
    where user_id = p_user_id
      and created_at >= pg_catalog.date_trunc('day', pg_catalog.now());
  if v_used_today >= v_limit_daily then
    return query select false, 'daily_messages'::text, 0, 0::bigint, v_limit_tokens;
    return;
  end if;

  -- (٤) الرموز المستهلكة فعلًا هذا الشهر
  select coalesce(pg_catalog.sum(input_tokens + output_tokens), 0)
    into v_tokens_used
    from public.usage_events
    where user_id = p_user_id
      and created_at >= pg_catalog.date_trunc('month', pg_catalog.now());

  /**
   * (٥) والرموز **المحجوزة الآن**: طلبات جارية لم تُسوَّ بعد.
   *
   * إغفالها هو السباق نفسه بشكل آخر: عشرون طلبًا متزامنًا لا يرى أيٌّ منها
   * حجزَ الآخر فيمرّ الجميع. والمنتهية أجلُها لا تُحتسب — فانهيارٌ لا يحبس
   * ميزانية أحد إلى الأبد.
   */
  /**
   * الاسم المستعار `r` ليس تجميلًا: `reserved_tokens` اسمٌ لعمودٍ **ولمعامل
   * خرج** في توقيع الدالة معًا، فبلا تأهيل يرفض PL/pgSQL الاستعلام
   * بـ«column reference is ambiguous». كشفه أول تشغيل حقيقي.
   */
  select coalesce(pg_catalog.sum(r.reserved_tokens), 0)
    into v_tokens_held
    from public.chat_budget_reservations r
    where r.user_id = p_user_id
      and r.settled_at is null
      and r.released_at is null
      and r.expires_at > pg_catalog.now()
      and r.created_at >= pg_catalog.date_trunc('month', pg_catalog.now());

  v_reserve := greatest(0, coalesce(p_estimated_input_tokens, 0))
             + greatest(0, coalesce(p_max_output_tokens, 0));

  if v_tokens_used + v_tokens_held + v_reserve > v_limit_tokens then
    return query select false, 'monthly_tokens'::text, v_reserve,
                        v_tokens_used + v_tokens_held, v_limit_tokens;
    return;
  end if;

  /**
   * (٦) الحجز. `on conflict do nothing` حارسٌ أخير: لو سبقنا طلبٌ بنفس
   * request_id بين الفحص (١) وهنا، لا يُدرج صفٌّ ثانٍ.
   */
  insert into public.chat_budget_reservations
    (request_id, user_id, reserved_tokens, expires_at)
  values
    (p_request_id, p_user_id, v_reserve,
     pg_catalog.now() + pg_catalog.make_interval(secs => 900))
  on conflict (request_id) do nothing;

  return query select true, 'ok'::text, v_reserve,
                      v_tokens_used + v_tokens_held, v_limit_tokens;
end $$;

revoke all on function public.reserve_chat_budget(uuid, text, int, int) from public;
revoke all on function public.reserve_chat_budget(uuid, text, int, int) from anon;
revoke all on function public.reserve_chat_budget(uuid, text, int, int) from authenticated;
grant execute on function public.reserve_chat_budget(uuid, text, int, int) to service_role;

-- ------------------------------------------------------------
-- finalize_chat_budget — تسجيل الاستهلاك الحقيقي وإلغاء الفائض
-- ------------------------------------------------------------

create or replace function public.finalize_chat_budget(
  p_request_id text,
  p_actual_input_tokens int,
  p_actual_output_tokens int
) returns boolean
language plpgsql security definer
set search_path = '' as $$
declare
  v_actual int;
  v_rows int;
begin
  if p_request_id is null then return false; end if;

  v_actual := greatest(0, coalesce(p_actual_input_tokens, 0))
            + greatest(0, coalesce(p_actual_output_tokens, 0));

  /**
   * التسوية مرة واحدة: الشرط `settled_at is null` داخل نفس العبارة، فنداءان
   * متزامنان لا يسجّلان الاستهلاك مرتين. والفرق بين المحجوز والفعلي يتحرّر
   * ضمنًا — الصفّ المسوّى لا يُحتسب في مجموع الحجوزات أصلًا.
   */
  update public.chat_budget_reservations
    set settled_at = pg_catalog.now(),
        actual_tokens = v_actual
    where request_id = p_request_id
      and settled_at is null
      and released_at is null;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function public.finalize_chat_budget(text, int, int) from public;
revoke all on function public.finalize_chat_budget(text, int, int) from anon;
revoke all on function public.finalize_chat_budget(text, int, int) from authenticated;
grant execute on function public.finalize_chat_budget(text, int, int) to service_role;

-- ------------------------------------------------------------
-- release_chat_budget — إلغاء الحجز كاملًا عند فشل الطلب
-- ------------------------------------------------------------

create or replace function public.release_chat_budget(p_request_id text)
returns boolean
language plpgsql security definer
set search_path = '' as $$
declare v_rows int;
begin
  if p_request_id is null then return false; end if;
  update public.chat_budget_reservations
    set released_at = pg_catalog.now()
    where request_id = p_request_id
      and settled_at is null
      and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function public.release_chat_budget(text) from public;
revoke all on function public.release_chat_budget(text) from anon;
revoke all on function public.release_chat_budget(text) from authenticated;
grant execute on function public.release_chat_budget(text) to service_role;

-- ------------------------------------------------------------
-- purge_chat_budget_reservations — صيانة
-- ------------------------------------------------------------

create or replace function public.purge_chat_budget_reservations(p_days int default 45)
returns int
language plpgsql security definer
set search_path = '' as $$
declare v_n int;
begin
  delete from public.chat_budget_reservations
    where created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_chat_budget_reservations(int) from public;
revoke all on function public.purge_chat_budget_reservations(int) from anon;
revoke all on function public.purge_chat_budget_reservations(int) from authenticated;
grant execute on function public.purge_chat_budget_reservations(int) to service_role;
