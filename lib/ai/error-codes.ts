/**
 * تصنيف أخطاء المحادثة (v0.6.6) — رمز واحد متفق عليه بين الخادم والواجهة.
 *
 * قبل هذا كانت كل الأعطال تظهر للمستخدم كـ«تعذر الاتصال»: انتهاء الجلسة،
 * وضغط المزوّد، وانقطاع الشبكة، والمهلة — كلها رسالة واحدة لا تدل على شيء ولا
 * تقول للمستخدم ما الذي يفعله. الرمز يفصلها، والرسالة تُشتق منه.
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
  | "unknown";

/** رسالة عربية واضحة لكل رمز — تقول ما حدث وما العمل */
export const ERROR_MESSAGES: Readonly<Record<ChatErrorCode, string>> = {
  provider_unavailable:
    "خدمة الذكاء الاصطناعي غير متاحة الآن. رسالتك محفوظة — أعد المحاولة بعد قليل.",
  network_error: "انقطع الاتصال أثناء الرد. تحقّق من الشبكة ثم أعد المحاولة.",
  auth_expired: "انتهت جلستك. سجّل الدخول من جديد — مسودتك محفوظة.",
  timeout: "استغرق الرد وقتًا أطول من المتوقع فأُوقف. أعد المحاولة.",
  rate_limit: "تجاوزت حد الاستخدام مؤقتًا. انتظر قليلًا ثم أعد المحاولة.",
  quality_guard: "تعذّر الحصول على رد بجودة مناسبة. أعد المحاولة.",
  unknown: "تعذّر إكمال الطلب. أعد المحاولة.",
};

/** هل يفيد زر إعادة المحاولة مع هذا الرمز؟ (انتهاء الجلسة يحتاج دخولًا لا إعادة) */
export function isRetryable(code: ChatErrorCode): boolean {
  return code !== "auth_expired";
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
  return "unknown";
}
