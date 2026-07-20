/**
 * ذاكرة تهدئة النماذج — تمنع إعادة محاولة نموذج فاشل في كل طلب.
 *
 * السبب (مُثبت حيًا): حين تُحجب النماذج المجانية، كان كل طلب يدفع ثمن ثلاث
 * محاولات فاشلة قبل أن يستسلم — ثوانٍ ضائعة على المستخدم في كل مرة. بالتهدئة
 * يُدفع الثمن مرة واحدة، ثم تُتخطّى النماذج المهدّأة **قبل إرسال أي طلب**.
 *
 * المدد تعكس طبيعة كل فشل لا رقمًا اعتباطيًا:
 *   • 429 rate_limit   — حد عابر  → Retry-After إن وُجد، وإلا 15 دقيقة.
 *   • 404 no_free_model — غياب مزوّد مجاني، حالة بنيوية → 6 ساعات.
 *   • 5xx / timeout     — عطل مزوّد → دقيقتان.
 *   • إكمال فارغ        — النموذج ردّ بلا نص (تفكير بلا إجابة) → دقيقتان.
 *
 * قيد معروف: الحالة في ذاكرة العملية (مثل lib/rate-limit.ts) — لكل نسخة خادم،
 * وتُفقد عند إعادة التشغيل. الكلفة القصوى: محاولة فاشلة واحدة لكل نموذج بعد كل
 * إقلاع. بديلها (تخزين في القاعدة) يعني كتابة عند كل فشل — كلفة أكبر من الفائدة.
 */

export type CooldownReason =
  | "rate_limit"
  | "no_free_model"
  | "provider_error"
  | "empty_completion";

/** المدد بالميلي ثانية — مبنية على طبيعة الفشل */
export const COOLDOWN_MS: Readonly<Record<CooldownReason, number>> = {
  rate_limit: 15 * 60_000, // 15 دقيقة (ما لم يُحدد Retry-After)
  no_free_model: 6 * 60 * 60_000, // 6 ساعات
  provider_error: 2 * 60_000, // دقيقتان
  empty_completion: 2 * 60_000, // دقيقتان — يمنع تكرار الرد الفارغ في كل طلب
};

/** سقف احترازي: لا نثق بـRetry-After بلا حد — قد يصل بقيمة ضخمة */
const RETRY_AFTER_CAP_MS = 6 * 60 * 60_000;

interface Entry {
  until: number;
  reason: CooldownReason;
}

const cooldowns = new Map<string, Entry>();

/**
 * يقرأ Retry-After (ثوانٍ أو تاريخ HTTP) ويحوّله إلى ميلي ثانية.
 * يُرجع null إن غاب أو كان غير صالح — فيقع الاستدعاء على المدة الافتراضية.
 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // صيغة الثواني
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (ms <= 0) return null;
    return Math.min(ms, RETRY_AFTER_CAP_MS);
  }
  // صيغة تاريخ HTTP
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  if (ms <= 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** هل النموذج مهدّأ الآن؟ (انتهاء المدة يُنظّف السجل ويسمح بمحاولة جديدة) */
export function isCoolingDown(model: string, now = Date.now()): boolean {
  const e = cooldowns.get(model);
  if (!e) return false;
  if (e.until <= now) {
    cooldowns.delete(model); // انتهت المدة → محاولة واحدة جديدة تلقائيًا
    return false;
  }
  return true;
}

/** سبب التهدئة النشطة، أو null إن لم يكن مهدّأً */
export function cooldownReason(model: string, now = Date.now()): CooldownReason | null {
  if (!isCoolingDown(model, now)) return null;
  return cooldowns.get(model)?.reason ?? null;
}

/** المتبقي بالميلي ثانية (0 إن لم يكن مهدّأً) */
export function cooldownRemainingMs(model: string, now = Date.now()): number {
  if (!isCoolingDown(model, now)) return 0;
  const e = cooldowns.get(model);
  return e ? Math.max(0, e.until - now) : 0;
}

/**
 * يضع النموذج في تهدئة ويُرجع المدة المطبَّقة (للتسجيل).
 * retryAfterMs يتقدّم على المدة الافتراضية — وهو معنيّ بـ429 وحده.
 * التهدئة الأطول تفوز: لا نُقصّر تهدئة قائمة بفشل أخف.
 */
export function markCooldown(
  model: string,
  reason: CooldownReason,
  retryAfterMs: number | null = null,
  now = Date.now(),
): number {
  const base = reason === "rate_limit" && retryAfterMs !== null ? retryAfterMs : COOLDOWN_MS[reason];
  const until = now + base;
  const existing = cooldowns.get(model);
  if (existing && existing.until > until) return existing.until - now;
  cooldowns.set(model, { until, reason });
  return base;
}

/** لأغراض الاختبار فقط */
export function _resetCooldowns(): void {
  cooldowns.clear();
}
