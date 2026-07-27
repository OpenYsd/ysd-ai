-- 0019 — حدّ معدّل موزّع عبر نسخ الخادم (v0.7.0 RC2)
--
-- lib/rate-limit.ts في ذاكرة العملية: مع نسختين يصير الحدّ الفعلي ضعف
-- المقصود، ويُصفَّر عند كل إعادة تشغيل. هذا الجدول يجعله مشتركًا ودائمًا،
-- والعدّ ذرّيًا فلا يتجاوز طلبان متزامنان الحدَّ معًا.
--
-- خصوصية: لا نص مستخدم ولا نص مساعد ولا بريد ولا IP ولا محتوى ملفات ولا
-- ترويسات عميل. معرّف مستخدم ودلو مقيَّد وعدّاد وأزمنة — لا غير.

create table if not exists public.distributed_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- دلو مغلق الشكل: أحرف صغيرة وشرطات فقط وطول محدود — لا نص حرّ
  bucket text not null
    constraint distributed_rate_limits_bucket_format
    check (bucket ~ '^[a-z][a-z0-9_-]{2,31}$'),
  window_start timestamptz not null,
  request_count integer not null default 0
    constraint distributed_rate_limits_count_nonneg check (request_count >= 0),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,

  -- جوهر الذرّية: صف واحد لكل (مستخدم، دلو، نافذة)
  constraint distributed_rate_limits_pk primary key (user_id, bucket, window_start)
);

create index if not exists distributed_rate_limits_expires_idx
  on public.distributed_rate_limits (expires_at);
create index if not exists distributed_rate_limits_lookup_idx
  on public.distributed_rate_limits (user_id, bucket, window_start desc);

-- RLS مفعّلة **بلا أي سياسة**: لا وصول لأي دور عميل إطلاقًا.
-- القراءة والكتابة التشغيلية عبر service_role وحده (يتجاوز RLS).
alter table public.distributed_rate_limits enable row level security;
revoke all on public.distributed_rate_limits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- الاستهلاك الذرّي: زيادة العدّاد وإرجاع القرار في عملية واحدة.
--
-- الذرّية عبر INSERT ... ON CONFLICT DO UPDATE مع RETURNING: صفّ واحد يُقفل
-- ضمنيًا، فطلبان متزامنان يحصلان على عدّادين متتاليين لا نفس القيمة —
-- ولا يمكن أن يتجاوزا الحدّ معًا (لا نمط select-ثم-update).
-- ---------------------------------------------------------------------------
create or replace function public.consume_distributed_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, reset_at timestamptz, current_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_reset_at timestamptz;
  v_count integer;
begin
  -- تحقّق صارم من المدخلات: قيم خارج المدى تعني خطأ برمجيًا لا تساهلًا
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  if p_bucket is null or p_bucket !~ '^[a-z][a-z0-9_-]{2,31}$' then
    raise exception 'invalid bucket';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'invalid limit';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid window';
  end if;

  -- نافذة ثابتة: تُحسب من ساعة القاعدة لا من ساعة الخادم (نسخ متعددة)
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_reset_at := v_window_start + make_interval(secs => p_window_seconds);

  insert into public.distributed_rate_limits as d
    (user_id, bucket, window_start, request_count, updated_at, expires_at)
  values
    (p_user_id, p_bucket, v_window_start, 1, now(), v_reset_at + interval '1 hour')
  on conflict (user_id, bucket, window_start) do update
    set request_count = d.request_count + 1,
        updated_at = now()
  returning d.request_count into v_count;

  return query select
    (v_count <= p_limit),
    greatest(0, p_limit - v_count),
    v_reset_at,
    v_count;
end;
$$;

-- التنفيذ لـservice_role وحده — لا للعميل ولا للمجهول
revoke all on function public.consume_distributed_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.consume_distributed_rate_limit(uuid, text, integer, integer) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- تنظيف آمن: المنتهي فقط.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_distributed_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.distributed_rate_limits where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.cleanup_distributed_rate_limits() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cleanup_distributed_rate_limits() to service_role';
  end if;
end $$;

comment on table public.distributed_rate_limits is
  'حدّ معدّل موزّع (عدّادات ونوافذ فقط). ممنوع أي نص أو بريد أو IP أو محتوى.';
