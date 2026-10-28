/**
 * المرحلة 4B — قوالب سير العمل المدمجة: الفهرس والمخطّط والترتيب والتحقّق والصلاحيات والنسخ والتجميد.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - ثلاثة قوالب بمعرّفاتٍ ثابتة فريدة لا تطابق معرّف مسودة، بالإصدار والتصنيف و«مسودة فقط».
 *   - الخطوات بترتيبٍ ثابت ومفاتيح فريدة، بأنواع المرحلة 4A وحدها.
 *   - كل قالبٍ يمرّ بقواعد المسودة العادية نفسها باللغتين، ومهاراته من الفهرس المدمج بقرار سياسته.
 *   - النسخ يعطي مسودةً مستقلّة بمعرّفاتٍ جديدة في كل مرّة، والقالب مجمَّدٌ بعمق لا يتغيّر.
 *   - المخطّط يرفض ما ليس قالبًا مدمجًا تصريحيًّا: مفتاحٌ زائد، نوعٌ آخر، إصدارٌ آخر، «مسودة فقط» غائبة.
 *   - الشيفرة صافية: لا متصفح ولا شبكة ولا تنزيل ولا تقييم.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_ID_PATTERN,
  TEMPLATE_VERSION,
  builtInWorkflowTemplates,
  instantiateTemplate,
  templateIssues,
  templatePreviewSteps,
  workflowTemplateSchema,
} from "@/lib/automations/templates";
import {
  STEP_ID_PATTERN,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_LIMITS,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STEP_KINDS,
  buildWorkflowPreview,
  validateWorkflow,
} from "@/lib/automations/workflow";
import { builtInSkillRegistry } from "@/lib/skills/registry";
import { evaluateSkill } from "@/lib/skills/permissions";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const TEMPLATES = builtInWorkflowTemplates();
const SKILLS = builtInSkillRegistry()
  .list()
  .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
const KNOWN = new Set(SKILLS.map((s) => s.id));
const byId = (id: string) => TEMPLATES.find((t) => t.id === id)!;

describe("الفهرس", () => {
  it("ثلاثة قوالب بمعرّفاتٍ ثابتة وبالترتيب: تعلّم، مراجعة برمجية، بحث علمي", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["tpl-learning-plan", "tpl-software-project-review", "tpl-scientific-research-plan"]);
    expect(TEMPLATES.map((t) => t.category)).toEqual(["learning", "software", "research"]);
    expect([...TEMPLATE_CATEGORIES]).toEqual(["learning", "software", "research"]);
  });

  it("معرّفاتٌ فريدة بشكلها، ولا يطابق أيٌّ منها معرّف مسودة", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(TEMPLATE_ID_PATTERN);
      expect(id).not.toMatch(WORKFLOW_ID_PATTERN);
    }
  });

  it("كل قالب: الإصداران، و«مسودة فقط»، والعنوان والوصف باللغتين ضمن حدود المسودة", () => {
    for (const t of TEMPLATES) {
      expect(workflowTemplateSchema.safeParse(t).success, t.id).toBe(true);
      expect(t.templateVersion).toBe(TEMPLATE_VERSION);
      expect(t.schemaVersion).toBe(WORKFLOW_SCHEMA_VERSION);
      expect(t.draftOnly).toBe(true);
      for (const l of ["ar", "en"] as const) {
        expect(t.title[l].length, `${t.id} title ${l}`).toBeGreaterThan(2);
        expect(t.title[l].length).toBeLessThanOrEqual(WORKFLOW_LIMITS.nameMax);
        expect(t.description[l].length, `${t.id} description ${l}`).toBeGreaterThan(20);
        expect(t.description[l].length).toBeLessThanOrEqual(WORKFLOW_LIMITS.descriptionMax);
      }
      expect(t.title.ar).not.toBe(t.title.en);
    }
  });

  it("يُبنى مرّةً ويُجمَّد بعمق: أي محاولة تعديل ترمي، والنسخة واحدة", () => {
    expect(builtInWorkflowTemplates()).toBe(TEMPLATES);
    const t = TEMPLATES[0]!;
    for (const obj of [TEMPLATES, t, t.title, t.description, t.steps, t.steps[0]!]) expect(Object.isFrozen(obj)).toBe(true);
    expect(() => {
      (t.title as { ar: string }).ar = "عبث";
    }).toThrow();
    expect(() => {
      (t.steps as unknown[]).push({});
    }).toThrow();
    expect(t.title.ar).toBe("خطة تعلّم");
  });
});

describe("الخطوات والترتيب", () => {
  it("ترتيبٌ ثابت بمفاتيح فريدة وأنواع المرحلة 4A وحدها", () => {
    const shape = (id: string) => byId(id).steps.map((s) => `${s.key}:${s.kind}${s.kind === "skill" ? `=${s.skillId}` : ""}`);
    expect(shape("tpl-learning-plan")).toEqual(["goal:instruction", "units:instruction", "questions:skill=study-questions", "weekly-review:review"]);
    expect(shape("tpl-software-project-review")).toEqual(["scope:instruction", "explain-code:skill=explain-code", "checks:instruction", "team-review:review"]);
    expect(shape("tpl-scientific-research-plan")).toEqual([
      "question:instruction",
      "literature:skill=document-qa",
      "method:instruction",
      "summary:skill=summarize-text",
      "ethics-review:review",
    ]);
    for (const t of TEMPLATES) {
      expect(new Set(t.steps.map((s) => s.key)).size, t.id).toBe(t.steps.length);
      for (const s of t.steps) expect(WORKFLOW_STEP_KINDS as readonly string[]).toContain(s.kind);
      // يبدأ كل قالبٍ بتعليمات وينتهي بمراجعة يدوية: الإنسان في الحلقة
      expect(t.steps[0]?.kind, t.id).toBe("instruction");
      expect(t.steps.at(-1)?.kind, t.id).toBe("review");
    }
  });
});

describe("قواعد المسودة نفسها", () => {
  it("كل قالبٍ يمرّ بالتحقّق العادي باللغتين — بلا أي استثناء", () => {
    for (const t of TEMPLATES) {
      expect(templateIssues(t, KNOWN), t.id).toEqual({ ar: [], en: [] });
      for (const l of ["ar", "en"] as const) expect(validateWorkflow(instantiateTemplate(t, l), KNOWN).ok, `${t.id}/${l}`).toBe(true);
    }
  });

  it("مهارات القوالب من الفهرس المدمج، وبقرار سياسة الصلاحيات: سؤال المستندات معطّلة، والبقيّة تصريحية", () => {
    const referenced = TEMPLATES.flatMap((t) => t.steps.flatMap((s) => (s.kind === "skill" ? [s.skillId] : [])));
    expect(referenced).toEqual(["study-questions", "explain-code", "document-qa", "summarize-text"]);
    for (const id of referenced) {
      const skill = SKILLS.find((s) => s.id === id);
      expect(skill, id).toBeTruthy();
      expect(evaluateSkill(skill!).executable, id).toBe(id !== "document-qa");
    }
    const preview = buildWorkflowPreview(templatePreviewSteps(byId("tpl-scientific-research-plan"), "ar"), SKILLS);
    const literature = preview[1];
    expect(literature?.kind === "skill" && literature.skill?.executable).toBe(false);
    expect(preview.map((p) => p.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("قالبٌ يشير إلى مهارةٍ أُزيلت يُرفض بقاعدة المسودة نفسها باللغتين", () => {
    const broken = workflowTemplateSchema.parse({ ...JSON.parse(JSON.stringify(byId("tpl-learning-plan"))), steps: [{ key: "x", kind: "skill", skillId: "removed-skill" }] });
    const issues = templateIssues(broken, KNOWN);
    for (const l of ["ar", "en"] as const) expect(issues[l].map((i) => i.code), l).toEqual(["unknown_skill"]);
  });
});

describe("النسخ إلى مسودة", () => {
  it("مسودةٌ بمعرّفاتٍ جديدة من المولِّد — لا معرّف القالب ولا مفاتيح خطواته — وبنصوص لغة الواجهة", () => {
    const t = byId("tpl-learning-plan");
    for (const l of ["ar", "en"] as const) {
      const d = instantiateTemplate(t, l);
      expect(d.id).toMatch(WORKFLOW_ID_PATTERN);
      expect(d.id).not.toBe(t.id);
      expect(d.name).toBe(t.title[l]);
      expect(d.description).toBe(t.description[l]);
      expect(d.steps.map((s) => s.id).every((id) => STEP_ID_PATTERN.test(id))).toBe(true);
      expect(d.steps.map((s) => s.id)).not.toContain("goal");
      expect(d.steps.map((s) => (s.kind === "skill" ? s.skillId : s.text))).toEqual(
        t.steps.map((s) => (s.kind === "skill" ? s.skillId : s.text[l])),
      );
    }
  });

  it("الاستعمال المتكرّر لا يكرّر معرّفًا، والمسودة لا تشارك القالب شيئًا", () => {
    const t = byId("tpl-scientific-research-plan");
    const before = JSON.stringify(t);
    const drafts = Array.from({ length: 60 }, () => instantiateTemplate(t, "ar"));
    expect(new Set(drafts.map((d) => d.id)).size).toBe(60);
    const stepIds = drafts.flatMap((d) => d.steps.map((s) => s.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
    const d = drafts[0]!;
    (d.steps as { text?: string }[])[0]!.text = "تعديل في المسودة";
    d.name = "اسم آخر";
    expect(JSON.stringify(t)).toBe(before);
    expect(Object.isFrozen(d)).toBe(false);
  });

  it("المعاينة لا تولّد معرّفًا ولا تحفظ: مفاتيح القالب الثابتة معرّفات عرض", () => {
    const t = byId("tpl-software-project-review");
    expect(templatePreviewSteps(t, "en").steps.map((s) => s.id)).toEqual(t.steps.map((s) => s.key));
    expect(templatePreviewSteps(t, "en")).toEqual(templatePreviewSteps(t, "en"));
  });
});

describe("المخطّط يرفض ما ليس قالبًا مدمجًا تصريحيًّا", () => {
  const base = () => JSON.parse(JSON.stringify(byId("tpl-learning-plan"))) as Record<string, unknown>;
  const rejects = (over: Record<string, unknown>) => !workflowTemplateSchema.safeParse({ ...base(), ...over }).success;

  it("إصدارٌ آخر، و«مسودة فقط» غائبة أو كاذبة، وتصنيفٌ مجهول، ومفتاحٌ زائد", () => {
    expect(rejects({ templateVersion: 2 })).toBe(true);
    expect(rejects({ schemaVersion: 2 })).toBe(true);
    expect(rejects({ draftOnly: false })).toBe(true);
    const noDraftOnly = base();
    delete noDraftOnly.draftOnly;
    expect(workflowTemplateSchema.safeParse(noDraftOnly).success).toBe(false);
    expect(rejects({ category: "marketing" })).toBe(true);
    expect(rejects({ sourceUrl: "https://example.com/template.json" })).toBe(true);
    expect(rejects({ schedule: "daily" })).toBe(true);
  });

  it("معرّفٌ بغير شكل القالب (ومنه شكل المسودة) مرفوض", () => {
    for (const id of ["wf_000000000001", "learning-plan", "tpl-", "TPL-x", "tpl-a b"]) expect(rejects({ id }), id).toBe(true);
  });

  it("الخطوات: نوعٌ خارج القائمة، ومفتاحٌ مكرّر، ونصٌّ ناقصُ لغة، ومفتاحٌ زائد", () => {
    expect(rejects({ steps: [{ key: "a", kind: "run", text: { ar: "x", en: "x" } }] })).toBe(true);
    expect(rejects({ steps: [{ key: "a", kind: "instruction", text: { ar: "x", en: "x" } }, { key: "a", kind: "review", text: { ar: "y", en: "y" } }] })).toBe(true);
    expect(rejects({ steps: [{ key: "a", kind: "instruction", text: { ar: "x" } }] })).toBe(true);
    expect(rejects({ steps: [{ key: "a", kind: "instruction", text: { ar: "x", en: "x" }, command: "rm -rf" }] })).toBe(true);
    expect(rejects({ steps: [] })).toBe(true);
  });
});

describe("حدود الشيفرة", () => {
  it("الفهرس صافٍ: لا متصفح ولا شبكة ولا تنزيل ولا بيئة ولا تقييم ولا مؤقّتات", () => {
    const code = stripComments(read("lib/automations/templates.ts"));
    expect(code).not.toMatch(/\bwindow\b|localStorage|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|process\.env|\beval\(|new Function|setTimeout|setInterval|\bimport\(|https?:\/\//);
  });

  it("الصفحة تمرّر الفهرس المدمج من الخادم — لا تنزيل ولا مصدر خارجي", () => {
    const page = stripComments(read("app/(app)/automations/page.tsx"));
    expect(page).toMatch(/templates=\{builtInWorkflowTemplates\(\)\}/);
    expect(page).not.toMatch(/\bfetch\(|https?:\/\//);
  });
});
