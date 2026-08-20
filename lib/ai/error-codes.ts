/**
 * تصنيف أخطاء المحادثة (v0.6.6) — رمز واحد متفق عليه بين الخادم والواجهة.
 *
 * قبل هذا كانت كل الأعطال تظهر للمستخدم كـ«تعذر الاتصال»: انتهاء الجلسة،
 * وضغط المزوّد، وانقطاع الشبكة، والمهلة — كلها رسالة واحدة لا تدل على شيء ولا
 * تقول للمستخدم ما الذي يفعله. الرمز يفصلها، والرسالة تُشتق منه.
 *
 * ── وما تغيّر في المرحلة 6D ──
 *
 * **الرمز آلةٌ، والنصُّ لغة.** كانت `ERROR_MESSAGES` عربيةً وحدها وتُعرض
 * للجميع، فيرى مستخدم الإنجليزية واجهةً إنجليزية وخطأً عربيًّا. فبقيت هنا
 * **لجسم استجابة الخادم** كما كانت — عقدٌ قائم لا يُكسر — وانتقل ما يُعرض
 * في المتصفّح إلى `lib/i18n` عبر `CHAT_ERROR_KEY`.
 *
 * وأُضيفت ثلاثة رموز لحالاتٍ كانت تسقط إلى «تعذّر إكمال الطلب»: بلوغ حدّ
 * الباقة، والطلب غير الصالح، والتوليد المتزامن. ولم يُعَد تسمية رمزٍ قائم:
 * ما على السلك عقدٌ مع عملاء قد لا نملكهم.
 *
 * لا يعتمد على `@/` ليبقى قابلًا للاستيراد في اختبارات vitest.
 */

export type ChatErrorCode =
  | "provider_unavailable" // كل النماذج مضغوطة/محجوبة
  | "network_error" // انقطاع شبكة بين الخادم والمزوّد أو بين المتصفح والخادم
  | "auth_expired" // انتهت الجلسة وتعذّر التجديد
  | "timeout" // تجاوز الحد الزمني
  | "rate_limit" // حد المعدّل (حصة المستخدم أو المزوّد)
  | "quality_guard" // أوقفه حارس الجودة/اللغة
  | "usage_limit" // استُنفد حدّ الباقة — إعادة المحاولة فورًا لا تُجدي
  | "invalid_request" // طلبٌ لا يصحّ — لا يُصلحه تكرار
  | "concurrent_request" // توليدٌ آخر جارٍ لنفس المستخدم
  | "unknown";

/**
 * رسالة عربية واضحة لكل رمز — **لجسم استجابة الخادم**.
 *
 * تبقى كما هي: مسارات API تكتبها في `error`، وعملاء خارج المتصفّح يقرؤونها.
 * وما يعرضه المتصفّح يأتي من `CHAT_ERROR_KEY` بلغة المستخدم.
 */
export const ERROR_MESSAGES: Readonly<Record<ChatErrorCode, string>> = {
  provider_unavailable:
    "خدمة الذكاء الاصطناعي غير متاحة الآن. رسالتك محفوظة — أعد المحاولة بعد قليل.",
  network_error: "انقطع الاتصال أثناء الرد. تحقّق من الشبكة ثم أعد المحاولة.",
  auth_expired: "انتهت جلستك. سجّل الدخول من جديد — مسودتك محفوظة.",
  timeout: "استغرق الرد وقتًا أطول من المتوقع فأُوقف. أعد المحاولة.",
  rate_limit: "تجاوزت حد الاستخدام مؤقتًا. انتظر قليلًا ثم أعد المحاولة.",
  quality_guard: "تعذّر الحصول على رد بجودة مناسبة. أعد المحاولة.",
  usage_limit: "وصلت إلى حد الاستهلاك في باقتك الحالية.",
  invalid_request: "تعذّر تنفيذ هذا الطلب. حدّث الصفحة وحاول من جديد.",
  concurrent_request: "لديك طلب جارٍ. انتظر انتهاءه قبل إرسال طلب جديد.",
  unknown: "تعذّر إكمال الطلب. أعد المحاولة.",
};

/**
 * ★ الرمز ⇒ مفتاح النصّ المعروض في `lib/i18n`.
 *
 * ولا يُترجَم الرمز نفسه: هو معرّفٌ للآلة يمرّ على السلك ويُسجَّل ويُقارَن.
 * وما يُترجَم ما يقرأه إنسان.
 */
export const CHAT_ERROR_KEY = {
  provider_unavailable: "errProviderUnavailable",
  network_error: "errNetwork",
  auth_expired: "errAuthExpired",
  timeout: "errTimeout",
  rate_limit: "errRateLimit",
  quality_guard: "errQualityGuard",
  usage_limit: "errUsageLimit",
  invalid_request: "errInvalidRequest",
  concurrent_request: "errConcurrent",
  unknown: "errUnknown",
} as const satisfies Record<ChatErrorCode, string>;

const CODES = Object.keys(CHAT_ERROR_KEY) as ChatErrorCode[];

export function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === "string" && (CODES as string[]).includes(value);
}

/**
 * ★ هل يفيد زر إعادة المحاولة؟
 *
 * وزرٌّ لا يُجدي أسوأ من غيابه: يجعل المستخدم يعيد ويعيد ويظنّ العطلَ عابرًا
 * بينما السبب ثابت. فالجلسةُ المنتهية تحتاج دخولًا، وحدُّ الباقة المستنفد
 * يحتاج انتظارًا أو ترقية، والطلبُ غير الصالح لا يُصلحه تكرار.
 */
export function isRetryable(code: ChatErrorCode): boolean {
  return code !== "auth_expired" && code !== "usage_limit" && code !== "invalid_request";
}

/** هل الطريق هو تسجيل الدخول لا إعادة المحاولة؟ */
export function needsSignIn(code: ChatErrorCode): boolean {
  return code === "auth_expired";
}

/**
 * ★ رمزُ السلك ⇒ رمزُ العرض.
 *
 * الخادم يرسل أحيانًا سببًا أدقّ من مجموعة العرض: أسباب الميزانية
 * (`monthly_tokens`…) وأسباب رفض النموذج (`model_unknown`…). وهي عقودٌ قائمة
 * تُسجَّل وتُقاس، فلا تُعاد تسميتها — تُجمَع هنا إلى ما يفهمه المستخدم.
 */
export function normalizeChatErrorCode(
  raw: string | null | undefined,
  status?: number,
): ChatErrorCode {
  if (isChatErrorCode(raw)) return raw;
  switch (raw) {
    case "monthly_tokens":
    case "monthly_messages":
    case "daily_messages":
      return "usage_limit";
    case "bad_request":
    case "model_unknown":
    case "model_disabled":
      return "invalid_request";
    case "no_limits":
    case "unavailable":
      return "unknown";
    default:
      return typeof status === "number" ? codeFromHttpStatus(status) : "unknown";
  }
}

/** يحوّل نوع خطأ المزوّد الداخلي إلى رمز المحادثة */
export function codeFromProviderKind(kind: string): ChatErrorCode {
  switch (kind) {
    case "rate_limit":
      return "rate_limit";
    case "no_free_model":
    case "overloaded":
    // 403: حجب قد يكون خاصًّا بنموذج — نفس الرمز العام، وسلوك إعادة مختلف
    case "forbidden":
    case "insufficient_credit":
    case "auth": // إعداد المنصة لا جلسة المستخدم
      return "provider_unavailable";
    case "network":
      return "network_error";
    case "timeout":
      return "timeout";
    default:
      return "unknown";
  }
}

/** رمز من حالة HTTP — للأخطاء التي تصل قبل بدء البثّ */
export function codeFromHttpStatus(status: number): ChatErrorCode {
  if (status === 401) return "auth_expired";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503 || status === 502) return "provider_unavailable";
  if (status === 400) return "invalid_request";
  return "unknown";
}
