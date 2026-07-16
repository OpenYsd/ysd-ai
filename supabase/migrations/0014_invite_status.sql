-- ============================================================
-- YSD AI — migration 0014 (آمنة لإعادة التشغيل، لا تحذف بيانات)
-- حالة الدعوة تُحسب في PostgreSQL بـ now()، لا بساعة خادم التطبيق.
--
-- لماذا (مُكتشف أثناء الاختبار الحي):
--   /api/admin/invites كان يحسب الحالة في Node بـ Date.now()، بينما الإنفاذ
--   يجري داخل SQL بـ now() (في handle_new_user و beta_claim_invite و
--   beta_invite_valid). أي انحراف بين الساعتين يجعل اللوحة تعرض «active»
--   لدعوة ترفضها القاعدة فعلًا. قياس حي في بيئة التطوير أظهر انحرافًا قدره
--   194 ثانية — فالشارة كانت تكذب على المشرف بينما الإنفاذ سليم.
--   العلاج: مصدر واحد للوقت — ساعة القاعدة.
--
-- الترتيب المعتمد: revoked → exhausted → expired → active
--   تنبيه: هذا يغيّر السلوك السابق (كان expired يسبق exhausted). دعوة
--   مستنفدة ومنتهية معًا تظهر الآن «exhausted» بدل «expired».
--
-- لماذا دالة حقل محسوب (computed field) لا VIEW:
--   الـVIEW يعمل بامتيازات مالكه فيتجاوز RLS على beta_invites ما لم يُضبط
--   security_invoker = true (متاح في PG15+ فقط). الدالة هنا تستقبل صف الجدول
--   المقروء أصلًا ولا تلمس أي جدول، فتبقى RLS على beta_invites هي الحارس
--   الوحيد — بلا اعتماد على إصدار ولا خطر تجاوز.
-- ============================================================

create or replace function invite_status(inv beta_invites)
returns text
language sql
stable
set search_path = public, pg_temp as $$
  select case
    when inv.revoked_at is not null                                 then 'revoked'
    when inv.used_count >= inv.max_uses                             then 'exhausted'
    when inv.expires_at is not null and inv.expires_at <= now()     then 'expired'
    else 'active'
  end
$$;

comment on function invite_status(beta_invites) is
  'حالة الدعوة بساعة القاعدة (now()) — مصدر الحقيقة الوحيد. الترتيب: revoked → exhausted → expired → active. حقل محسوب لـPostgREST: select=...,status:invite_status';

-- الصلاحيات: المشرفون يقرؤون عبر PostgREST بدور authenticated.
-- الدالة حسابية بحتة (لا تقرأ أي جدول) وRLS على beta_invites تبقى الحارس.
do $$ begin
  execute 'revoke all on function invite_status(beta_invites) from public, anon';
  execute 'grant execute on function invite_status(beta_invites) to authenticated';
end $$;
