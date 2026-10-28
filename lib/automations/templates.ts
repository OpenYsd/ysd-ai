/**
 * قوالب سير العمل المدمجة (المرحلة 4B) — بياناتٌ ثابتة لا برامج. دوالّ صافية بلا متصفحٍ ولا شبكة.
 *
 * ── ما القالب ──
 *
 * عنوانٌ ووصفٌ باللغتين، وتصنيف، وخطواتٌ مرتّبة بأنواع المرحلة 4A نفسها (`instruction` و`skill` و`review`).
 * القالب لا يُحفظ ولا يُنفَّذ: «استخدام القالب» ينسخه إلى مسودةٍ جديدة بمعرّفاتٍ جديدة من المولِّد المعتمد
 * (`newWorkflowId` و`newStepId`)، تُفتح في المحرّر نفسه، ولا تُحفظ إلا بحفظٍ صريح وتحقّقٍ ناجح.
 *
 * ── الحدود ──
 *
 * الفهرس مغلقٌ ومدمج: لا قوالب خارجية ولا تنزيل. والقوالب مجمَّدة بعمقٍ فلا يُعدَّل أصلٌ بنسخه. وكل قالبٍ
 * يمرّ بقواعد التحقّق نفسها التي تمرّ بها المسودة العادية، باللغتين — والمهارة المشار إليها تُحَلّ من فهرس
 * المهارات وسياسة صلاحياته، لا من نظامٍ ثانٍ.
 */

import { z } from "zod";
import { SKILL_ID_PATTERN } from "@/lib/skills/manifest";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
  newStepId,
  newWorkflowId,
  validateWorkflow,
  type Workflow,
  type WorkflowIssue,
  type WorkflowStep,
} from "./workflow";

export const TEMPLATE_VERSION = 1 as const;
export const TEMPLATE_CATEGORIES = ["learning", "software", "research"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** معرّف القالب بادئته `tpl-` — لا يطابق معرّف مسودة (`wf_…`) أبدًا، فلا يُستعمل معرّفًا لها */
export const TEMPLATE_ID_PATTERN = /^tpl-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEP_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const localized = (max: number) =>
  z
    .object({
      ar: z.string().trim().min(1).max(max),
      en: z.string().trim().min(1).max(max),
    })
    .strict();

const stepKey = z.string().min(1).max(40).regex(STEP_KEY_PATTERN);

export const workflowTemplateSchema = z
  .object({
    templateVersion: z.literal(TEMPLATE_VERSION),
    id: z.string().min(5).max(48).regex(TEMPLATE_ID_PATTERN),
    schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
    category: z.enum(TEMPLATE_CATEGORIES),
    /** القالب مسودةٌ للبدء وحدها — لا حالة «قابل للتشغيل» */
    draftOnly: z.literal(true),
    title: localized(WORKFLOW_LIMITS.nameMax),
    description: localized(WORKFLOW_LIMITS.descriptionMax),
    steps: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ key: stepKey, kind: z.literal("instruction"), text: localized(WORKFLOW_LIMITS.stepTextMax) }).strict(),
          z.object({ key: stepKey, kind: z.literal("skill"), skillId: z.string().min(1).max(48).regex(SKILL_ID_PATTERN) }).strict(),
          z.object({ key: stepKey, kind: z.literal("review"), text: localized(WORKFLOW_LIMITS.stepTextMax) }).strict(),
        ]),
      )
      .min(1)
      .max(WORKFLOW_LIMITS.stepsMax),
  })
  .strict()
  .superRefine((tpl, ctx) => {
    const seen = new Set<string>();
    tpl.steps.forEach((s, i) => {
      if (seen.has(s.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", i, "key"], message: "duplicate_step_key" });
      seen.add(s.key);
    });
  });

export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
export type TemplateLocale = "ar" | "en";

/** الفهرس المدمج — ثلاثة قوالب. أي إضافةٍ تمرّ بالمخطّط وبالتحقّق نفسه في الاختبارات */
const BUILT_IN: readonly unknown[] = [
  {
    templateVersion: 1,
    id: "tpl-learning-plan",
    schemaVersion: 1,
    category: "learning",
    draftOnly: true,
    title: { ar: "خطة تعلّم", en: "Learning plan" },
    description: {
      ar: "خطة منظّمة لتعلّم موضوعٍ جديد: هدفٌ واضح، ووحداتٌ ومصادر، وأسئلة مراجعة، ومراجعة أسبوعية لتقدّمك.",
      en: "A structured plan for learning a new topic: a clear goal, units and resources, review questions and a weekly progress check.",
    },
    steps: [
      {
        key: "goal",
        kind: "instruction",
        text: {
          ar: "حدّد الموضوع الذي تريد تعلّمه، ومستواك الحالي فيه، والهدف الذي تريد بلوغه وموعده.",
          en: "Name the topic you want to learn, your current level in it, and the goal you want to reach and by when.",
        },
      },
      {
        key: "units",
        kind: "instruction",
        text: {
          ar: "قسّم الموضوع إلى وحداتٍ صغيرة مرتّبة، واختر لكل وحدةٍ مصدرًا موثوقًا ووقتًا أسبوعيًّا.",
          en: "Split the topic into small ordered units, and choose a trusted resource and a weekly time slot for each.",
        },
      },
      { key: "questions", kind: "skill", skillId: "study-questions" },
      {
        key: "weekly-review",
        kind: "review",
        text: {
          ar: "راجع تقدّمك كل أسبوع: ما الذي أتقنته، وما الذي يحتاج تكرارًا، ثم عدّل الخطة.",
          en: "Review your progress every week: what you've mastered and what needs repetition, then adjust the plan.",
        },
      },
    ],
  },
  {
    templateVersion: 1,
    id: "tpl-software-project-review",
    schemaVersion: 1,
    category: "software",
    draftOnly: true,
    title: { ar: "مراجعة مشروع برمجي", en: "Software project review" },
    description: {
      ar: "مراجعة منهجية لمشروعٍ برمجي: الأهداف والبنية والشيفرة والاختبارات والأمان، ثم قائمة تحسيناتٍ مرتّبة.",
      en: "A methodical review of a software project: goals, architecture, code, tests and security, then a prioritized list of improvements.",
    },
    steps: [
      {
        key: "scope",
        kind: "instruction",
        text: {
          ar: "اكتب هدف المشروع ونطاق المراجعة: الأجزاء المشمولة، والأسئلة التي تريد إجابتها.",
          en: "Write the project's goal and the review scope: which parts are covered and which questions you want answered.",
        },
      },
      { key: "explain-code", kind: "skill", skillId: "explain-code" },
      {
        key: "checks",
        kind: "instruction",
        text: {
          ar: "افحص الاختبارات ومعالجة الأخطاء والأمان والأداء، وسجّل كل ملاحظةٍ بموضعها.",
          en: "Check tests, error handling, security and performance, and record each finding with its location.",
        },
      },
      {
        key: "team-review",
        kind: "review",
        text: {
          ar: "رتّب الملاحظات حسب الخطورة والجهد، وراجعها مع فريقك قبل اعتماد أي تغيير.",
          en: "Rank the findings by severity and effort, and review them with your team before approving any change.",
        },
      },
    ],
  },
  {
    templateVersion: 1,
    id: "tpl-scientific-research-plan",
    schemaVersion: 1,
    category: "research",
    draftOnly: true,
    title: { ar: "خطة بحث علمي", en: "Scientific research plan" },
    description: {
      ar: "خطة لبحثٍ علمي من السؤال إلى المنهجية: مراجعة الأدبيات، والفرضيات، وجمع البيانات، ومراجعة أخلاقية.",
      en: "A plan for a scientific study from question to methodology: literature review, hypotheses, data collection and an ethics review.",
    },
    steps: [
      {
        key: "question",
        kind: "instruction",
        text: {
          ar: "صُغ سؤال البحث بدقّة، وبيّن أهميته والفجوة التي يسدّها.",
          en: "State the research question precisely, and explain its importance and the gap it fills.",
        },
      },
      { key: "literature", kind: "skill", skillId: "document-qa" },
      {
        key: "method",
        kind: "instruction",
        text: {
          ar: "حدّد الفرضيات والمتغيّرات، وصمّم طريقة جمع البيانات وتحليلها.",
          en: "Define the hypotheses and variables, and design how data will be collected and analysed.",
        },
      },
      { key: "summary", kind: "skill", skillId: "summarize-text" },
      {
        key: "ethics-review",
        kind: "review",
        text: {
          ar: "راجع الخطة مع مشرفك، وتحقّق من الاعتبارات الأخلاقية قبل البدء بجمع البيانات.",
          en: "Review the plan with your supervisor, and check the ethical considerations before collecting any data.",
        },
      },
    ],
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

let cached: readonly WorkflowTemplate[] | null = null;

/** الفهرس المدمج مُتحقَّقًا ومجمَّدًا بعمق — يُبنى مرّةً؛ وفساده خطأٌ برمجيّ يُرمى لا يُخفى */
export function builtInWorkflowTemplates(): readonly WorkflowTemplate[] {
  if (cached) return cached;
  const out: WorkflowTemplate[] = [];
  const ids = new Set<string>();
  for (const raw of BUILT_IN) {
    const parsed = workflowTemplateSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid built-in workflow template: ${JSON.stringify(parsed.error.issues[0])}`);
    if (ids.has(parsed.data.id)) throw new Error(`duplicate built-in workflow template id: ${parsed.data.id}`);
    ids.add(parsed.data.id);
    out.push(parsed.data);
  }
  cached = deepFreeze(out);
  return cached;
}

const localizedStep = (s: WorkflowTemplate["steps"][number], locale: TemplateLocale, id: string): WorkflowStep =>
  s.kind === "skill" ? { id, kind: "skill", skillId: s.skillId } : { id, kind: s.kind, text: s.text[locale] };

/**
 * مسودةٌ جديدة من قالب بلغة الواجهة: معرّفاتٌ جديدة من المولِّد المعتمد لكل نداء — لا معرّف القالب ولا
 * مفاتيح خطواته — وكائناتٌ جديدة لا تشارك القالب شيئًا. لا تُحفظ هنا: المحرّر يعرضها والحفظ صريح.
 */
export function instantiateTemplate(
  template: WorkflowTemplate,
  locale: TemplateLocale,
  ids: { workflowId: () => string; stepId: () => string } = { workflowId: newWorkflowId, stepId: newStepId },
): Workflow {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: ids.workflowId(),
    name: template.title[locale],
    description: template.description[locale],
    steps: template.steps.map((s) => localizedStep(s, locale, ids.stepId())),
  };
}

/** خطوات القالب للمعاينة بلغة الواجهة — المفتاح الثابت معرّفُ عرضٍ لا معرّف مسودة؛ لا شيء يُولَّد ولا يُحفظ */
export function templatePreviewSteps(template: WorkflowTemplate, locale: TemplateLocale): Pick<Workflow, "steps"> {
  return { steps: template.steps.map((s) => localizedStep(s, locale, s.key)) };
}

/** هل يمرّ القالب بقواعد المسودة العادية في اللغتين؟ — مصفوفة أخطاءٍ لكل لغة، وفارغةٌ للسليم */
export function templateIssues(template: WorkflowTemplate, knownSkillIds: ReadonlySet<string>): Record<TemplateLocale, readonly WorkflowIssue[]> {
  const result = {} as Record<TemplateLocale, readonly WorkflowIssue[]>;
  for (const locale of ["ar", "en"] as const) {
    const v = validateWorkflow(instantiateTemplate(template, locale), knownSkillIds);
    result[locale] = v.ok ? [] : v.issues;
  }
  return result;
}
