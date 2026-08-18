import "server-only";

import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "./ysd";
import { isYSDAlphaActivationEnabled } from "./ysd-activation";
import { readYSDRuntimeConfig } from "./ysd-runtime-config";
import { getConfiguredProviders } from "./registry";
import { getAdminClient } from "@/lib/supabase/admin";
import type { AIProviderAdapter } from "./types";

/**
 * تسجيل إصدار YSD في السجلّ (v0.9.3، الرقعة العاشرة).
 *
 * ── الحلقة التي تفكّها ──
 *
 * `healthCheck` لا يقول «متصل» بلا نشرةٍ نشطة لنسخةٍ معتمدة، والرقعة
 * التاسعة لا تفتح أهليّة القاعدة بلا «متصل». فبلا هذه الخطوة يستحيل
 * الوصول إلى أيّهما — لا نشرة ⇐ لا فحص ⇐ لا أهليّة ⇐ ولا طريق إلى نشرة.
 *
 * ── ولذلك لا يُشترط الفحص هنا ──
 *
 * وذلك **مقصود**، لا سهو. اشتراطُ «متصل» قبل تسجيل النشرة يصنع شرطًا
 * دائريًّا لا مخرج منه. فالتسلسل: تُسجَّل النشرة هنا، فيصير للفحص ما
 * يفحصه، فتُفتح الأهليّة بعده في مسارٍ آخر.
 *
 *   السجلّ جاهز  ≠  مؤهَّلٌ في القاعدة  ≠  مفتوحٌ للناس.
 *
 * ── وما لا يستقبله ──
 *
 * `environment` و`endpointAlias` لا يأتيان من الطلب إطلاقًا: يُقرآن من
 * إعداد الخادم. ولو جاءا من جسم طلبٍ لَأمكن تسجيل نشرةٍ لبيئةٍ لا يخدمها
 * هذا الخادم — فيقول الفحص «لا نشرة» ولا يفهم أحدٌ لماذا. والأسوأ: اسمٌ
 * مستعار مخالف يجعل بوابة الثقة ترفض كل نداء بعد ذلك بلا سببٍ ظاهر.
 *
 * وبديهيًّا: لا عنوان ولا مفتاح. تلك لا تدخل السجلّ أصلًا.
 */

export type YSDReleaseStageResult =
  | { ok: true; alreadyStaged: boolean }
  | {
      ok: false;
      reason:
        | "owner_required"
        | "kill_switch_must_be_off"
        | "not_configured"
        | "provider_not_configured"
        | "invalid_input"
        | "admin_client_unavailable"
        | "model_not_found"
        | "model_gate_must_be_off"
        | "version_conflict"
        | "database_error";
    };

const fail = (reason: Exclude<YSDReleaseStageResult, { ok: true }>["reason"]) =>
  ({ ok: false, reason }) as const;

/** ما يقدّمه المشغّل — ولا شيء منه يصف **أين** نتصل */
export interface YSDReleaseInput {
  version: string;
  baseModelRef?: string | null;
  artifactRef: string;
  runtimeModel: string;
}

export interface YSDReleaseDependencies {
  isKillSwitchOn: () => boolean;
  readRuntimeConfig: typeof readYSDRuntimeConfig;
  listConfiguredProviders: () => AIProviderAdapter[];
  getAdminClient: typeof getAdminClient;
}

const DEFAULTS: YSDReleaseDependencies = {
  isKillSwitchOn: () => isYSDAlphaActivationEnabled(),
  readRuntimeConfig: readYSDRuntimeConfig,
  listConfiguredProviders: getConfiguredProviders,
  getAdminClient,
};

/** رموز الدالة الخادمية — تُقابَل بأسبابٍ مغلقة، ولا نصّ يعبر منها */
const RPC_REASONS: Record<string, Exclude<YSDReleaseStageResult, { ok: true }>["reason"]> = {
  invalid_input: "invalid_input",
  model_not_found: "model_not_found",
  model_gate_must_be_off: "model_gate_must_be_off",
  version_conflict: "version_conflict",
};

const MAX_VERSION = 64;
const MAX_REF = 256;

/**
 * ★ معرّف وقت التشغيل ليس عنوانًا — والحارس **دلاليّ لا هشّ**.
 *
 * الخطر أن يُكتب عنوانٌ في حقلٍ يُخزَّن ثم يُمرَّر يومًا إلى جهةٍ تبنيه
 * وجهةَ اتصال. فيُرفض ما يبدو عنوانًا فعلًا: مخطَّطٌ ثم `://`، أو
 * `//مضيف` بروتوكوليّ نسبيّ.
 *
 * ولا يُمنع `/` ولا `:` بعمومهما: `org/model-name` معرّفٌ شائع في
 * مستودعات النماذج، و`hf:model-name` كذلك. وحارسٌ يمنعهما يرفض أسماءً
 * مشروعة كل يوم فيُلتَفّ عليه — والحارس الذي يُزعج بلا سبب يُحذف.
 */
const URL_LIKE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/;

/**
 * ★ يسجّل النسخة والنشرة — ولا يفعّل شيئًا.
 *
 * @param isOwner من سياق الإدارة. لا تُقرأ الأدوار هنا: المستدعي أثبت
 *   الهوية سلفًا، وإعادةُ التحقّق من مكانٍ ثانٍ تخلق مصدرين للحقيقة.
 */
export async function stageYSDRelease(
  isOwner: boolean,
  input: YSDReleaseInput,
  deps: Partial<YSDReleaseDependencies> = {},
): Promise<YSDReleaseStageResult> {
  const d = { ...DEFAULTS, ...deps };

  /**
   * ★ (١) المالك وحده.
   *
   * اختيارُ النتاج الذي يخدم النموذج قرارٌ أعمق من إشرافٍ يوميّ: هو
   * تحديد **ما هو** النموذج، لا متى يُفتح.
   */
  if (isOwner !== true) return fail("owner_required");

  /**
   * ★ (٢) والمفتاح مغلق.
   *
   * تبديلُ النتاج والخدمةُ مفتوحة يعني محادثةً تبدأ على نسخةٍ وتنتهي على
   * أخرى، ورصدًا ينسب الردّ إلى نشرةٍ لم تكتبه.
   */
  if (d.isKillSwitchOn()) return fail("kill_switch_must_be_off");

  // ★ (٣) والهدف يُقرأ من إعداد الخادم — لا من الطلب
  const configResult = d.readRuntimeConfig();
  if (!configResult.ok) return fail("not_configured");
  const config = configResult.config;

  // ★ (٤) والمزوّد مهيّأ — وإلا سجّلنا إصدارًا لخادمٍ لا يستطيع خدمته
  const provider = d.listConfiguredProviders().find((p) => p.id === YSD_PROVIDER_ID);
  if (!provider) return fail("provider_not_configured");

  /**
   * ★ (٥) ولا فحص جاهزية هنا — الشرح أعلى الملفّ.
   *
   * فهذه الخطوة تُنشئ ما سيفحصه الفاحص. واشتراطُه هنا حلقةٌ مغلقة.
   */

  const version = input.version?.trim() ?? "";
  const artifactRef = input.artifactRef?.trim() ?? "";
  const runtimeModel = input.runtimeModel?.trim() ?? "";
  const baseModelRef = input.baseModelRef?.trim() || null;

  if (version.length === 0 || version.length > MAX_VERSION) return fail("invalid_input");
  if (artifactRef.length === 0 || artifactRef.length > MAX_REF) return fail("invalid_input");
  if (runtimeModel.length === 0 || runtimeModel.length > MAX_REF) return fail("invalid_input");
  if (baseModelRef !== null && baseModelRef.length > MAX_REF) return fail("invalid_input");
  /**
   * ★ ومعرّف وقت التشغيل ليس المعرّف المنطقيّ.
   *
   * `ysd/model-alpha` اسمٌ يراه المستخدم، و`runtime_model` نتاجٌ يحمله
   * الخادم. وخلطهما ينتج نشرةً تطلب من وقت التشغيل اسمًا لا يعرفه.
   */
  if (runtimeModel === YSD_ALPHA_MODEL_ID) return fail("invalid_input");
  // ★ ولا يكون عنوانًا — انظر `URL_LIKE` أعلاه
  if (URL_LIKE.test(runtimeModel)) return fail("invalid_input");

  let admin;
  try {
    admin = d.getAdminClient();
  } catch {
    return fail("admin_client_unavailable");
  }
  if (!admin) return fail("admin_client_unavailable");

  let code: string;
  try {
    const { data, error } = await admin.rpc("ysd_stage_release", {
      p_version: version,
      p_base_model_ref: baseModelRef,
      p_artifact_ref: artifactRef,
      // ★ من الإعداد، لا من الطلب
      p_environment: config.deploymentEnvironment,
      p_endpoint_alias: config.endpointAlias,
      p_runtime_model: runtimeModel,
    });
    // خطأ القاعدة يُبتلع رمزًا: نصُّه يصف الجداول لمن يقرأ الشاشة
    if (error) return fail("database_error");
    code = String(data);
  } catch {
    return fail("database_error");
  }

  if (code === "ok") return { ok: true, alreadyStaged: false };
  if (code === "already_staged") return { ok: true, alreadyStaged: true };

  return fail(RPC_REASONS[code] ?? "database_error");
}
