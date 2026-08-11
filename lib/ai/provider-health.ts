import { cooldownRemainingMs, isCoolingDown, probeGateRemainingMs } from "./model-cooldown";

/**
 * صحة المزوّدين وتوجيه ذكي — تقليل زمن أول رمز بلا كسر النجاح القائم.
 *
 * الحادثة: نجاحٌ حيّ احتاج ~44 ثانية قبل أول نص، لأن السلسلة انتظرت
 * OpenRouter بكامل ميزانيتها قبل الانتقال إلى Groq. والمعالجة ليست تقصير
 * المهل — تلك تقطع نماذج سليمة بطيئة — بل **تقصير الانتظار حين يكون هناك
 * دليل أن المزوّد متدهور**، وإعادته كاملًا متى زال الدليل.
 *
 * الحالة في ذاكرة العملية كالتهدئة تمامًا (`model-cooldown.ts`)، ولا تحمل
 * موجّهًا ولا ردًّا ولا هوية مستخدم: أزمنة وعدّادات ورموز مغلقة.
 *
 * تنبيه على التسمية: في `model-cooldown` مفهوم `probe` يخصّ **النموذج** حين
 * تُهدَّأ السلسلة كلها. وهنا `degraded_probe` يخصّ **المزوّد**. الاسمان
 * منفصلان عمدًا — فخلط معنيين في مصطلح واحد هو ما أضاع تشخيص `fallback_count`.
 */

/** ميزانية السلسلة حين يكون المزوّد الأساسي متدهورًا */
export const SMART_PROBE_BUDGET_MS = 6_000;
/** مدة التدهور قبل الشفاء الذاتي */
export const DEGRADED_WINDOW_MS = 90_000;
/** نافذة تجميع الإخفاقات المتتالية */
export const FAILURE_WINDOW_MS = 60_000;
/** عدد إخفاقات المزوّد الطرفية الموجب للتدهور */
export const CONSECUTIVE_FAILURE_THRESHOLD = 2;
/** نسبة نماذج السلسلة المهدّأة الموجبة للتدهور فورًا */
export const DEGRADED_MODEL_RATIO = 2 / 3;

/**
 * ★ الأخطاء التي تعكس صحة **المزوّد** — تعريف واحد لا تعريفان.
 *
 * وهي بعينها الأخطاء التي تُبرّر تجربة مزوّد آخر: عطلٌ يملك مزوّدٌ مستقل أن
 * ينجح مكانه. أما خطأ الطلب نفسه — غير صالح، سياق أطول من الحدّ، مدخل غير
 * مدعوم، رفض سلامة — فيفشل عند الجميع، فلا يقول شيئًا عن صحة أحد، ولا يجوز
 * أن يُلوّث سجلّها.
 *
 * `auth` و`insufficient_credit` داخلان: كلاهما يُصنَّف `provider_unavailable`
 * وهما عطل حساب المزوّد فعلًا — والمزوّد الآخر بمفتاحه المستقل قد ينجح.
 *
 * وإلغاء المستخدم ليس فشلًا أصلًا فلا يمرّ من هنا (المسار لا يسجّله).
 */
export const PROVIDER_LEVEL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "provider_unavailable",
  "timeout",
  "rate_limit",
  "network_error",
]);

interface Health {
  lastSuccessAt: number;
  lastFailureAt: number;
  /** إخفاقات **الطلب** الطرفية المتتالية — لا محاولات النماذج داخله */
  consecutiveFailures: number;
  /** 0 = غير متدهور. وإلا لحظة الشفاء الذاتي */
  degradedUntil: number;
}

const health = new Map<string, Health>();

function entry(id: string): Health {
  let h = health.get(id);
  if (!h) {
    h = { lastSuccessAt: 0, lastFailureAt: 0, consecutiveFailures: 0, degradedUntil: 0 };
    health.set(id, h);
  }
  return h;
}

function testMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const degradedWindowMs = () => testMs("YSD_TEST_DEGRADED_WINDOW_MS", DEGRADED_WINDOW_MS);
const failureWindowMs = () => testMs("YSD_TEST_FAILURE_WINDOW_MS", FAILURE_WINDOW_MS);

/**
 * نجاح المزوّد ⇒ عافية **فورية**.
 *
 * لا معنى لإبقاء التقنين بعد ثبوت العافية: التدهور تقديرٌ من عيّنة صغيرة،
 * والنجاح دليلٌ قاطع يتقدّم عليه. وبدون هذا يصير أي تدهور كاذب عالقًا —
 * وهو أسوأ من المشكلة التي وُضع التوجيه لحلّها.
 */
export function recordProviderSuccess(id: string, now = Date.now()): void {
  const h = entry(id);
  h.lastSuccessAt = now;
  h.consecutiveFailures = 0;
  h.degradedUntil = 0;
}

/**
 * فشل **طرفي** للمزوّد في طلب واحد — يُسجَّل مرة لكل مزوّد لا لكل نموذج.
 *
 * طلبٌ جرّب ثلاثة نماذج وفشلت كلها هو **فشل مزوّد واحد** لا ثلاثة: النماذج
 * الثلاثة داخل المزوّد نفسه، وعدّها ثلاثًا يجعل طلبًا واحدًا كافيًا للتدهور
 * فيصير الحكم على عيّنة من طلب واحد.
 *
 * والأخطاء غير المتعلقة بالمزوّد تُتجاهَل تمامًا — لا تُصفّر العدّاد ولا تزيده.
 */
export function recordProviderTerminalFailure(
  id: string,
  errorCode: string | null,
  now = Date.now(),
): void {
  if (!errorCode || !PROVIDER_LEVEL_FAILURE_CODES.has(errorCode)) return;

  const h = entry(id);
  // إخفاق خارج النافذة يبدأ عدًّا جديدًا — التتابع شرطه القرب الزمني
  if (h.lastFailureAt > 0 && now - h.lastFailureAt > failureWindowMs()) {
    h.consecutiveFailures = 0;
  }
  h.consecutiveFailures++;
  h.lastFailureAt = now;

  /**
   * ★ `degradedUntil` **لا يتمدّد**.
   *
   * يُضبط عند الدخول وحده. فإخفاق سبرٍ متدهور لاحق لا يُطيل المدة، وإلا
   * لَبقي المزوّد محبوسًا في ٦ ثوانٍ إلى الأبد: كل سبر يفشل فيمدّد، فلا
   * يحصل على فرصة كاملة أبدًا حتى لو تعافى وصار أبطأ من ٦ ثوانٍ فقط.
   */
  if (h.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD && h.degradedUntil <= now) {
    h.degradedUntil = now + degradedWindowMs();
  }
}

/** هل المزوّد متدهور الآن؟ (انقضاء المدة يشفيه تلقائيًا بلا أي طلب) */
export function isProviderDegraded(id: string, now = Date.now()): boolean {
  const h = health.get(id);
  return Boolean(h && h.degradedUntil > now);
}

/** المتبقي على الشفاء الذاتي — للتسجيل والاختبار (0 = سليم) */
export function degradedRemainingMs(id: string, now = Date.now()): number {
  const h = health.get(id);
  return h ? Math.max(0, h.degradedUntil - now) : 0;
}

/** عدّاد الإخفاقات الطرفية — للاختبار والتشخيص */
export function consecutiveFailures(id: string): number {
  return health.get(id)?.consecutiveFailures ?? 0;
}

export type RoutingDecision = "healthy" | "degraded_probe" | "skip_openrouter";

export interface Routing {
  /** ترتيب المزوّدين كما يجرّبهم المسار */
  order: string[];
  /** ميزانية المزوّد الأول — `undefined` تعني حدوده الكاملة */
  primaryBudgetMs: number | undefined;
  decision: RoutingDecision;
  /** نسبة نماذج السلسلة المهدّأة — رقم للتسجيل */
  cooledRatio: number;
}

/**
 * يقرّر ترتيب المزوّدين وميزانية الأول.
 *
 * ثلاث قواعد صريحة لا درجة عائمة: الدرجة تُخفي **سبب** القرار، والقواعد
 * تُقرأ وتُختبر ويظهر أثرها في السجل مباشرةً.
 */
export function decideProviderRouting(params: {
  primaryId: string;
  fallbackId: string | null;
  chain: readonly string[];
  now?: number;
}): Routing {
  const { primaryId, fallbackId, chain } = params;
  const now = params.now ?? Date.now();

  const cooled = chain.filter((m) => isCoolingDown(m, now)).length;
  const cooledRatio = chain.length > 0 ? cooled / chain.length : 0;

  /**
   * ★ الاحتياط «صالح» = مُهيّأ **وغير متدهور**.
   *
   * فإن لم يكن كذلك فلا يجوز تقصير المزوّد الأساسي إلى ٦ ثوانٍ: سنكون قد
   * قصّرنا الوحيد الموثوق لصالح مزوّد لا نثق به — أي صنعنا مسارًا بلا مزوّد
   * موثوق. حينها يأخذ الأساسي حدوده كاملة، ويبقى الاحتياط آخر الترتيب على
   * أمل أن ينجح، فلا نخسر شيئًا كان قائمًا.
   */
  const fallbackUsable = Boolean(fallbackId) && !isProviderDegraded(fallbackId!, now);

  const allCooledAndGated =
    chain.length > 0 && cooled === chain.length && probeGateRemainingMs(now) > 0;

  const degraded = isProviderDegraded(primaryId, now) || cooledRatio >= DEGRADED_MODEL_RATIO;

  // (١) لا مرشّح صالح في الأساسي، وبوابة السبر مغلقة ⇒ الاحتياط وحده
  if (fallbackUsable && allCooledAndGated) {
    return {
      order: [fallbackId!],
      primaryBudgetMs: undefined,
      decision: "skip_openrouter",
      cooledRatio,
    };
  }

  // (٢) الأساسي متدهور والاحتياط صالح ⇒ سبرٌ قصير ثم الاحتياط
  if (fallbackUsable && degraded) {
    return {
      order: [primaryId, fallbackId!],
      primaryBudgetMs: SMART_PROBE_BUDGET_MS,
      decision: "degraded_probe",
      cooledRatio,
    };
  }

  // (٣) الحالة الصحية — وأيضًا حالة الاحتياط غير الصالح: حدود كاملة
  return {
    order: fallbackId ? [primaryId, fallbackId] : [primaryId],
    primaryBudgetMs: undefined,
    decision: "healthy",
    cooledRatio,
  };
}

/** أقرب تعافٍ متوقّع في السلسلة — للتسجيل الآمن فقط */
export function soonestCooldownMs(chain: readonly string[], now = Date.now()): number {
  if (chain.length === 0) return 0;
  return Math.min(...chain.map((m) => cooldownRemainingMs(m, now)));
}

/** لأغراض الاختبار فقط */
export function _resetProviderHealth(): void {
  health.clear();
}
