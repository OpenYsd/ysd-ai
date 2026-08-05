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
  /** النموذج الذي **سيُستعمل فعلًا** — لا الذي طُلب */
  modelId: string;
  /** هل خُفِّض عن المطلوب؟ */
  downgraded: boolean;
  /** رمز من مجموعة مغلقة — لا نصّ حرّ ولا اسم جدول */
  reason: "ok" | "tier_too_low" | "model_disabled" | "model_unknown";
  /** سقف رموز الإخراج لهذه الخطة */
  maxOutputTokens: number;
}

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
   * نموذج لا نعرفه: قد يكون معرّفًا ملفّقًا في طلب يدوي، وقد يكون نموذجًا
   * حُذف من الجدول ومحادثةٌ قديمة ما زالت تحمل اسمه. الحالتان تُعاملان
   * معاملةً واحدة — لا نُسقط الطلب على مجهول ولا نُمرّره.
   */
  if (!row) {
    return { modelId: YSD_FREE_MODEL_ID, downgraded: true, reason: "model_unknown", maxOutputTokens: cap };
  }
  if (!row.enabled) {
    return { modelId: YSD_FREE_MODEL_ID, downgraded: true, reason: "model_disabled", maxOutputTokens: cap };
  }
  if (!tierAllows(userTier, row.min_tier)) {
    return { modelId: YSD_FREE_MODEL_ID, downgraded: true, reason: "tier_too_low", maxOutputTokens: cap };
  }
  return { modelId: requestedModelId, downgraded: false, reason: "ok", maxOutputTokens: cap };
}

/**
 * يقرأ ما تحتاجه البوابة من القاعدة: خطة المستخدم، وسقف الإخراج، وصفوف النماذج.
 *
 * قراءة واحدة متوازية لكل طلب. ولو تعثّرت أي منها نسقط إلى الأشدّ تحفّظًا:
 * خطة `free` وسقفٌ أدنى — فالعطل لا يفتح بابًا.
 */
export async function loadModelPolicy(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ userTier: PlanTier; models: ModelPolicyRow[]; maxOutputTokens: number }> {
  const [subRes, modelsRes] = await Promise.all([
    supabase.from("subscriptions").select("tier").eq("user_id", userId).maybeSingle(),
    supabase.from("ai_models").select("id, min_tier, enabled"),
  ]);

  const userTier = (subRes.data?.tier ?? "free") as PlanTier;

  const limitsRes = await supabase
    .from("usage_limits")
    .select("max_output_tokens")
    .eq("tier", userTier)
    .maybeSingle();

  const raw = limitsRes.data?.max_output_tokens;
  const maxOutputTokens =
    typeof raw === "number" && raw > 0 ? raw : FALLBACK_MAX_OUTPUT_TOKENS;

  return {
    userTier,
    models: (modelsRes.data ?? []) as ModelPolicyRow[],
    maxOutputTokens,
  };
}
