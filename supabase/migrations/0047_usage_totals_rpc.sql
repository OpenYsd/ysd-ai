-- ============================================================
-- 0047 — تجميعٌ دقيقٌ لاستهلاك الرموز في القاعدة
--
-- ── العطل الذي يُغلق ──
--
-- المجموع كان يُحسب في التطبيق بجلب الصفوف صفحةً صفحة، ومسحُه محدودٌ بثلاثين
-- ألف حدث. وما تجاوزها كان يُعلَن مقصوصًا («+») — وهو صدقٌ، لكنه ليس رقمًا.
-- وصاحبُ باقة `business` (١٠٠٬٠٠٠ شهريًّا) لا يرى مجموعه أبدًا.
--
-- والقاعدة تجمع مليون صفٍّ في رحلةٍ واحدة. فيُنقل الجمعُ إلى موضعه.
--
-- ── ولماذا SECURITY INVOKER — لا DEFINER ──
--
-- هذا أهمُّ سطرٍ في الملفّ.
--
-- دالّةُ `security definer` تعمل بصلاحيات مالكها، فتتخطّى RLS. ولو أخذت
-- `p_user_id` من المتصفّح لصارت بابًا: يمرّر المهاجم معرّف ضحيةٍ فيقرأ
-- استهلاكها. وحمايتُها تحتاج فحص تفويضٍ **داخلها** — أي نسخةً ثانية من
-- منطقٍ موجودٍ سلفًا في RLS، تفترق عنه يوم يُعدَّل أحدهما.
--
-- و`security invoker` (الافتراض) يجعل RLS يعمل كما يعمل على أي استعلام.
-- فالتفويض ليس شيئًا نكتبه هنا، بل السياسات المدقَّقة القائمة:
--
--   `usage_select_own`  — يرى المرء صفوفه
--   `usage_admin_read`  — و`is_admin()` يرى الجميع
--
-- ونتيجتُها أن `usage_totals_for('ضحية')` من جلسةِ مستخدمٍ عاديّ ترجع
-- **أصفارًا**: لا لأننا فحصنا، بل لأن RLS لم يُظهر له صفًّا يُجمَع. وهذا
-- أمتنُ من فحصٍ نكتبه — لأنه لا يُنسى.
--
-- ── ودالّتان لا واحدة ──
--
-- `usage_totals_self` لا تأخذ معرّف مستخدمٍ أصلًا. فالمتصفّح لا يملك أن
-- يُسمّي غيره ولو أراد — والأمانُ الذي لا يعتمد على صحّة وسيطٍ أمانٌ أقلّ
-- عرضةً للخطأ.
--
-- ── وما لا يمسّه هذا الترحيل ──
--
-- لا صفَّ في `usage_events` يُقرأ للكتابة ولا يُعدَّل. ولا حدودَ باقةٍ
-- تتغيّر. ولا فهرسَ يُضاف: `idx_usage_user_period (user_id, created_at)`
-- من 0001 هو بالضبط ما يحتاجه هذان الاستعلامان.
-- ============================================================

-- ---------- النوع المُعاد ----------
-- `bigint` لا `int`: مجموعُ رموزٍ عبر مئة ألف حدث يتجاوز حدّ `int` بسهولة،
-- و`sum(int)` في PostgreSQL يُرجع `bigint` أصلًا. فالتصريح يطابق الواقع.

-- ---------- (١) مسار المستخدم — بلا وسيط هوية ----------
create or replace function public.usage_totals_self(
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  event_count   bigint,
  input_tokens  bigint,
  output_tokens bigint,
  total_tokens  bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    count(*)::bigint,
    coalesce(sum(e.input_tokens), 0)::bigint,
    coalesce(sum(e.output_tokens), 0)::bigint,
    coalesce(sum(e.input_tokens + e.output_tokens), 0)::bigint
  from public.usage_events e
  where e.user_id = auth.uid()
    -- الحدّ الأدنى شامل والأعلى حصريّ: شهرٌ يبدأ حيث ينتهي سابقه بلا تداخل
    and (p_since is null or e.created_at >= p_since)
    and (p_until is null or e.created_at <  p_until);
$$;

-- ---------- (٢) مسار الإدارة والخادم ----------
-- `p_user_id` فارغًا يعني «الجميع» — وما يُرى منهم يحسمه RLS لا هذا السطر.
create or replace function public.usage_totals_for(
  p_user_id uuid default null,
  p_since   timestamptz default null,
  p_until   timestamptz default null
)
returns table (
  event_count   bigint,
  input_tokens  bigint,
  output_tokens bigint,
  total_tokens  bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    count(*)::bigint,
    coalesce(sum(e.input_tokens), 0)::bigint,
    coalesce(sum(e.output_tokens), 0)::bigint,
    coalesce(sum(e.input_tokens + e.output_tokens), 0)::bigint
  from public.usage_events e
  where (p_user_id is null or e.user_id = p_user_id)
    and (p_since is null or e.created_at >= p_since)
    and (p_until is null or e.created_at <  p_until);
$$;

-- ---------- الصلاحيات ----------
-- ★ النزعُ من `public` وحده لا يكفي — وهذا ما كشفه تحقّقُ هذا الملفّ نفسه.
--
-- منصّةُ Supabase تُصدر `alter default privileges … grant execute on functions
-- to anon, authenticated, service_role`. فالمنحُ لـ`anon` **صريحٌ باسمه** لا
-- موروثٌ من `public`، ونزعُ الأخير يتركه قائمًا.
--
-- فتُنزع من الاثنين معًا: الدور المجهول يُسمّى كما مُنح.
revoke all on function public.usage_totals_self(timestamptz, timestamptz) from public, anon;
revoke all on function public.usage_totals_for(uuid, timestamptz, timestamptz) from public, anon;

-- المجهول لا يملك `auth.uid()` ولا صفوفًا يراها. والمنعُ صريحٌ لا ضمنيّ.
grant execute on function public.usage_totals_self(timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function public.usage_totals_for(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

comment on function public.usage_totals_self(timestamptz, timestamptz) is
  'مجاميع استهلاك صاحب الجلسة. security invoker — التفويض من RLS لا من فحصٍ هنا.';
comment on function public.usage_totals_for(uuid, timestamptz, timestamptz) is
  'مجاميع استهلاك لمستخدمٍ أو للجميع. security invoker — غيرُ الإداريّ يرى أصفارًا بحكم RLS.';

-- ---------- تحقّق ----------
do $$
declare
  v_self_definer boolean;
  v_for_definer  boolean;
  v_anon_self    boolean;
begin
  select p.prosecdef into v_self_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'usage_totals_self';
  select p.prosecdef into v_for_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'usage_totals_for';

  if v_self_definer is null or v_for_definer is null then
    raise exception '0047: usage total functions were not created';
  end if;

  -- ★ لو صارت `definer` يومًا لتخطّت RLS وصار `p_user_id` بابًا مفتوحًا
  if v_self_definer or v_for_definer then
    raise exception '0047: usage total functions must be SECURITY INVOKER';
  end if;

  select has_function_privilege('anon', 'public.usage_totals_self(timestamptz, timestamptz)', 'execute')
    into v_anon_self;
  if v_anon_self then
    raise exception '0047: anon must not execute usage_totals_self';
  end if;
end $$;
