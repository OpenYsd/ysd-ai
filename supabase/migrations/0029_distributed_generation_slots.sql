-- ============================================================
-- 0030 — مقعد التوليد الموزّع (إضافية بحتة، تُطبَّق قبل النشر)
--
-- ── لماذا لا تكفي ذاكرة العملية ──
--
-- الحارس الأول كان `Set` في ذاكرة Node. وذلك يحرس نسخةً واحدة: مع نسختين
-- يصير الحدّ «واحدًا لكل نسخة» أي اثنين، ومع إعادة تشغيل يُصفَّر. وأسوأ من
-- ذلك أنه **يبدو** شغّالًا في كل اختبار محلي، فيُعتمد عليه ثم يسقط صامتًا
-- أول يوم يُرفع فيه عدد النسخ — بلا خطأ ولا تنبيه.
--
-- الحماية الأساسية تنتقل إلى القاعدة: مصدرٌ واحد يشترك فيه كل الاتصالات وكل
-- النسخ. وتبقى ذاكرة العملية **تحسينًا** يوفّر رحلة شبكة في الحالة الشائعة،
-- لا مصدرًا للقرار.
--
-- ── لماذا `insert` لا `select ثم insert` ──
--
-- الذرّية هنا من **القيد الفريد** نفسه: مقعدٌ واحد نشط لكل مستخدم مفروضٌ
-- بفهرس فريد جزئي، فطلبان متزامنان يحاولان الإدراج فينجح واحد ويرتطم الآخر
-- بالقيد. لا نافذة بين فحصٍ وكتابة لأنه لا يوجد فحص منفصل أصلًا.
--
-- ── TTL ──
--
-- انهيار العملية بين الحجز والتحرير كان سيحبس المستخدم إلى الأبد. لكل مقعد
-- `expires_at`، والمنتهي **لا يُحتسب** — فالمستخدم يعود بعد المهلة تلقائيًا
-- بلا تدخّل ولا عملية تنظيف.
--
-- ── لا يحرّر طلبٌ مقعدَ طلبٍ آخر ──
--
-- التحرير مشروط بـ`request_id` معًا مع `user_id`. بدونه كان طلبٌ متأخر
-- يحرّر مقعد طلبٍ لاحق لنفس المستخدم فيسمح باثنين معًا.
-- ============================================================

create table if not exists public.generation_slots (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  request_id text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  primary key (user_id, request_id)
);

/**
 * **مقعد نشط واحد لكل مستخدم — قيدٌ في القاعدة لا عادةٌ في الشيفرة.**
 *
 * الفهرس الفريد الجزئي هو مصدر الذرّية كلها: أي محاولة ثانية ترتطم به.
 * ولا يشمل المنتهي أجلُه لأن الشرط يقارن `expires_at`… لكن الفهارس الجزئية
 * لا تقبل `now()` (غير ثابتة). فالقيد يشمل كل غير المحرَّر، والانتهاء
 * يُعالَج في الدالة بحذف المنتهي قبل الإدراج.
 */
create unique index if not exists generation_slots_one_active_idx
  on public.generation_slots (user_id)
  where released_at is null;

create index if not exists generation_slots_expiry_idx
  on public.generation_slots (expires_at)
  where released_at is null;

alter table public.generation_slots enable row level security;
alter table public.generation_slots force row level security;
revoke all on table public.generation_slots from public;
revoke all on table public.generation_slots from anon;
revoke all on table public.generation_slots from authenticated;

comment on table public.generation_slots is
  'مقاعد التوليد النشطة — مقعد واحد لكل مستخدم مجاني، بمهلة انتهاء. service_role فقط.';

-- ------------------------------------------------------------
-- acquire_generation_slot
-- ------------------------------------------------------------

create or replace function public.acquire_generation_slot(
  p_user_id uuid,
  p_request_id text,
  p_ttl_seconds int default 180
) returns boolean
language plpgsql security definer
set search_path = '' as $$
declare v_rows int;
begin
  if p_user_id is null or p_request_id is null or pg_catalog.length(p_request_id) < 8 then
    return false;
  end if;

  /**
   * (١) أفرج عن المقاعد المنتهية لهذا المستخدم.
   *
   * الفهرس الفريد لا يميّز المنتهي (لا يقبل `now()`)، فالتحرير هنا شرطُ أن
   * ينجح الإدراج بعد انهيار سابق. وهو مقصور على هذا المستخدم فلا يمسّ غيره.
   */
  update public.generation_slots
    set released_at = pg_catalog.now()
    where user_id = p_user_id
      and released_at is null
      and expires_at <= pg_catalog.now();

  /**
   * (٢) الإدراج هو الحجز. الفهرس الفريد يجعل الثاني يفشل بلا استثناء يخرج
   * إلى المستدعي — `on conflict do nothing` يحوّل الارتطام إلى «صفر صفوف».
   *
   * وإعادة المحاولة بنفس request_id تُعامَل نجاحًا: المفتاح الأساسي
   * (user_id, request_id) يمنع التكرار، والطلب نفسه لا يُحجب عن مقعده.
   */
  insert into public.generation_slots (user_id, request_id, expires_at)
  values (p_user_id, p_request_id,
          pg_catalog.now() + pg_catalog.make_interval(
            secs => greatest(10, least(p_ttl_seconds, 900))))
  on conflict do nothing;

  get diagnostics v_rows = row_count;
  if v_rows > 0 then return true; end if;

  -- ارتطام: إمّا مقعد نشط لطلبٍ آخر، أو إعادة محاولة لنفس الطلب
  return exists (
    select 1 from public.generation_slots
      where user_id = p_user_id and request_id = p_request_id and released_at is null
  );
end $$;

revoke all on function public.acquire_generation_slot(uuid, text, int) from public;
revoke all on function public.acquire_generation_slot(uuid, text, int) from anon;
revoke all on function public.acquire_generation_slot(uuid, text, int) from authenticated;
grant execute on function public.acquire_generation_slot(uuid, text, int) to service_role;

-- ------------------------------------------------------------
-- release_generation_slot — لا يحرّر إلا مقعد صاحبه
-- ------------------------------------------------------------

create or replace function public.release_generation_slot(
  p_user_id uuid,
  p_request_id text
) returns boolean
language plpgsql security definer
set search_path = '' as $$
declare v_rows int;
begin
  if p_user_id is null or p_request_id is null then return false; end if;
  update public.generation_slots
    set released_at = pg_catalog.now()
    where user_id = p_user_id
      and request_id = p_request_id   -- ← الشرط الذي يمنع تحرير مقعد الغير
      and released_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function public.release_generation_slot(uuid, text) from public;
revoke all on function public.release_generation_slot(uuid, text) from anon;
revoke all on function public.release_generation_slot(uuid, text) from authenticated;
grant execute on function public.release_generation_slot(uuid, text) to service_role;

-- ------------------------------------------------------------
-- purge_generation_slots — صيانة
-- ------------------------------------------------------------

create or replace function public.purge_generation_slots(p_hours int default 24)
returns int
language plpgsql security definer
set search_path = '' as $$
declare v_n int;
begin
  delete from public.generation_slots
    where acquired_at < pg_catalog.now() - pg_catalog.make_interval(hours => p_hours);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_generation_slots(int) from public;
revoke all on function public.purge_generation_slots(int) from anon;
revoke all on function public.purge_generation_slots(int) from authenticated;
grant execute on function public.purge_generation_slots(int) to service_role;
