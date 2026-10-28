/**
 * مسودات سير العمل — المخطّط والتحقّق والمعاينة (المرحلة 4A). دوالّ صافية بلا متصفحٍ ولا شبكة.
 *
 * ── ما سير العمل هنا ──
 *
 * اسمٌ ووصفٌ وخطواتٌ مرتّبة، لكلٍّ منها نوعٌ تصريحيّ من قائمةٍ مغلقة:
 *   - `instruction`: نصّ تعليماتٍ يكتبه المستخدم.
 *   - `skill`: إشارةٌ إلى مهارةٍ مدمجة بمعرّفها — وحالة صلاحياتها من سياسة المهارات نفسها
 *     (`lib/skills/permissions.ts`)، لا من نظام صلاحياتٍ ثانٍ.
 *   - `review`: نقطة مراجعةٍ يدوية يصفها المستخدم.
 *
 * ── ما ليس هنا عمدًا ──
 *
 * لا محرّك تنفيذ ولا جدولة ولا عمل في الخلفية ولا طلب شبكة ولا نداء نموذج. المعاينة وصفٌ للقراءة:
 * تُرتّب الخطوات وتسمّيها ولا تُشغّل منها شيئًا. وحدود هذا الإصدار ثابتةٌ في `AUTOMATION_BOUNDARIES`.
 */

import { z } from "zod";
import { SKILL_ID_PATTERN, type SkillManifest } from "@/lib/skills/manifest";
import { evaluateSkill, type SkillCapabilityDecision } from "@/lib/skills/permissions";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_STEP_KINDS = ["instruction", "skill", "review"] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_LIMITS = Object.freeze({
  nameMax: 80,
  descriptionMax: 500,
  stepsMax: 20,
  stepTextMax: 1000,
  workflowsMax: 50,
} as const);

/** حدود الأتمتة في هذا الإصدار — قيمٌ ثابتة لا تُقرأ من بيئةٍ ولا إعداد */
export const AUTOMATION_BOUNDARIES = Object.freeze({
  manualRun: false,
  scheduledRun: false,
  backgroundJobs: false,
  network: false,
  aiCalls: false,
  codeExecution: false,
  browserGitFilesystem: false,
} as const);

export const WORKFLOW_ID_PATTERN = /^wf_[a-z0-9]{12}$/;
export const STEP_ID_PATTERN = /^st_[a-z0-9]{12}$/;

const stepId = z.string().regex(STEP_ID_PATTERN);
const stepText = z.string().trim().min(1).max(WORKFLOW_LIMITS.stepTextMax);

export const workflowStepSchema = z.discriminatedUnion("kind", [
  z.object({ id: stepId, kind: z.literal("instruction"), text: stepText }).strict(),
  z.object({ id: stepId, kind: z.literal("skill"), skillId: z.string().min(1).max(48).regex(SKILL_ID_PATTERN) }).strict(),
  z.object({ id: stepId, kind: z.literal("review"), text: stepText }).strict(),
]);

export const workflowSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    id: z.string().regex(WORKFLOW_ID_PATTERN),
    name: z.string().trim().min(1).max(WORKFLOW_LIMITS.nameMax),
    description: z.string().trim().max(WORKFLOW_LIMITS.descriptionMax),
    steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_LIMITS.stepsMax),
  })
  .strict()
  .superRefine((wf, ctx) => {
    const seen = new Set<string>();
    wf.steps.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "id"], message: "duplicate_step_id" });
      seen.add(s.id);
    });
  });

export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

export type WorkflowIssueCode =
  | "invalid_shape"
  | "unsupported_version"
  | "invalid_id"
  | "name_required"
  | "name_too_long"
  | "description_too_long"
  | "steps_required"
  | "too_many_steps"
  | "unknown_step_kind"
  | "step_text_required"
  | "step_text_too_long"
  | "skill_required"
  | "unknown_skill"
  | "duplicate_step_id";

export interface WorkflowIssue {
  readonly code: WorkflowIssueCode;
  /** رقم الخطوة من الصفر — للخطأ الخاصّ بخطوة */
  readonly stepIndex?: number;
  /** الحقل: name، description، steps، أو text/skillId/kind/id داخل خطوة */
  readonly field?: string;
}

export type WorkflowValidation = { readonly ok: true; readonly workflow: Workflow } | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

function issueFromZod(issue: z.ZodIssue): WorkflowIssue {
  const [head, index, field] = issue.path;
  if (head === "schemaVersion") return { code: "unsupported_version", field: "schemaVersion" };
  if (head === "id") return { code: "invalid_id", field: "id" };
  if (head === "name") {
    if (issue.code === "too_small") return { code: "name_required", field: "name" };
    if (issue.code === "too_big") return { code: "name_too_long", field: "name" };
    return { code: "invalid_shape", field: "name" };
  }
  if (head === "description") return { code: issue.code === "too_big" ? "description_too_long" : "invalid_shape", field: "description" };
  if (head === "steps" && index === undefined) {
    if (issue.code === "too_small") return { code: "steps_required", field: "steps" };
    if (issue.code === "too_big") return { code: "too_many_steps", field: "steps" };
    return { code: "invalid_shape", field: "steps" };
  }
  if (head === "steps" && typeof index === "number") {
    if (issue.code === "invalid_union_discriminator" || field === "kind") return { code: "unknown_step_kind", stepIndex: index, field: "kind" };
    if (issue.code === "custom" && issue.message === "duplicate_step_id") return { code: "duplicate_step_id", stepIndex: index, field: "id" };
    if (field === "text") return { code: issue.code === "too_big" ? "step_text_too_long" : "step_text_required", stepIndex: index, field: "text" };
    if (field === "skillId") return { code: "skill_required", stepIndex: index, field: "skillId" };
    if (field === "id") return { code: "invalid_id", stepIndex: index, field: "id" };
    return { code: "invalid_shape", stepIndex: index };
  }
  return { code: "invalid_shape" };
}

/**
 * التحقّق الكامل للحفظ: البنية الصارمة، ثم أن كل مهارةٍ مشارٍ إليها موجودةٌ في الفهرس المدمج.
 * الأخطاء مرتّبة ومن غير تكرار — رمزٌ ومكانٌ لا نصّ، والواجهة تترجمها.
 */
export function validateWorkflow(input: unknown, knownSkillIds: ReadonlySet<string>): WorkflowValidation {
  const parsed = workflowSchema.safeParse(input);
  const issues: WorkflowIssue[] = [];
  if (!parsed.success) {
    for (const zi of parsed.error.issues) issues.push(issueFromZod(zi));
  } else {
    parsed.data.steps.forEach((s, i) => {
      if (s.kind === "skill" && !knownSkillIds.has(s.skillId)) issues.push({ code: "unknown_skill", stepIndex: i, field: "skillId" });
    });
  }
  // مهارةٌ مجهولة في مسودةٍ بنيتها خاطئةٌ أيضًا — تُذكر هي الأخرى كي يرى المستخدم كل ما يُصلَح
  if (!parsed.success && input && typeof input === "object" && Array.isArray((input as { steps?: unknown }).steps)) {
    ((input as { steps: unknown[] }).steps).forEach((s, i) => {
      const step = s as { kind?: unknown; skillId?: unknown };
      if (step?.kind === "skill" && typeof step.skillId === "string" && SKILL_ID_PATTERN.test(step.skillId) && !knownSkillIds.has(step.skillId)) {
        issues.push({ code: "unknown_skill", stepIndex: i, field: "skillId" });
      }
    });
  }
  const seen = new Set<string>();
  const unique = issues.filter((x) => {
    const k = `${x.code}:${x.stepIndex ?? ""}:${x.field ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.length === 0 && parsed.success ? { ok: true, workflow: parsed.data } : { ok: false, issues: unique };
}

// ── عمليات الترتيب: نسخٌ جديدة، والمدخل لا يُمسّ ──

export function moveStep<T>(steps: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as T);
  return next;
}

export function removeStep<T>(steps: readonly T[], index: number): T[] {
  return index < 0 || index >= steps.length ? [...steps] : steps.filter((_, i) => i !== index);
}

// ── المعرّفات: تُولَّد في معالِجات الأحداث وحدها، لا أثناء العرض ──

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomSuffix(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
export const newWorkflowId = () => `wf_${randomSuffix()}`;
export const newStepId = () => `st_${randomSuffix()}`;

// ── المعاينة: وصفٌ للقراءة، لا تشغيل ──

export type AutomationSkillOption = Pick<SkillManifest, "id" | "name" | "capabilities">;

export type PreviewStep =
  | { readonly position: number; readonly id: string; readonly kind: "instruction" | "review"; readonly text: string }
  | {
      readonly position: number;
      readonly id: string;
      readonly kind: "skill";
      readonly skillId: string;
      /** null ⇒ لا مهارة بهذا المعرّف في الفهرس المدمج */
      readonly skill: { readonly name: AutomationSkillOption["name"]; readonly executable: boolean; readonly capabilities: readonly SkillCapabilityDecision[] } | null;
    };

/** خطوات المسودة بترتيبها وأرقامها، والمهارة بحالة صلاحياتها — دالّةٌ صافية لا تنفّذ شيئًا */
export function buildWorkflowPreview(workflow: Pick<Workflow, "steps">, skills: readonly AutomationSkillOption[]): PreviewStep[] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  return workflow.steps.map((step, i) => {
    if (step.kind !== "skill") return { position: i + 1, id: step.id, kind: step.kind, text: step.text };
    const skill = byId.get(step.skillId);
    if (!skill) return { position: i + 1, id: step.id, kind: "skill", skillId: step.skillId, skill: null };
    const report = evaluateSkill(skill);
    return { position: i + 1, id: step.id, kind: "skill", skillId: step.skillId, skill: { name: skill.name, executable: report.executable, capabilities: report.capabilities } };
  });
}
