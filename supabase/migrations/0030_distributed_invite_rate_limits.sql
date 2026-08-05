-- ============================================================
-- 0031 — حدّ معدّل موزّع لمسارات الدعوة (إضافية بحتة، تُطبَّق قبل النشر)
--
-- ── لماذا ──
--
-- حدود مسارات الدعوة كانت في `lib/rate-limit.ts` — عدّاد في ذاكرة العملية.
-- مع نسختين يصير الحدّ ضعف المقصود، ومع إعادة تشغيل يُصفَّر. ومهاجمٌ يريد
-- استنزاف دعوة لا يحتاج أكثر من أن يصادف نسخة أخرى.
--
-- المصدر ينتقل إلى القاعدة: عدّاد ذرّي واحد يشترك فيه كل النسخ، على نمط
-- `consume_distributed_rate_limit` (ترحيل 0019) لكن بمفتاح **نصّي** لا
-- `user_id` — فمسارات الدعوة عامة بلا جلسة.
--
-- ── المفاتيح لا تحمل قيمًا خامًا ──
--
-- الجدول يحفظ `key_hash` فقط. والتطبيق يرسل HMAC-SHA256 بمفتاح خادمي، لا
-- SHA-256 عاريًا: عنوان IP والبريد **منخفضا العشوائية** — مجال IPv4 كله
-- أربعة مليارات، وقائمة بريد شائعة أصغر بكثير. جدول قوس قزح يكشفهما من
-- الهاش العاري في دقائق. أمّا HMAC بمفتاح لا يملكه من يقرأ الجدول فيمنع
-- ذلك تمامًا. (كود الدعوة عالي العشوائية ≈80 بت، لكنه يمرّ بالمسار نفسه
-- توحيدًا.)
--
-- القاعدة لا تعرف المفتاح السرّي ولا تحتاجه: يصلها الهاش جاهزًا.
-- ============================================================

create table if not exists public.invite_rate_limits (
  /** HMAC-SHA256 للمفتاح المنطقي (bucket + قيمة) — لا قيمة خام إطلاقًا */
  key_hash     text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  /** بداية النافذة الزمنية — يجعل المفتاح الأساسي يدور تلقائيًا */
  window_start timestamptz not null,
  bucket       text not null check (bucket ~ '^[a-z][a-z0-9_-]{2,31}$'),
  count        int not null default 0 check (count >= 0),
  updated_at   timestamptz not null default now(),
  primary key (key_hash, window_start)
);

create index if not exists invite_rate_limits_window_idx
  on public.invite_rate_limits (window_start);

alter table public.invite_rate_limits enable row level security;
alter table public.invite_rate_limits force row level security;
revoke all on table public.invite_rate_limits from public;
revoke all on table public.invite_rate_limits from anon;
revoke all on table public.invite_rate_limits from authenticated;

comment on table public.invite_rate_limits is
  'عدّادات حدّ المعدّل لمسارات الدعوة — مفاتيح HMAC لا قيم خام. service_role فقط.';

-- ------------------------------------------------------------
-- consume_invite_rate_limit — العدّ والقرار في عبارة واحدة
-- ------------------------------------------------------------
--
-- الذرّية من `insert … on conflict do update … returning`: الزيادة والقراءة
-- في عبارة واحدة، فطلبان متزامنان لا يقرآن العدّاد نفسه ثم يكتبانه.

create or replace function public.consume_invite_rate_limit(
  p_key_hash text,
  p_bucket text,
  p_limit int,
  p_window_seconds int
) returns table (allowed boolean, current_count int, reset_at timestamptz)
language plpgsql security definer
set search_path = '' as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return query select false, 0, pg_catalog.now();
    return;
  end if;
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    return query select false, 0, pg_catalog.now();
    return;
  end if;

  -- نافذة ثابتة: تُشتق من الزمن نفسه فلا تحتاج تنظيفًا كي تدور
  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(
      pg_catalog.date_part('epoch', pg_catalog.now()) / p_window_seconds
    ) * p_window_seconds
  );

  insert into public.invite_rate_limits (key_hash, window_start, bucket, count, updated_at)
  values (p_key_hash, v_window_start, p_bucket, 1, pg_catalog.now())
  on conflict (key_hash, window_start) do update
    set count = public.invite_rate_limits.count + 1,
        updated_at = pg_catalog.now()
  returning public.invite_rate_limits.count into v_count;

  return query select v_count <= p_limit, v_count,
                      v_window_start + pg_catalog.make_interval(secs => p_window_seconds);
end $$;

revoke all on function public.consume_invite_rate_limit(text, text, int, int) from public;
revoke all on function public.consume_invite_rate_limit(text, text, int, int) from anon;
revoke all on function public.consume_invite_rate_limit(text, text, int, int) from authenticated;
grant execute on function public.consume_invite_rate_limit(text, text, int, int) to service_role;

-- ------------------------------------------------------------
-- purge_invite_rate_limits — صيانة
-- ------------------------------------------------------------

create or replace function public.purge_invite_rate_limits(p_hours int default 24)
returns int
language plpgsql security definer
set search_path = '' as $$
declare v_n int;
begin
  delete from public.invite_rate_limits
    where window_start < pg_catalog.now() - pg_catalog.make_interval(hours => p_hours);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_invite_rate_limits(int) from public;
revoke all on function public.purge_invite_rate_limits(int) from anon;
revoke all on function public.purge_invite_rate_limits(int) from authenticated;
grant execute on function public.purge_invite_rate_limits(int) to service_role;
