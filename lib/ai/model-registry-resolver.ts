import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isServableDeployment,
  type DeploymentEnvironment,
  type DeploymentStatus,
  type ModelDeploymentRecord,
  type ModelVersionRecord,
  type ModelVersionStatus,
} from "./model-registry";

/**
 * حلّال نشرات YSD — **يفشل مغلقًا** (v0.9.3، الرقعة الثالثة).
 *
 * ── سؤال واحد ──
 *
 * «ما النشرة الصالحة للخدمة الآن لهذا النموذج المنطقيّ في هذه البيئة؟»
 *
 *   المعرّف المنطقيّ → نشرة نشطة → النسخة بعينها → تحقّق → صالحة للخدمة
 *
 * ولا يتصل بنموذج ولا يقرأ بيئة ولا ينشئ عميلًا: العميل **يُحقن**، فيبقى
 * قابلًا للاختبار كاملًا بلا شبكة ولا أسرار.
 *
 * ── ولماذا لا يثق بالقاعدة ──
 *
 * الترحيلة 0036 تفرض المرجع المركّب والفهرس الجزئيّ والقيود. لكن الحلّال
 * **حدُّ ثقةٍ مستقلّ**: قد يعمل على قاعدة لم تُرحَّل بعد، أو على صفٍّ كُتب
 * بصلاحية عالية تجاوزت الطبقات، أو على نسخة قديمة من المخطط. فكل ما
 * تفرضه القاعدة يُفحص هنا ثانيةً — لا تكرارًا بل حراسةً لحدٍّ آخر.
 *
 * وأخطر ما يمنعه: نشرةٌ نشطة تشير إلى نسخة **مرشّحة**. القاعدة اليوم
 * تسمح بها (لا قيد يربط حالة النشرة بحالة النسخة)، والحلّال يرفضها.
 */

/** ما يُعاد عند تعذّر الحلّ — رموز مغلقة، بلا أي تفصيل من القاعدة */
export type ResolutionFailureReason =
  | "invalid_input"
  | "registry_error"
  | "no_active_deployment"
  | "ambiguous_active_deployment"
  | "version_not_found"
  | "invalid_record"
  | "not_servable";

export type ServableDeploymentResolution =
  | { ok: true; deployment: ModelDeploymentRecord; version: ModelVersionRecord }
  | { ok: false; reason: ResolutionFailureReason };

const fail = (reason: ResolutionFailureReason): ServableDeploymentResolution => ({
  ok: false,
  reason,
});

/**
 * حدّ محافظ لطول المعرّف.
 *
 * أطول معرّف قائم اليوم دون ثلاثين محرفًا، ومئةٌ وثمانية وعشرون هامشٌ
 * واسع. والغرض منع مدخلٍ ضخم من الوصول إلى القاعدة أصلًا.
 */
const MAX_MODEL_ID_LENGTH = 128;

const ENVIRONMENTS: readonly DeploymentEnvironment[] = [
  "development",
  "staging",
  "production",
];

const VERSION_STATUSES: readonly ModelVersionStatus[] = [
  "draft",
  "candidate",
  "approved",
  "retired",
];

const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "inactive",
  "active",
  "failed",
  "retired",
];

/** أعمدة صريحة — لا `*`: عمودٌ يُضاف لاحقًا لا يجب أن يتسرّب بلا قصد */
const DEPLOYMENT_COLUMNS =
  "id, model_id, model_version_id, environment, status, endpoint_alias, runtime_model, created_at, activated_at, retired_at";

const VERSION_COLUMNS =
  "id, model_id, version, status, base_model_ref, artifact_ref, created_at, approved_at, retired_at";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/** يقبل النصّ أو `null` ويرفض ما عداهما — للأعمدة القابلة للغياب */
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

/**
 * ★ تحويل الصفّ بتحقّق — لا `as` أعمى.
 *
 * تحويلُ نوعٍ بالتأكيد يخبر المُترجم بما نتمنّاه لا بما وصل. وصفٌّ ناقص
 * حقلًا يمرّ عندئذٍ إلى منطق الخدمة فينكسر بعيدًا عن سببه. فيُفحص كل حقل
 * هنا، ويُرفض الصفّ كاملًا عند أول خلل.
 */
function parseDeploymentRow(row: unknown): ModelDeploymentRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;

  if (!isNonEmptyString(r.id)) return null;
  if (!isNonEmptyString(r.model_id)) return null;
  if (!isNonEmptyString(r.model_version_id)) return null;
  if (!isNonEmptyString(r.endpoint_alias)) return null;
  if (!isNonEmptyString(r.runtime_model)) return null;
  if (!isNonEmptyString(r.created_at)) return null;
  if (!isNullableString(r.activated_at)) return null;
  if (!isNullableString(r.retired_at)) return null;

  if (!ENVIRONMENTS.includes(r.environment as DeploymentEnvironment)) return null;
  if (!DEPLOYMENT_STATUSES.includes(r.status as DeploymentStatus)) return null;

  return {
    id: r.id,
    modelId: r.model_id,
    modelVersionId: r.model_version_id,
    environment: r.environment as DeploymentEnvironment,
    status: r.status as DeploymentStatus,
    endpointAlias: r.endpoint_alias,
    runtimeModel: r.runtime_model,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    retiredAt: r.retired_at,
  };
}

function parseVersionRow(row: unknown): ModelVersionRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;

  if (!isNonEmptyString(r.id)) return null;
  if (!isNonEmptyString(r.model_id)) return null;
  if (!isNonEmptyString(r.version)) return null;
  if (!isNonEmptyString(r.created_at)) return null;
  if (!isNullableString(r.base_model_ref)) return null;
  if (!isNullableString(r.artifact_ref)) return null;
  if (!isNullableString(r.approved_at)) return null;
  if (!isNullableString(r.retired_at)) return null;

  if (!VERSION_STATUSES.includes(r.status as ModelVersionStatus)) return null;

  return {
    id: r.id,
    modelId: r.model_id,
    version: r.version,
    status: r.status as ModelVersionStatus,
    baseModelRef: r.base_model_ref,
    artifactRef: r.artifact_ref,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    retiredAt: r.retired_at,
  };
}

/**
 * يحلّ النشرة الصالحة للخدمة، أو يُعيد سببًا مغلقًا.
 *
 * ── لا تسريب ──
 *
 * لا يعبر من هنا نصّ خطأ القاعدة ولا رمزها ولا الاستعلام ولا العنوان: قد
 * تحمل رسالة PostgreSQL اسم عمودٍ أو قيمةً أو تفصيلًا داخليًّا، والنتيجة
 * قد تُسجَّل أو تُعرض. فالرمز المغلق هو كل ما يخرج.
 */
export async function resolveServableDeployment(
  client: SupabaseClient,
  modelId: string,
  environment: DeploymentEnvironment,
): Promise<ServableDeploymentResolution> {
  // ── (١) حدّ المدخل: يُفحص قبل أي رحلة ──
  if (typeof modelId !== "string") return fail("invalid_input");
  const id = modelId.trim();
  if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) return fail("invalid_input");
  /**
   * ★ المعرّف يُستعمل كما ورد بعد التشذيب — بلا أي تحويل.
   *
   * أي تطبيع (خفض حالة، إزالة لاحقة، مطابقة مستعار) قد يحوّل معرّفًا إلى
   * نموذجٍ آخر — فيخدم المستخدمَ ما لم يطلبه. والمستعارات، إن لزمت، طبقةٌ
   * صريحة فوق هذا الحلّ لا داخله.
   */
  if (!ENVIRONMENTS.includes(environment)) return fail("invalid_input");

  // ── (٢) النشرة النشطة ──
  /**
   * `limit(2)` لا `single()`.
   *
   * الفهرس الجزئيّ في 0036 يمنع نشرتين نشطتين لكل (نموذج، بيئة). لكن
   * `single()` كان سيعني الثقة بذلك الثابت عمياءَ: على قاعدة لم تُرحَّل،
   * أو مخطط قديم، يصير الصفّان خطأً عامًّا بدل سببٍ مفهوم. وطلبُ صفّين
   * يجعل الغموض **حالةً مُعلَنة** تُرفض صراحةً.
   */
  const deploymentQuery = await client
    .from("ai_model_deployments")
    .select(DEPLOYMENT_COLUMNS)
    .eq("model_id", id)
    .eq("environment", environment)
    .eq("status", "active")
    .limit(2);

  if (deploymentQuery.error) return fail("registry_error");

  const deploymentRows = deploymentQuery.data ?? [];
  if (!Array.isArray(deploymentRows)) return fail("invalid_record");
  if (deploymentRows.length === 0) return fail("no_active_deployment");
  if (deploymentRows.length > 1) return fail("ambiguous_active_deployment");

  const deployment = parseDeploymentRow(deploymentRows[0]);
  if (!deployment) return fail("invalid_record");

  // ── (٣) النسخة بعينها ──
  /**
   * بالمعرّفين معًا لا بـ`id` وحده.
   *
   * المرجع المركّب يمنع الخلط عند **الكتابة**. وهذه قراءة: فلترةٌ بـ`id`
   * وحده تعتمد على سلامة بيانات كُتبت في زمن آخر وربما بمخطط آخر. وشرط
   * `model_id` يجعل استرجاع نسخةِ نموذجٍ آخر مستحيلًا بالاستعلام نفسه.
   */
  const versionQuery = await client
    .from("ai_model_versions")
    .select(VERSION_COLUMNS)
    .eq("id", deployment.modelVersionId)
    .eq("model_id", id)
    .limit(2);

  if (versionQuery.error) return fail("registry_error");

  const versionRows = versionQuery.data ?? [];
  if (!Array.isArray(versionRows)) return fail("invalid_record");
  if (versionRows.length === 0) return fail("version_not_found");
  if (versionRows.length > 1) return fail("invalid_record");

  const version = parseVersionRow(versionRows[0]);
  if (!version) return fail("invalid_record");

  // ── (٤) بوابة الثقة الأخيرة ──
  /**
   * ★ لا مسار نجاح يتجاوز `isServableDeployment`.
   *
   * والفحوص الثلاثة قبلها تُثبّت أن ما وصل هو ما طُلب: القاعدة قد تُعيد
   * صفًّا لا يطابق الفلتر لو كان المخطط مختلفًا أو العميل محاكًى.
   */
  if (deployment.modelId !== id) return fail("not_servable");
  if (version.modelId !== id) return fail("not_servable");
  if (deployment.environment !== environment) return fail("not_servable");

  if (!isServableDeployment(deployment, version)) return fail("not_servable");

  return { ok: true, deployment, version };
}
