-- 0018 — مقاييس تشغيلية دائمة للوحة المراقبة (v0.6.6 RC2)
--
-- المقاييس كانت في ذاكرة الحاوية فتُصفَّر عند إعادة التشغيل ولا تُجمَّع عبر
-- النسخ. هذا الجدول يجعل إحصاءات آخر 60 دقيقة تنجو من إعادة التشغيل.
--
-- خصوصية (شرط تصميمي لا تفصيل): ممنوع منعًا باتًا حفظ نص المستخدم أو نص
-- المساعد أو البريد أو الاسم أو عنوان IP أو محتوى الملفات. الأعمدة كلها أزمنة
-- وعدّادات ورموز مغلقة — لا عمود نصّي حر واحد. حتى user_id غير محفوظ: اللوحة
-- تعرض إحصاءات مجمّعة لا سلوك أفراد.

create table if not exists public.observability_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),

  -- تصنيف
  mode text not null check (mode in ('general', 'protected')),
  error_code text check (error_code in (
    'provider_unavailable', 'network_error', 'auth_expired',
    'timeout', 'rate_limit', 'quality_guard', 'unknown'
  )),
  session_refresh_result text check (session_refresh_result in ('refreshed', 'failed', 'not_needed')),

  -- أزمنة (ms) — سالب يعني «غير مُبلَّغ»
  auth_ms integer not null default 0,
  conversation_lookup_ms integer not null default 0,
  user_message_insert_ms integer not null default 0,
  rag_ms integer not null default 0,
  provider_first_byte_ms integer not null default -1,
  total_first_text_ms integer not null default -1,
  total_response_ms integer not null default 0,

  -- عدّادات
  provider_calls integer not null default 0,
  fallback_count integer not null default 0,
  protected_short_circuit boolean not null default false
);

create index if not exists observability_events_created_idx
  on public.observability_events (created_at desc);

-- RLS: لا قراءة لأحد عبر anon/authenticated. اللوحة تقرأ عبر مسار إداري
-- خادمي يتحقق من الدور بنفسه، فلا حاجة لفتح الجدول لأي جلسة مستخدم.
alter table public.observability_events enable row level security;

drop policy if exists "observability_events_admin_read" on public.observability_events;
create policy "observability_events_admin_read"
  on public.observability_events for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'owner')
    )
  );

drop policy if exists "observability_events_insert" on public.observability_events;
create policy "observability_events_insert"
  on public.observability_events for insert
  with check (auth.uid() is not null);

-- تنظيف آمن: نافظ اللوحة 60 دقيقة، ونحتفظ بـ7 أيام للتحليل ثم نحذف.
create or replace function public.cleanup_observability_events()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.observability_events where created_at < now() - interval '7 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on table public.observability_events is
  'مقاييس أداء المحادثة (أزمنة وعدّادات ورموز فقط). ممنوع حفظ أي نص أو بيانات شخصية.';
