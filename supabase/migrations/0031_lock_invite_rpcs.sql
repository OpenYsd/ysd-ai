-- ============================================================
-- 0031 — إغلاق دوال الدعوة عن العميل (المرحلة الأخيرة، **كاسرة للقديم**)
--
-- ⚠️ **لا تُطبَّق قبل نشر التطبيق الجديد.**
--
-- هذه **آخر ترحيل رقمًا وتطبيقًا**: 0027–0030 قبلها كلها إضافية، وبينها
-- وبين هذه خطوةٌ لا يحملها أي ملف — **نشر التطبيق الجديد**. التفصيل في
-- docs/RELEASE-v0.8.1.md.
--
-- ── لماذا كاسرة ──
--
-- التطبيق **الحيّ اليوم** ينادي `beta_invite_valid` و`beta_claim_invite`
-- بعميل الطلب (anon). فلحظة سحب الصلاحية يتوقف التحقق من كود الدعوة وإصدار
-- التذكرة في الإنتاج — أي يتعطّل التسجيل بالدعوة كلّه حتى ينشر الجديد.
-- ولهذا فُصلت عن 0027: الأولى إضافية آمنة، وهذه تُؤجَّل إلى ما بعد النشر.
--
-- ── لماذا تلزم أصلًا ──
--
-- الدالتان ممنوحتان لـanon منذ 0011، أي أن أي متصفّح ينادي القاعدة رأسًا عبر
-- REST متجاوزًا `/api/invite/*` وكل حدّ معدّل فيه. والأثر ليس تسريبًا فحسب بل
-- استنزافًا: `beta_claim_invite` **تكتب** — تُصدر تذاكر وتستهلك حدود الإصدار،
-- فحلقةٌ من عشرة أسطر تُجمّد كل دعوة قائمة عند سقفَي `c_max_active`
-- و`c_max_hourly` بلا أن يسجّل أحد.
--
-- والحدّ الذي يعيش في التطبيق وحده ليس حدًّا: الطريق إلى القاعدة لا يمرّ
-- بالتطبيق إلا بقدر ما نجبره على ذلك.
--
-- ── التراجع ──
--
-- إن تعطّل التسجيل بعد التطبيق، الرجوع فوري وبلا فقد بيانات:
--   grant execute on function public.beta_invite_valid(text) to anon, authenticated;
--   grant execute on function public.beta_claim_invite(text, text, integer) to anon, authenticated;
-- ============================================================

revoke all on function public.beta_invite_valid(text) from public;
revoke all on function public.beta_invite_valid(text) from anon;
revoke all on function public.beta_invite_valid(text) from authenticated;
grant execute on function public.beta_invite_valid(text) to service_role;

revoke all on function public.beta_claim_invite(text, text, integer) from public;
revoke all on function public.beta_claim_invite(text, text, integer) from anon;
revoke all on function public.beta_claim_invite(text, text, integer) from authenticated;
grant execute on function public.beta_claim_invite(text, text, integer) to service_role;
