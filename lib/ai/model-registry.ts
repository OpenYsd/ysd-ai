/**
 * سجلّ نماذج YSD — **عقدٌ لا خدمة** (v0.9.3، الرقعة الثانية).
 *
 * ── ثلاث طبقات لا واحدة ──
 *
 *   النموذج المنطقيّ (`ai_models`) — الاسم الذي يختاره المستخدم ويبقى.
 *   النسخة (`ai_model_versions`)   — ما دُرِّب فعلًا، بدورة حياته.
 *   النشرة (`ai_model_deployments`) — أيّ نسخة تخدم أيّ بيئة الآن.
 *
 * وخلطُها يجعل «ترقية الإنتاج» تعديلًا على النموذج نفسه، فيضيع تاريخ ما
 * كان يخدم ويستحيل التراجع.
 *
 * ── وما لا يفعله هذا الملفّ ──
 *
 * لا نداء قاعدة، ولا شبكة، ولا قراءة بيئة. أنواعٌ تطابق المخطط حرفيًّا،
 * ودالةٌ نقيّة واحدة. والوصل بالقاعدة رقعةٌ مستقلّة.
 */

/** يطابق `ai_model_versions.status` حرفيًّا */
export type ModelVersionStatus = "draft" | "candidate" | "approved" | "retired";

/** يطابق `ai_model_deployments.environment` حرفيًّا */
export type DeploymentEnvironment = "development" | "staging" | "production";

/** يطابق `ai_model_deployments.status` حرفيًّا */
export type DeploymentStatus = "inactive" | "active" | "failed" | "retired";

/**
 * صفّ نسخة — الأسماء بصيغة camelCase وأصولها في المخطط بين قوسين.
 *
 * `artifactRef` قد يغيب في المسوّدة والمرشّحة، ويلزم في المعتمدة — وذلك
 * مفروض في القاعدة بقيدٍ لا بالاتفاق.
 */
export interface ModelVersionRecord {
  /** id */
  id: string;
  /** model_id */
  modelId: string;
  /** version */
  version: string;
  /** status */
  status: ModelVersionStatus;
  /** base_model_ref — مرجع اسميّ لا سرّ */
  baseModelRef: string | null;
  /** artifact_ref — مرجع اسميّ لا سرّ */
  artifactRef: string | null;
  /** created_at */
  createdAt: string;
  /** approved_at */
  approvedAt: string | null;
  /** retired_at */
  retiredAt: string | null;
}

/**
 * صفّ نشرة.
 *
 * `modelId` مكرّر هنا وفي النسخة عمدًا: عليه يقوم المرجع المركّب الذي
 * يمنع نشرةَ نموذجٍ من الإشارة إلى نسخة نموذجٍ آخر.
 */
export interface ModelDeploymentRecord {
  /** id */
  id: string;
  /** model_id */
  modelId: string;
  /** model_version_id */
  modelVersionId: string;
  /** environment */
  environment: DeploymentEnvironment;
  /** status */
  status: DeploymentStatus;
  /** endpoint_alias — اسم مستعار لا عنوان */
  endpointAlias: string;
  /** runtime_model — معرّف نتاج وقت التشغيل، ليس سرًّا */
  runtimeModel: string;
  /** created_at */
  createdAt: string;
  /** activated_at */
  activatedAt: string | null;
  /** retired_at */
  retiredAt: string | null;
}

const filled = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * ★ هل هذه النشرة صالحة للخدمة فعلًا؟
 *
 * دالة نقيّة — لا قاعدة ولا شبكة ولا بيئة. تجمع شروطًا يفرض بعضها المخطط
 * ولا يفرض بعضها، فتكون **بوابة واحدة** يمرّ بها كل من أراد أن يخدم نسخة.
 *
 * وأخطرها الشرط الثالث: تطابق `modelId` بين النسخة والنشرة. المرجع المركّب
 * في القاعدة يمنع الخلط عند الكتابة، لكن هذه الدالة قد تُستدعى بصفّين
 * قُرئا من مسارين مختلفين — ولا شيء في الأنواع يمنع تمرير غير المتطابقين.
 * فالتحقق هنا ليس تكرارًا بل حراسة لحدٍّ آخر.
 *
 * وترتيب الشروط لا يغيّر النتيجة: كلها لازمة، وأيّ إخفاق يمنع الخدمة.
 */
export function isServableDeployment(
  deployment: ModelDeploymentRecord,
  version: ModelVersionRecord,
): boolean {
  if (deployment.status !== "active") return false;
  if (version.status !== "approved") return false;
  // النسخة والنشرة لنموذج منطقيّ واحد — وإلا خدمنا نموذجًا غير المقصود
  if (deployment.modelId !== version.modelId) return false;
  if (deployment.modelVersionId !== version.id) return false;
  if (!filled(version.artifactRef)) return false;
  if (!filled(deployment.runtimeModel)) return false;
  if (!filled(deployment.endpointAlias)) return false;
  return true;
}
