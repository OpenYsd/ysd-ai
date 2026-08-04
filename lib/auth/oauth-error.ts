/**
 * تصنيف أخطاء تدفّق OAuth ورسائلها — **مصدر واحد** للرمز وللنصّ معًا.
 *
 * لماذا وحدة واحدة: الرمز يُنتَج في نقطة الرجوع والنصّ يُعرَض في صفحة الدخول.
 * لو عاشا متفرّقين لأمكن أن يُضاف رمز بلا رسالة — فيصمت الخطأ ولا يرى المستخدم
 * شيئًا — أو أن تتغيّر صياغة دون أن يتبعها الرمز. اختبارٌ يثبّت أن لكل رمز
 * رسالةً وأن لا رسالة يتيمة.
 *
 * **ولا يخرج نصّ المزوّد ولا نصّ القاعدة إلى المتصفح إطلاقًا**: `error_description`
 * القادم من GoTrue قد يحمل «Database error saving new user» أو اسم الدالة أو
 * رمز SQLSTATE. يُقرأ هنا للتصنيف فقط، ولا يُمرَّر ولا يُعرَض. ما يصل المتصفح
 * رمزٌ من مجموعة مغلقة لا غير.
 */

export const OAUTH_REASONS = [
  "session_expired",
  "oauth_cancelled",
  "oauth_invite_required",
  "oauth_consent_required",
  "oauth_registration_closed",
  "oauth_failed",
] as const;

export type OAuthReason = (typeof OAUTH_REASONS)[number];

/**
 * يصنّف سبب الفشل من نصّ خام (رسالة تبادل الجلسة أو `error_description`).
 *
 * `invite_required_or_invalid` هو ما يرفعه `handle_new_user` حين يحاول مستخدم
 * Google غير مسجَّل الدخول والتسجيل العام مغلق — وهي الحالة الشائعة اليوم،
 * لأن زر Google بقي في صفحة الدخول وحدها لدخول الحسابات القائمة.
 */
export function classifyOAuthFailure(raw: string | null | undefined): OAuthReason {
  const text = String(raw ?? "");
  if (/invite_required_or_invalid|invite/i.test(text)) return "oauth_invite_required";
  if (/consent_required|consent/i.test(text)) return "oauth_consent_required";
  if (/registration_closed/i.test(text)) return "oauth_registration_closed";
  return "oauth_failed";
}

/** الرسائل المعروضة — عربية، بلا أي تفصيل تقني */
export const AUTH_REASON_MESSAGE: Record<OAuthReason, string> = {
  session_expired: "انتهت جلستك. سجّل الدخول من جديد.",
  oauth_cancelled: "أُلغي الدخول عبر Google.",
  /**
   * الصياغة تخاطب الواقع: التسجيل عبر Google غير متاح حاليًا (الزر مخفيّ في
   * صفحة التسجيل)، فلا معنى لتوجيه المستخدم إلى «أكمل التسجيل عبر Google».
   */
  oauth_invite_required:
    "هذا الحساب غير مسجل أو لا يملك دعوة صالحة. استخدم حسابًا مسجلًا أو اطلب دعوة.",
  oauth_consent_required: "يلزم قبول الشروط قبل المتابعة. أكمل التسجيل من صفحة التسجيل.",
  oauth_registration_closed: "التسجيل مغلق حاليًا.",
  oauth_failed: "تعذّر إكمال الدخول عبر Google. حاول مرة أخرى.",
};
