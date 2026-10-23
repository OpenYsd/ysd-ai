import "server-only";

/**
 * بوابة النماذج — طبقة رقيقة فوق lib/ai، لا بديل عنه.
 *
 * ── ما تفعله ──
 *
 *   1. تصف كل نموذج **متاح فعلًا**: مزوّده مهيّأ (`isConfigured`)، ويجوز اختياره
 *      (`userSelectable !== false`)، والنموذج مفعَّل (`enabled`). ما عدا ذلك لا
 *      يُعرض أصلًا — فلا يظهر نموذجٌ سيفشل بعد الإرسال.
 *   2. تحدّد ما يقبله النموذج وما يُخرجه وقدراته، من إعلان المزوّد وحده.
 *   3. تطبّق خطة المستخدم على القائمة (المقفول يُعرض بشارة ولا يُختار).
 *
 * ── ما لا تفعله ──
 *
 * لا تشغّل نموذجًا ولا تختار مزوّدًا ولا تفترض أسماء نماذج YSD أو عناوينها: ذلك
 * كله في lib/ai (registry وresolver وysd) كما هو. وقائمة الدردشة تبقى مطابقة
 * تمامًا لما كانت تبنيه الصفحات من listModelOptions + سياسة النماذج.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getConfiguredProviders, listModelOptions, type ModelOption } from "@/lib/ai/registry";
import { loadModelPolicy, tierAllows } from "@/lib/ai/model-policy";
import type { AIProviderAdapter, ModelInfo } from "@/lib/ai/types";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  type ModelDescriptor,
  type PickerModel,
} from "./contracts";

function describe(provider: AIProviderAdapter, model: ModelInfo): ModelDescriptor {
  return {
    id: model.id,
    providerId: provider.id,
    providerName: provider.displayName,
    nameAr: model.displayNameAr,
    nameEn: model.displayNameEn,
    contextWindow: model.contextWindow,
    input: model.inputModalities?.length ? [...model.inputModalities] : DEFAULT_INPUT,
    output: model.outputModalities?.length ? [...model.outputModalities] : DEFAULT_OUTPUT,
    capabilities: { streaming: provider.supportsStreaming !== false },
  };
}

/** كل نموذج متاح للاختيار الآن، بترتيب المزوّدين في السجلّ */
export function describeAvailableModels(
  providers: readonly AIProviderAdapter[] = getConfiguredProviders(),
): ModelDescriptor[] {
  return providers
    .filter((p) => p.isConfigured() && p.userSelectable !== false)
    .flatMap((p) => p.listModels().filter((m) => m.enabled).map((m) => describe(p, m)));
}

/** وسم القائمة بخطة المستخدم — ما يظهر يطابق ما يقبله /api/chat */
export function applyTierPolicy(
  options: readonly ModelOption[],
  policy: { userTier: string; models: readonly { id: string; min_tier: string }[] },
): PickerModel[] {
  const minTierById = new Map(policy.models.map((m) => [m.id, m.min_tier]));
  return options.map((o) => {
    const minTier = minTierById.get(o.id) ?? "free";
    return { ...o, minTier, locked: !tierAllows(policy.userTier, minTier) };
  });
}

/** قائمة منتقي النموذج لهذا المستخدم — مصدر الصفحتين chat وchat/[id] */
export async function listModelsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<PickerModel[]> {
  const policy = await loadModelPolicy(supabase, userId);
  return applyTierPolicy(listModelOptions(), policy);
}
