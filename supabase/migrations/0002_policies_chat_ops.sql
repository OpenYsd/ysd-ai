-- ============================================================
-- YSD AI — migration 0002
-- سياسات ناقصة لعمليات المحادثة الحقيقية:
--   * تعديل الرسائل (تعديل رسالة المستخدم + الحذف الناعم)
--   * تسجيل الاستهلاك من مسار المحادثة بجلسة المستخدم
-- ============================================================

-- تعديل الرسائل عبر ملكية المحادثة (يشمل الحذف الناعم deleted_at)
create policy "messages_update_own" on messages for update
  using (
    exists (
      select 1 from conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- تسجيل الاستهلاك: المستخدم يسجّل استهلاكه فقط
create policy "usage_insert_own" on usage_events for insert
  with check (user_id = auth.uid());
