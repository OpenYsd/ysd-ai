-- ============================================================
-- YSD AI — migration 0005 (آمنة لإعادة التشغيل)
-- نظام الملفات: أعمدة إضافية، حالات جديدة، حدود لكل باقة،
-- Bucket خاص غير عام + سياسات Storage تمنع الوصول بين المستخدمين.
-- ============================================================

-- أعمدة جدول files
alter table files add column if not exists original_name text;
update files set original_name = file_name where original_name is null;
alter table files add column if not exists extracted_text text;
alter table files add column if not exists extraction_error text;
alter table files add column if not exists metadata jsonb not null default '{}';
alter table files add column if not exists updated_at timestamptz not null default now();

-- حالات جديدة (PostgreSQL 12+ يسمح بها داخل Transaction ما دامت غير مستخدمة فيها)
alter type file_status add value if not exists 'uploaded';
alter type file_status add value if not exists 'deleted';

-- رفع سقف الحجم إلى 250MB (الحد الفعلي لكل باقة من usage_limits)
alter table files drop constraint if exists files_size_bytes_check;
alter table files add constraint files_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 262144000);

-- حدود الملفات لكل باقة
alter table usage_limits add column if not exists max_files int not null default 50;
alter table usage_limits add column if not exists max_storage_mb int not null default 200;
update usage_limits set max_file_mb = 10,  max_files = 50,    max_storage_mb = 200   where tier = 'free';
update usage_limits set max_file_mb = 25,  max_files = 500,   max_storage_mb = 2048  where tier = 'plus';
update usage_limits set max_file_mb = 100, max_files = 2000,  max_storage_mb = 10240 where tier = 'pro';
update usage_limits set max_file_mb = 250, max_files = 10000, max_storage_mb = 51200 where tier = 'business';

-- Bucket خاص (غير عام) — الوصول عبر Signed URLs وسياسات RLS فقط
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

-- سياسات Storage: المجلد الأول في المسار = معرّف المستخدم
-- (userId/projectId/fileId/filename) — منع IDOR على مستوى التخزين نفسه
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ysd_files_select_own') then
    create policy "ysd_files_select_own" on storage.objects for select
      using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ysd_files_insert_own') then
    create policy "ysd_files_insert_own" on storage.objects for insert
      with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ysd_files_update_own') then
    create policy "ysd_files_update_own" on storage.objects for update
      using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ysd_files_delete_own') then
    create policy "ysd_files_delete_own" on storage.objects for delete
      using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
