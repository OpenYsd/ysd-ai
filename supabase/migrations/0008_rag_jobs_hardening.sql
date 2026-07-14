-- ============================================================
-- YSD AI — migration 0008 (آمنة لإعادة التشغيل)
-- طابور دائم في قاعدة البيانات لتجهيز RAG:
--   * جدول rag_jobs مصدر الحقيقة للوظائف/الأقفال/المحاولات/التقدم
--   * RLS وعزل المستخدمين
--   * فهرس فريد جزئي يمنع أكثر من وظيفة نشطة لنفس (الملف, النوع)
--   * idempotency key = file_id:content_hash:job_type
--   * claim ذري عبر FOR UPDATE SKIP LOCKED مع استرجاع الأقفال المنتهية
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'rag_job_status') then
    create type rag_job_status as enum
      ('queued', 'running', 'retrying', 'completed', 'failed', 'cancelled');
  end if;
end $$;

create table if not exists rag_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  job_type text not null default 'rag_prepare',
  status rag_job_status not null default 'queued',
  idempotency_key text not null,
  attempts int not null default 0,
  max_attempts int not null default 4,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  progress_current int not null default 0,
  progress_total int not null default 0,
  progress_percent int not null default 0,
  error_code text,
  error_message text,      -- رسالة آمنة فقط — لا نصوص ملفات
  metadata jsonb not null default '{}',
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- فهرس فريد جزئي: وظيفة نشطة واحدة فقط لكل (ملف, نوع)
create unique index if not exists uniq_active_rag_job on rag_jobs (file_id, job_type)
  where status in ('queued', 'running', 'retrying');

-- منع تكرار العمل لنفس المحتوى: مفتاح idempotency فريد بين الوظائف الحيّة/المكتملة
create unique index if not exists uniq_rag_job_idempotency on rag_jobs (idempotency_key)
  where status in ('queued', 'running', 'retrying', 'completed');

-- فهرس الالتقاط
create index if not exists idx_rag_jobs_claim on rag_jobs (available_at)
  where status in ('queued', 'retrying');
create index if not exists idx_rag_jobs_user on rag_jobs (user_id, created_at desc);
create index if not exists idx_rag_jobs_file on rag_jobs (file_id);

-- محفّز updated_at
create or replace function touch_rag_job_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_rag_jobs_updated_at on rag_jobs;
create trigger trg_rag_jobs_updated_at before update on rag_jobs
  for each row execute function touch_rag_job_updated_at();

-- ---------- RLS: كل مستخدم يرى ويدير وظائفه فقط ----------
alter table rag_jobs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='rag_jobs' and policyname='rag_jobs_select_own') then
    create policy "rag_jobs_select_own" on rag_jobs for select using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename='rag_jobs' and policyname='rag_jobs_insert_own') then
    create policy "rag_jobs_insert_own" on rag_jobs for insert
      with check (
        user_id = auth.uid()
        and exists (select 1 from files f where f.id = file_id and f.user_id = auth.uid())
      );
  end if;
  if not exists (select 1 from pg_policies where tablename='rag_jobs' and policyname='rag_jobs_update_own') then
    create policy "rag_jobs_update_own" on rag_jobs for update using (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where tablename='rag_jobs' and policyname='rag_jobs_delete_own') then
    create policy "rag_jobs_delete_own" on rag_jobs for delete using (user_id = auth.uid());
  end if;
end $$;

-- ============================================================
-- claim ذري: FOR UPDATE SKIP LOCKED داخل معاملة واحدة
-- يسترجع الأقفال المنتهية (heartbeat قديم) ثم يلتقط أقدم وظيفة متاحة.
-- security definer لكنه يقيّد على auth.uid() — لا يلتقط وظائف مستخدم آخر.
-- (Worker مستقل عبر المستخدمين سيحتاج service role مستقبلًا — موثّق فقط.)
-- ============================================================
create or replace function claim_rag_job(p_worker_id text, p_lease_seconds int default 120)
returns setof rag_jobs
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return;
  end if;

  -- استرجاع الأقفال المنتهية لهذا المستخدم → retrying (متاحة فورًا)
  update rag_jobs
    set status = 'retrying', locked_by = null, locked_at = null
    where user_id = auth.uid()
      and status = 'running'
      and heartbeat_at is not null
      and heartbeat_at < now() - make_interval(secs => p_lease_seconds);

  -- التقاط أقدم وظيفة متاحة بشكل ذري
  select id into v_id
  from rag_jobs
  where user_id = auth.uid()
    and status in ('queued', 'retrying')
    and available_at <= now()
  order by available_at asc
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update rag_jobs
    set status = 'running',
        locked_by = p_worker_id,
        locked_at = now(),
        heartbeat_at = now(),
        started_at = coalesce(started_at, now()),
        attempts = attempts + 1
    where id = v_id
  returning *;
end $$;

-- استرجاع الوظائف المعلّقة يدويًا (لأدوات الصيانة) — نفس منطق انتهاء القفل
create or replace function reclaim_expired_rag_jobs(p_lease_seconds int default 120)
returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if auth.uid() is null then return 0; end if;
  update rag_jobs
    set status = 'retrying', locked_by = null, locked_at = null
    where user_id = auth.uid()
      and status = 'running'
      and heartbeat_at < now() - make_interval(secs => p_lease_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ============================================================
-- تنظيف دوري: حذف الوظائف المنتهية القديمة (سياسة احتفاظ: 7 أيام).
-- يُستدعى من cron (pg_cron) أو يدويًا. security definer لكن مقيّد بمالك الجلسة
-- عند الاستدعاء من المستخدم؛ يُشغَّل عبر خدمة للتنظيف العام مستقبلًا.
-- ============================================================
create or replace function cleanup_old_rag_jobs(p_retention_days int default 7)
returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  delete from rag_jobs
    where status in ('completed', 'failed', 'cancelled')
      and updated_at < now() - make_interval(days => p_retention_days)
      and (auth.uid() is null or user_id = auth.uid());
  get diagnostics v_count = row_count;
  return v_count;
end $$;
