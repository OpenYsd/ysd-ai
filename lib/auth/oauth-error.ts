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

/**
 * الحالة المرصودة حيًّا: GoTrue **يحجب** سبب المُحفِّز ويرسل وصفًا عامًّا
 * (`error=server_error`, `error_code=unexpected_failure`,
 * `error_description=Database error saving new user`). فلا يُعرف من النصّ وحده
 * أهو رفضُ دعوة أم عطلٌ حقيقي في القاعدة.
 *
 * لا نطابق `error_code` شرطًا لازمًا: GoTrue يغيّره بين الإصدارات، والوصف هو
 * الإشارة الثابتة المرصودة.
 */
export function isGenericDatabaseError(raw: string | null | undefined): boolean {
  return /database error saving new user/i.test(String(raw ?? ""));
}

/**
 * تصنيف خطأ المزوّد الراجع في شريط العنوان.
 *
 * `allowRegistration` هو ما يفكّ الالتباس في الحالة العامة: التسجيل مغلق يعني
 * أن كل مستخدم Google جديد يُرفض بالضرورة، فالوصف العام في هذا السياق رفضُ
 * دعوة لا عطل. أمّا والتسجيل مفتوح — أو تعذّرت قراءة الإعداد — فيبقى
 * `oauth_failed`: رسالةٌ مطمئنة خاطئة تُخفي عطلًا حقيقيًا أسوأ من رسالة عامة.
 *
 * `null` تعني «تعذّرت القراءة» لا «false» — والفرق مقصود.
 */
export function classifyOAuthCallbackError(params: {
  error: string | null | undefined;
  errorCode?: string | null;
  errorDescription: string | null | undefined;
  allowRegistration: boolean | null;
}): OAuthReason {
  if (params.error === "access_denied") return "oauth_cancelled";

  // نصّ صريح من المُحفِّز حين لا يحجبه GoTrue
  const explicit = classifyOAuthFailure(params.errorDescription);
  if (explicit !== "oauth_failed") return explicit;

  if (isGenericDatabaseError(params.errorDescription) && params.allowRegistration === false) {
    return "oauth_invite_required";
  }
  return "oauth_failed";
}

/**
 * جزءٌ فارغ المعنى يُلحق بوجهة التحويل — **حاجزُ توريث**، لا زينة.
 *
 * RFC 7231 §7.1.2: إذا خلا `Location` من جزء (fragment) **وجب** على المتصفح
 * أن يورّثه من عنوان الطلب الأصلي. وGoTrue يعيدنا ومعه جزءٌ خام
 * (`#error=...&error_description=...`)، فينتقل ذلك الجزء إلى `/login` رغم أن
 * رابطنا نظيف تمامًا.
 *
 * وهذا ما جعل العطل ينجو من كل فحص خادمي: **الجزء لا يُرسَل إلى الخادم
 * إطلاقًا**. فلا يظهر في سجلّ ولا في ترويسة ولا في أي قياس أجريناه — يراه
 * المستخدم وحده في شريط عنوانه.
 *
 * فجزءٌ صريح — أيًّا كان — يقطع التوريث من أصله. وقيمته بلا دلالة عمدًا: لا
 * تحمل سببًا ولا حالة، ولا يقرأها أحد.
 */
export const OAUTH_CLEAN_FRAGMENT = "oauth-clean";

/**
 * مسار العودة إلى صفحة الدخول — **`reason` وحده لا غير**.
 *
 * يُبنى من الصفر ولا يُنسخ فيه شيء من شريط عنوان الوارد: لو مُرِّر
 * `error_description` كما هو لظهر «Database error saving new user» في شريط
 * عنوان المستخدم، ولحُفظ في سجلّ المتصفح وفي أي مشاركة للرابط. والرمز يُصفّى
 * على المجموعة المغلقة، فلا يصل شريطَ العنوان نصٌّ من مصدر خارجي إطلاقًا.
 *
 * ويُختم بجزء صريح يمنع توريث جزء الوارد — انظر `OAUTH_CLEAN_FRAGMENT`.
 * والحاجز وحده لا يكفي: يبقى `#oauth-clean` ظاهرًا في شريط العنوان، فتمسحه
 * صفحة الدخول عند التحميل. الحاجز يمنع التسريب، والمسح ينظّف الأثر.
 */
export function loginRedirectPath(reason: string): string {
  const safe = (OAUTH_REASONS as readonly string[]).includes(reason)
    ? reason
    : "oauth_failed";
  return `/login?reason=${safe}#${OAUTH_CLEAN_FRAGMENT}`;
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
