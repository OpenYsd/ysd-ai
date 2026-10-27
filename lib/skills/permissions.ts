/**
 * سياسة صلاحيات المهارات — حدودٌ صريحة لتنفيذٍ لم يُبنَ بعد.
 *
 * ── القاعدة ──
 *
 * كل صلاحية تعلنها مهارةٌ لها مواصفةٌ هنا: هل تعمل اليوم (`declarative`: تعليماتٌ نصّية لا
 * أكثر) أم معطّلة (`disabled`)، وما خطرها، وهل تحتاج منحًا من المستخدم. القرار دالّةٌ صافية:
 * لا قاعدة بيانات ولا بيئة — فلا حالة لمستخدمٍ تتسرّب إلى آخر، لأن لا حالة أصلًا.
 *
 * ── الحدود الثابتة ──
 *
 * `EXTENSION_BOUNDARIES`: لا تثبيت بعيد، ولا شيفرة اعتباطية، ولا ملفات، ولا شبكة، ولا طرفية،
 * ولا Git، ولا تحكّم بالمتصفح. كلّها `false` بالقيمة لا بالإعداد — فلا متغيّر بيئة يفتحها.
 * والصلاحية المعطّلة تبقى مرفوضة حتى مع منحٍ صريح: المنح لا يسبق البناء.
 *
 * منحُ الصلاحيات وحفظُه (جدولٌ لكل مستخدم، وموافقةٌ صريحة، وسجلّ عمليات) مرحلةٌ لاحقة؛
 * مفرداتها هنا (`grant_required`) محجوزةٌ كي لا يُعاد تصميم العقد حينها.
 */

import type { DictKey } from "@/lib/i18n";
import { SKILL_CAPABILITIES, isKnownCapability, type SkillCapability, type SkillManifest } from "./manifest";

export type CapabilityExecution = "declarative" | "disabled";
export type CapabilityRisk = "none" | "low" | "medium" | "high" | "critical";

export interface CapabilitySpec {
  readonly id: SkillCapability;
  /** `declarative`: تعمل اليوم كنصٍّ يُقرأ ويُنسخ؛ `disabled`: لا تنفيذ لها في هذا الإصدار */
  readonly execution: CapabilityExecution;
  readonly risk: CapabilityRisk;
  /** هل تحتاج منحًا صريحًا من المستخدم متى بُني تنفيذها */
  readonly requiresGrant: boolean;
  readonly labelKey: DictKey;
}

export const CAPABILITY_SPECS: Readonly<Record<SkillCapability, CapabilitySpec>> = Object.freeze({
  "prompt.template": Object.freeze({ id: "prompt.template", execution: "declarative", risk: "none", requiresGrant: false, labelKey: "capabilityPromptTemplate" }),
  "conversation.read": Object.freeze({ id: "conversation.read", execution: "disabled", risk: "low", requiresGrant: true, labelKey: "capabilityConversationRead" }),
  "files.read": Object.freeze({ id: "files.read", execution: "disabled", risk: "medium", requiresGrant: true, labelKey: "capabilityFilesRead" }),
  "web.fetch": Object.freeze({ id: "web.fetch", execution: "disabled", risk: "high", requiresGrant: true, labelKey: "capabilityWebFetch" }),
  "code.execute": Object.freeze({ id: "code.execute", execution: "disabled", risk: "critical", requiresGrant: true, labelKey: "capabilityCodeExecute" }),
} satisfies Record<SkillCapability, CapabilitySpec>);

/** حدود الإضافات في هذا الإصدار — قيمٌ ثابتة لا تُقرأ من بيئةٍ ولا إعداد */
export const EXTENSION_BOUNDARIES = Object.freeze({
  remoteInstall: false,
  arbitraryCode: false,
  filesystem: false,
  network: false,
  terminal: false,
  git: false,
  browserAutomation: false,
} as const);
export type ExtensionBoundary = keyof typeof EXTENSION_BOUNDARIES;

export type PermissionDenialReason = "unknown_capability" | "capability_disabled" | "grant_required";

export type PermissionDecision =
  | { readonly allowed: true; readonly mode: "declarative" }
  | { readonly allowed: false; readonly reason: PermissionDenialReason };

export interface PermissionContext {
  /** منحٌ صريحة للمستخدم — لا مصدر لها اليوم؛ تُمرَّر فارغةً حتى تُبنى آلية المنح */
  readonly grants?: readonly string[];
}

/** القرار من مواصفةٍ بعينها — معزولٌ كي تُختبر فروع المنح دون تعديل المواصفات الثابتة */
export function decideWithSpec(spec: CapabilitySpec, context: PermissionContext = {}): PermissionDecision {
  if (spec.execution === "disabled") return { allowed: false, reason: "capability_disabled" };
  if (spec.requiresGrant && !(context.grants ?? []).includes(spec.id)) return { allowed: false, reason: "grant_required" };
  return { allowed: true, mode: "declarative" };
}

/** قرار صلاحيةٍ باسمها — الاسم المجهول يُرفض قبل أي نظرٍ في السياق */
export function decideCapability(capability: string, context: PermissionContext = {}): PermissionDecision {
  if (!isKnownCapability(capability)) return { allowed: false, reason: "unknown_capability" };
  return decideWithSpec(CAPABILITY_SPECS[capability], context);
}

export interface SkillCapabilityDecision {
  readonly id: SkillCapability;
  readonly spec: CapabilitySpec;
  readonly decision: PermissionDecision;
}

export interface SkillPermissionReport {
  /** تعمل المهارة كاملةً اليوم: كل صلاحياتها مسموحة (أي تصريحية) */
  readonly executable: boolean;
  readonly capabilities: readonly SkillCapabilityDecision[];
}

/** تقرير مهارةٍ: قرارٌ لكل صلاحيةٍ أعلنتها، والمحصّلة — صلاحيةٌ واحدة مرفوضة تكفي للرفض */
export function evaluateSkill(skill: Pick<SkillManifest, "capabilities">, context: PermissionContext = {}): SkillPermissionReport {
  const capabilities = skill.capabilities.map((id) => ({ id, spec: CAPABILITY_SPECS[id], decision: decideWithSpec(CAPABILITY_SPECS[id], context) }));
  return { executable: capabilities.every((c) => c.decision.allowed), capabilities };
}

/** الصلاحيات المعطّلة اليوم — لعرض الحدود لا لتجاوزها */
export function disabledCapabilities(): readonly SkillCapability[] {
  return SKILL_CAPABILITIES.filter((id) => CAPABILITY_SPECS[id].execution === "disabled");
}
