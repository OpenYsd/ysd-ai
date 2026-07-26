-- 0017 — منع ازدواج طلبات المحادثة عبر نسخ الخادم (v0.6.6 RC2)
--
-- ذاكرة العملية (lib/chat/idempotency.ts) تحمي داخل نسخة واحدة فقط، وتُفقد عند
-- إعادة التشغيل. هذا الجدول يجعل الحماية دائمة ومشتركة: الحجز عملية insert
-- ذرّية على قيد فريد، فالطلب المكرر يفشل حتمًا مهما كانت النسخة التي استقبلته.
--
-- خصوصية: لا يُحفظ هنا نص الرسالة ولا أي محتوى — معرّفات وحالة وأزمنة فقط.

create table if not exists public.chat_request_ids (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id text not null,
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_message_id uuid references public.messages(id) on delete set null,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',

  -- جوهر الحماية: الحجز الذرّي. محاولة ثانية بنفس المعرّف تفشل بـ23505.
  constraint chat_request_ids_unique unique (user_id, client_request_id)
);

-- للتنظيف الدوري وللبحث بالمستخدم
create index if not exists chat_request_ids_expires_idx
  on public.chat_request_ids (expires_at);
create index if not exists chat_request_ids_user_idx
  on public.chat_request_ids (user_id, created_at desc);

-- RLS: كل مستخدم يرى حجوزاته فقط (الجدول لا يحمل محتوى، لكن المبدأ يبقى)
alter table public.chat_request_ids enable row level security;

drop policy if exists "chat_request_ids_select_own" on public.chat_request_ids;
create policy "chat_request_ids_select_own"
  on public.chat_request_ids for select
  using (auth.uid() = user_id);

drop policy if exists "chat_request_ids_insert_own" on public.chat_request_ids;
create policy "chat_request_ids_insert_own"
  on public.chat_request_ids for insert
  with check (auth.uid() = user_id);

drop policy if exists "chat_request_ids_update_own" on public.chat_request_ids;
create policy "chat_request_ids_update_own"
  on public.chat_request_ids for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- تنظيف آمن: يحذف المنتهي فقط، ويُستدعى دوريًا (cron أو عند الحاجة).
-- security definer ليعمل بلا اعتماد على جلسة مستخدم، مع search_path مثبّت.
create or replace function public.cleanup_chat_request_ids()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.chat_request_ids where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on table public.chat_request_ids is
  'حجز معرّفات طلبات المحادثة لمنع الازدواج عبر نسخ الخادم. لا يحتوي أي نص رسائل.';
