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

// ════════════════════════════════════════════════════════════
//  بوابة السبر — معدّل السبر لا يحدده عدد المستخدمين
// ════════════════════════════════════════════════════════════

/**
 * حين تُهدَّأ كل النماذج نسمح بسبر واحد كي لا تنهار الخدمة. لكن «واحد لكل
 * طلب» يجعل معدّل السبر تابعًا لحركة المستخدمين: مئة طلب متزامن = مئة سبر
 * على مزوّد أعلن للتو أنه غير قادر — وهو الطَّرق الذي وُضعت التهدئة لمنعه.
 *
 * البوابة تفصل الأمرين: السبر يجري **بالوقت** لا بالطلبات. نافذة واحدة،
 * سبر واحد، ومَن جاء داخلها يفشل سريعًا بلا نداء.
 *
 * ثلاثون ثانية: أقصر بكثير من أقصر تهدئة (دقيقتان) فيُلتقط التعافي بسرعة،
 * وطويلة بما يكفي ليبقى الحد الأقصى نداءين في الدقيقة مهما بلغ الحمل.
 */
export const PROBE_GATE_MS = 30_000;

function probeGateMs(): number {
  // 0 = بوابة مفتوحة دائمًا — للاختبارات التي تقيس الاختيار لا التقنين
  const override = Number(process.env.YSD_TEST_PROBE_GATE_MS);
  return Number.isFinite(override) && override >= 0 ? override : PROBE_GATE_MS;
}

/** حالة البوابة — لعملية واحدة، مثل التهدئة نفسها */
const probeGate = { nextAllowedAt: 0, inFlight: false };

/**
 * يحجز حق السبر ويُرجع النموذج المُختار، أو `null` إن كانت البوابة مغلقة.
 *
 * الحجز **متزامن بالكامل**: لا `await` بين الفحص والضبط، وحلقة أحداث
 * جافاسكربت واحدة لا تُقاطَع بينهما. فطلبان متزامنان في العملية نفسها لا
 * يمكن أن يفوزا معًا مهما كان ترتيبهما.
 */
export function acquireProbeSlot(chain: readonly string[], now = Date.now()): string | null {
  if (probeGate.inFlight) return null;
  if (now < probeGate.nextAllowedAt) return null;
  if (chain.length === 0) return null;

  /**
   * لقطة واحدة للمُدد **قبل** المقارنة — لا قياس داخلها.
   *
   * المدة مشتقّة من الساعة، فقياسها داخل مُقارِن الفرز يجعل المفتاح يتحرّك
   * أثناء الفرز: مُدد تفصلها ميلي ثانية تنقلب ترتيبًا بين مقارنتين، فيُخالَف
   * عقد المُقارِن ويصير الناتج غير حتمي — نقيض المطلوب هنا بالذات.
   * و`<` الصارمة تُبقي الأول عند التساوي، فالمتساويان يُحسمان بترتيب السلسلة.
   */
  const measured = chain.map((m) => ({ model: m, remainingMs: cooldownRemainingMs(m, now) }));
  const soonest = measured.reduce((best, cur) => (cur.remainingMs < best.remainingMs ? cur : best));

  probeGate.inFlight = true;
  // تُضبط عند الحجز أيضًا: سبرٌ يُهجَر بلا تحرير لا يُبقي البوابة مفتوحة أبدًا
  probeGate.nextAllowedAt = now + probeGateMs();
  return soonest.model;
}

/**
 * يُحرّر حق السبر.
 *
 * نجاح ⇒ النموذج أثبت عمله، فتُرفع تهدئته وتُفتح البوابة: لا معنى لإبقاء
 * الخدمة في وضع السبر بعد أن ثبت أن هناك طريقًا سالكًا.
 * فشل ⇒ التهدئة تُعاد بمسار الفشل المعتاد، والبوابة تُغلق نافذةً كاملة.
 */
export function releaseProbeSlot(model: string, succeeded: boolean, now = Date.now()): void {
  probeGate.inFlight = false;
  if (succeeded) {
    cooldowns.delete(model);
    probeGate.nextAllowedAt = 0;
    return;
  }
  probeGate.nextAllowedAt = now + probeGateMs();
}

/** المتبقي على فتح البوابة — للتسجيل والرسالة الصادقة (0 = مفتوحة) */
export function probeGateRemainingMs(now = Date.now()): number {
  return Math.max(0, probeGate.nextAllowedAt - now);
}

/** لأغراض الاختبار فقط */
export function _resetCooldowns(): void {
  cooldowns.clear();
  probeGate.nextAllowedAt = 0;
  probeGate.inFlight = false;
}
