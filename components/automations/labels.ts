/**
 * تسميات الأتمتة — خرائط مغلقة من الرموز إلى مفاتيح القاموس (المرحلة 4A). نوعٌ جديد أو رمز خطأٍ
 * جديد لا يُبنى بلا تسميته هنا: `satisfies Record<…>` يُسقط البناء إن نقص مفتاح.
 */

import type { DictKey, useI18n } from "@/lib/i18n";
import type { CapabilitySpec } from "@/lib/skills/permissions";
import type { WorkflowIssue, WorkflowIssueCode, WorkflowStepKind } from "@/lib/automations/workflow";
import type { TemplateCategory } from "@/lib/automations/templates";

/** تصنيف القالب (المرحلة 4B) */
export const TEMPLATE_CATEGORY_LABEL = {
  learning: "templateCategoryLearning",
  software: "templateCategorySoftware",
  research: "templateCategoryResearch",
} as const satisfies Record<TemplateCategory, DictKey>;

export const STEP_KIND_LABEL = {
  instruction: "stepKindInstruction",
  skill: "stepKindSkill",
  review: "stepKindReview",
} as const satisfies Record<WorkflowStepKind, DictKey>;

export const ISSUE_LABEL = {
  invalid_shape: "issueInvalidWorkflow",
  unsupported_version: "issueInvalidWorkflow",
  invalid_id: "issueInvalidWorkflow",
  name_required: "issueNameRequired",
  name_too_long: "issueNameTooLong",
  description_too_long: "issueDescriptionTooLong",
  steps_required: "issueStepsRequired",
  too_many_steps: "issueTooManySteps",
  unknown_step_kind: "issueInvalidWorkflow",
  step_text_required: "issueStepTextRequired",
  step_text_too_long: "issueStepTextTooLong",
  skill_required: "issueSkillRequired",
  unknown_skill: "issueUnknownSkill",
  duplicate_step_id: "issueDuplicateStep",
} as const satisfies Record<WorkflowIssueCode, DictKey>;

type Translate = ReturnType<typeof useI18n>["t"];

/** نصّ الخطأ بلغة الواجهة، مسبوقًا برقم الخطوة إن كان خاصًّا بخطوة */
export function issueText(t: Translate, issue: WorkflowIssue): string {
  const message = t(ISSUE_LABEL[issue.code]);
  return issue.stepIndex === undefined ? message : `${t("workflowStep")} ${issue.stepIndex + 1}: ${message}`;
}

/** تسمية الصلاحية من مواصفتها — كما في فهرس الإضافات، بلا استيراد واجهته كلّها */
export function capabilityText(t: Translate, spec: CapabilitySpec): string {
  const value = t(spec.labelKey);
  return typeof value === "string" ? value : spec.id;
}
