-- ============================================================
-- YSD AI — migration 0010 (آمنة لإعادة التشغيل، لا تحذف سجلات)
-- توثيق: admin_audit_logs.admin_id يصبح NULLABLE، والمفتاح الأجنبي
-- ON DELETE SET NULL — لحفظ سجل التدقيق عند حذف حساب المشرف بدل تعاقب الحذف.
-- (طُبِّق يدويًا؛ هذه الـ migration تجعله جزءًا من تاريخ المشروع.)
-- ============================================================

-- 1) السماح بـ NULL (لا خطأ إن كان قابلًا لها مسبقًا)
alter table admin_audit_logs alter column admin_id drop not null;

-- 2) إعادة تعريف المفتاح الأجنبي بـ ON DELETE SET NULL
--    نُسقط أي FK قائم على admin_id (أيًا كان اسمه) ثم نضيف الصحيح — بلا حذف بيانات.
do $$
declare c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute a
      on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
    where con.conrelid = 'admin_audit_logs'::regclass
      and con.contype = 'f'
      and a.attname = 'admin_id'
  loop
    execute format('alter table admin_audit_logs drop constraint %I', c);
  end loop;

  alter table admin_audit_logs
    add constraint admin_audit_logs_admin_id_fkey
    foreign key (admin_id) references profiles(id) on delete set null;
end $$;

-- ملاحظة: سياسة الإدراج (audit_insert_admin من 0009) تبقى admin_id = auth.uid()،
-- فالسجلات الجديدة دائمًا بمعرّف مشرف؛ NULL يظهر فقط بعد حذف حساب مشرف سابق.
