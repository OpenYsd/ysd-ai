import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";

/**
 * بوابة الخطة على النماذج — **تُفرض على الخادم** (v0.8.1).
 *
 * ── الثغرة التي تسدّها ──
 *
 * `ai_models.min_tier` موجود منذ 0001 ولم يكن يُقرأ في أي شيفرة: عمودٌ يوثّق
 * نيّةً لا يفرضها أحد. وكان `claude-sonnet-4-6` — نموذج Anthropic مدفوع
 * بالكامل — على `min_tier = 'free'`، فكل مشترك مجاني يستطيع اختياره. الكلفة
 * تقع علينا كاملةً بلا سقف ولا مقابل.
 *
 * ── لماذا لا يُصدَّق النموذج القادم من العميل ──
 *
 * الواجهة ترشّح القائمة، لكن الترشيح في الواجهة تجميل لا حراسة: الطلب يُصاغ
 * يدويًا بسطر واحد. فالخادم لا يسأل «ما النموذج الذي أرسله؟» بل «ما النموذج
 * الذي تسمح به خطته؟» — ويعيد الحلّ من `subscriptions.tier` في كل طلب.
 *
 * ── التخفيض لا الرفض ──
 *
 * من طلب ما لا تبلغه خطته يُخفَّض إلى `ysd/free` بدل أن يُرفض طلبه. المحادثة
 * تستمر، والكلفة لا تقع. والرفض كان سيبدو عطلًا للمستخدم الذي ورث `model_id`
 * قديمًا في محادثة أنشأها قبل تشديد الخطة — وهو لم يفعل شيئًا.
 */

export type PlanTier = "free" | "plus" | "pro" | "business";

/** الترتيب هو العقد: أي مقارنة خطط تمرّ من هنا لا بمقارنة نصوص */
const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  plus: 1,
  pro: 2,
  business: 3,
};

export function tierRank(tier: string | null | undefined): number {
  return TIER_RANK[(tier ?? "free") as PlanTier] ?? 0;
}

/** هل تبلغ خطةُ المستخدم الحدَّ الأدنى للنموذج؟ */
export function tierAllows(userTier: string | null | undefined, minTier: string | null | undefined): boolean {
  return tierRank(userTier) >= tierRank(minTier);
}

export interface ModelPolicyRow {
  id: string;
  min_tier: string;
  enabled: boolean;
}

export interface ResolvedModel {
  /** النموذج الذي **سيُستعمل فعلًا** — لا الذي طُلب. `null` عند الرفض */
  modelId: string | null;
  /** هل خُفِّض عن المطلوب؟ */
  downgraded: boolean;
  /** هل يُرفض الطلب رأسًا بلا بديل؟ */
  rejected: boolean;
  /** رمز من مجموعة مغلقة — لا نصّ حرّ ولا اسم جدول */
  reason: "ok" | "tier_too_low" | "model_disabled" | "model_unknown";
  /** سقف رموز الإخراج لهذه الخطة */
  maxOutputTokens: number;
}

/**
 * رسالة التخفيض — تُعرض للمستخدم كما هي.
 *
 * الصمت هنا كان عيبًا حقيقيًا: من اختار Claude ثم رأى ردًّا من نموذج آخر بلا
 * تفسير يظنّ المنصّة معطوبة، لا أن خطته لا تشمله.
 */
export const TIER_DOWNGRADE_MESSAGE =
  "هذا النموذج يتطلب خطة Plus، تم استخدام YSD مجاني.";

/** سقف افتراضي حين تتعذّر قراءة الحدود — الأقلّ كلفةً لا الأكثر */
export const FALLBACK_MAX_OUTPUT_TOKENS = 1024;

/**
 * يقرّر النموذج الفعلي لهذا المستخدم.
 *
 * نقي وبلا أثر جانبي كي يُختبر مباشرةً: كل ما يحتاجه يصله معطىً.
 */
export function resolveModelForUser(input: {
  requestedModelId: string;
  userTier: string | null | undefined;
  models: ModelPolicyRow[];
  maxOutputTokens: number;
}): ResolvedModel {
  const { requestedModelId, userTier, models, maxOutputTokens } = input;
  const cap = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? maxOutputTokens
    : FALLBACK_MAX_OUTPUT_TOKENS;

  const row = models.find((m) => m.id === requestedModelId);

  /**
   * **المجهول والمعطَّل يُرفضان، ولا يُحوَّلان صامتًا.**
   *
   * التحويل الصامت كان خطأً: معرّفٌ لا نعرفه يعني إمّا طلبًا مُلفَّقًا وإمّا
   * خللًا في العميل، وكلاهما يستحق أن يُقال. وتمريره تحت اسم آخر يُخفي
   * الحالتين ويُنتج ردًّا لا يفهم المستخدم من أين جاء.
   *
   * والسقوط إلى البديل محفوظ لحالةٍ واحدة مشروعة: نموذجٌ **معروف ومفعّل**
   * لا تبلغه خطة المستخدم. هذه وحدها لها معنى عند المستخدم ورسالةٌ تشرحها.
   */
  if (!row) {
    return { modelId: null, downgraded: false, rejected: true, reason: "model_unknown", maxOutputTokens: cap };
  }
  if (!row.enabled) {
    return { modelId: null, downgraded: false, rejected: true, reason: "model_disabled", maxOutputTokens: cap };
  }
  if (!tierAllows(userTier, row.min_tier)) {
    return {
      modelId: YSD_FREE_MODEL_ID,
      downgraded: true,
      rejected: false,
      reason: "tier_too_low",
      maxOutputTokens: cap,
    };
  }
  return {
    modelId: requestedModelId,
    downgraded: false,
    rejected: false,
    reason: "ok",
    maxOutputTokens: cap,
  };
}

/** النماذج التي تتجاوز خطة المستخدم — للواجهة كي تعرضها مقفولة لا مخفية */
export function lockedModelIds(models: ModelPolicyRow[], userTier: string | null | undefined): string[] {
  return models
    .filter((m) => m.enabled && !tierAllows(userTier, m.min_tier))
    .map((m) => m.id);
}

/**
 * يقرأ ما تحتاجه البوابة من القاعدة: خطة المستخدم، وسقف الإخراج، وصفوف النماذج.
 *
 * قراءة واحدة متوازية لكل طلب. ولو تعثّرت أي منها نسقط إلى الأشدّ تحفّظًا:
 * خطة `free` وسقفٌ أدنى — فالعطل لا يفتح بابًا.
 */
/**
 * قياس مرحلتَي القراءة — **أرقام فقط**، تُملأ في مكانها.
 *
 * الحقل اختياريّ عمدًا: المستدعي الذي لا يمرّره لا يتغيّر سلوكه بحرف، ولا
 * يتغيّر عقد الدالة ولا ناتجها ولا ترتيب استعلاماتها.
 */
export interface ModelPolicyTimings {
  /** الرحلة الأولى: الاشتراك وصفوف النماذج معًا (متوازيتان) */
  primaryMs: number;
  /** الرحلة الثانية: حدود الطبقة — **تابعة** لنتيجة الأولى */
  limitsMs: number;
}

export const emptyModelPolicyTimings = (): ModelPolicyTimings => ({
  primaryMs: 0,
  limitsMs: 0,
});

export async function loadModelPolicy(
  supabase: SupabaseClient,
  userId: string,
  timings?: ModelPolicyTimings,
): Promise<{ userTier: PlanTier; models: ModelPolicyRow[]; maxOutputTokens: number }> {
  /**
   * ★ الرحلات الثلاث معًا — والاختيار محليّ بعدها.
   *
   * ── ما كان ──
   *
   * كانت `usage_limits` رحلةً **تابعة**: تنتظر `userTier` من الأولى ثم
   * تسأل `.eq("tier", userTier)`. قِيس حيًّا أن ذلك يكلّف **128 مل** على
   * المسار الحرج (`model_policy_ms=273` منها `primary=145`).
   *
   * ── ولماذا التكافؤ تامّ ──
   *
   * `tier` **مفتاح أساسيّ** في `usage_limits` — فالجدول صفٌّ واحد لكل طبقة،
   * وعددها ثابت صغير. فجلبُه كاملًا ثم انتقاء الصفّ محليًّا يُعطي عين ما
   * كان يُعطيه الفلتر: لا صفّ مكرّر ممكن، ولا ترتيب يؤثّر.
   *
   * وكل الطبقات مدعومة كما كانت — الانتقاء بـ`userTier` أيًّا كانت قيمته،
   * لا بافتراض `free`.
   */
  const tPrimary = Date.now();
  const [subRes, modelsRes, limitsRes] = await Promise.all([
    supabase.from("subscriptions").select("tier").eq("user_id", userId).maybeSingle(),
    supabase.from("ai_models").select("id, min_tier, enabled"),
    supabase.from("usage_limits").select("tier, max_output_tokens"),
  ]);
  if (timings) timings.primaryMs = Date.now() - tPrimary;

  const userTier = (subRes.data?.tier ?? "free") as PlanTier;

  /**
   * ★ لم تعد رحلةً — صار انتقاءً في الذاكرة.
   *
   * ويبقى الحقل مقيسًا لا مصفَّرًا بالثابت: قيمةٌ قريبة من الصفر تقول
   * «لا رحلة ثانية هنا» بصدق، بينما صفرٌ مكتوب يدويًّا يقول الشيء نفسه
   * بلا دليل. والقياس هو ما نثق به لا التعليق.
   */
  const tLimits = Date.now();
  const limitsRow = (
    (limitsRes.data ?? []) as { tier: string | null; max_output_tokens: unknown }[]
  ).find((r) => r.tier === userTier);
  if (timings) timings.limitsMs = Date.now() - tLimits;

  const raw = limitsRow?.max_output_tokens;
  const maxOutputTokens =
    typeof raw === "number" && raw > 0 ? raw : FALLBACK_MAX_OUTPUT_TOKENS;

  return {
    userTier,
    models: (modelsRes.data ?? []) as ModelPolicyRow[],
    maxOutputTokens,
  };
}
