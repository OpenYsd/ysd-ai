/**
 * المرحلة 4C — إدارة المسودات: البحث والترتيب وإنشاء النسخة، دوالّ صافية.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - البحث في الاسم والوصف بتطبيع البحث القائم: عربيّ بلا تشكيل ولا فرق ألفٍ وتاء، وإنجليزيّ بلا حالة أحرف.
 *   - الترتيب حتميّ: ترتيب الإنشاء هو المحفوظ، والاسم باتجاهيه والتعادل بالمعرّف، والمدخل لا يُمسّ.
 *   - النسخة مستقلّة: معرّفٌ جديد لا يطابق القائم (ولا يُستبدل شيء)، وخطواتٌ بمعرّفاتٍ جديدة، والأصل لا يتغيّر.
 *   - الاسم مع اللاحقة في حدود الاسم، والنسخة تمرّ بقواعد المسودة، والقوالب لا تُمسّ.
 *   - الشيفرة صافية.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { copyName, duplicateWorkflow, filterDrafts, sortDrafts, DRAFT_SORTS } from "@/lib/automations/manage";
import { STEP_ID_PATTERN, WORKFLOW_ID_PATTERN, WORKFLOW_LIMITS, newWorkflowId, validateWorkflow, workflowSchema, type Workflow } from "@/lib/automations/workflow";
import { builtInWorkflowTemplates, instantiateTemplate } from "@/lib/automations/templates";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const KNOWN = new Set(builtInSkillRegistry().list().map((s) => s.id));

let n = 0;
const wf = (name: string, description = "", id?: string): Workflow =>
  workflowSchema.parse({
    schemaVersion: 1,
    id: id ?? `wf_${String(++n).padStart(12, "0")}`,
    name,
    description,
    steps: [
      { id: `st_${String(++n).padStart(12, "0")}`, kind: "instruction", text: `خطوة ${name}` },
      { id: `st_${String(++n).padStart(12, "0")}`, kind: "skill", skillId: "explain-code" },
      { id: `st_${String(++n).padStart(12, "0")}`, kind: "review", text: "راجع" },
    ],
  });
const deepFreeze = <T,>(v: T): T => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
};

describe("البحث", () => {
  const list = deepFreeze([
    wf("مراجعة أسبوعية", "متابعة الإنجاز"),
    wf("Weekly review", "Check PROGRESS"),
    wf("خطة بحث", "سؤال البحث والفرضيات"),
    wf("مُذاكرة الرياضيات", ""),
  ]);
  const names = (q: string) => filterDrafts(list, q).map((w) => w.name);

  it("عربيّ بلا تشكيل ولا فرق الألف والتاء المربوطة والهاء — في الاسم والوصف", () => {
    expect(names("مراجعه")).toEqual(["مراجعة أسبوعية"]);
    expect(names("اسبوعيه")).toEqual(["مراجعة أسبوعية"]);
    expect(names("الانجاز")).toEqual(["مراجعة أسبوعية"]);
    expect(names("مذاكرة")).toEqual(["مُذاكرة الرياضيات"]);
    expect(names("الفرضيات")).toEqual(["خطة بحث"]);
  });

  it("إنجليزيّ بلا حساسيةٍ لحالة الأحرف — في الاسم والوصف", () => {
    expect(names("WEEKLY")).toEqual(["Weekly review"]);
    expect(names("progress")).toEqual(["Weekly review"]);
  });

  it("الفارغ والمسافات ⇒ الكلّ بترتيبه في نسخةٍ جديدة؛ ولا تطابق ⇒ لا شيء؛ والمدخل لا يُمسّ", () => {
    const all = filterDrafts(list, "   ");
    expect(all.map((w) => w.id)).toEqual(list.map((w) => w.id));
    expect(all).not.toBe(list);
    expect(names("zzzz")).toEqual([]);
    expect(Object.isFrozen(list[0])).toBe(true);
  });

  it("سريعٌ عند الحدّ: خمسون مسودة × ألف بحث", () => {
    const fifty = Array.from({ length: WORKFLOW_LIMITS.workflowsMax }, (_, i) => wf(`مسودة رقم ${i}`, `وصف طويل ${"نص ".repeat(100)}${i}`));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) filterDrafts(fifty, `رقم ${i % 50}`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("الترتيب", () => {
  const a = wf("ب", "", "wf_000000000003");
  const b = wf("أ", "", "wf_000000000002");
  const c = wf("ب", "", "wf_000000000001");
  const d = wf("ج", "", "wf_000000000004");
  const list = deepFreeze([a, b, c, d]);
  const ids = (s: (typeof DRAFT_SORTS)[number], l: "ar" | "en" = "ar") => sortDrafts(list, s, l).map((w) => w.id);

  it("الخيارات الثلاثة فقط — لا ترتيب بالتاريخ لأن المسودة لا تحمل وقتًا موثوقًا", () => {
    expect([...DRAFT_SORTS]).toEqual(["created", "name-asc", "name-desc"]);
    // المخطّط الصارم يرفض أي حقل وقت — فلا وقت تعديلٍ يُرتَّب به، ولا يُخترع
    const valid = JSON.parse(JSON.stringify(wf("وقت")));
    expect(workflowSchema.safeParse(valid).success).toBe(true);
    for (const k of ["updatedAt", "createdAt", "modifiedAt"]) expect(workflowSchema.safeParse({ ...valid, [k]: "2026-10-28T00:00:00Z" }).success, k).toBe(false);
  });

  it("ترتيب الإنشاء هو المحفوظ نفسه، في نسخةٍ جديدة", () => {
    expect(ids("created")).toEqual(list.map((w) => w.id));
    expect(sortDrafts(list, "created", "ar")).not.toBe(list);
  });

  it("الاسم تصاعديًّا وتنازليًّا، والتعادل يُحسم بالمعرّف تصاعديًّا في الاتجاهين", () => {
    expect(ids("name-asc")).toEqual(["wf_000000000002", "wf_000000000001", "wf_000000000003", "wf_000000000004"]);
    expect(ids("name-desc")).toEqual(["wf_000000000004", "wf_000000000001", "wf_000000000003", "wf_000000000002"]);
  });

  it("حتميّ: النداء المتكرّر بالنتيجة نفسها، والمدخل لا يُمسّ", () => {
    expect(ids("name-asc")).toEqual(ids("name-asc"));
    expect(list.map((w) => w.id)).toEqual(["wf_000000000003", "wf_000000000002", "wf_000000000001", "wf_000000000004"]);
  });

  it("الإنجليزية بلا حالة أحرف، والأرقام بترتيبها العددي", () => {
    const en = deepFreeze([wf("beta 10"), wf("Alpha"), wf("beta 2"), wf("alpha")]);
    const out = sortDrafts(en, "name-asc", "en").map((w) => w.name);
    expect(out.slice(0, 2).map((s) => s.toLowerCase())).toEqual(["alpha", "alpha"]);
    expect(out.slice(2)).toEqual(["beta 2", "beta 10"]);
  });
});

describe("النسخة", () => {
  it("الاسم مع اللاحقة في حدود الاسم — يُقصّ الأصل لا اللاحقة", () => {
    expect(copyName("خطة", " (نسخة)")).toBe("خطة (نسخة)");
    const long = "س".repeat(WORKFLOW_LIMITS.nameMax);
    const named = copyName(long, " (نسخة)");
    expect(named.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.nameMax);
    expect(named.endsWith(" (نسخة)")).toBe(true);
  });

  it("معرّفٌ جديد، وخطواتٌ بمعرّفاتٍ جديدة فريدة، والمحتوى نفسه بترتيبه — وتمرّ بقواعد المسودة", () => {
    const src = deepFreeze(wf("مصدر", "وصف المصدر"));
    const copy = duplicateWorkflow(src, { existingIds: new Set([src.id]), suffix: " (نسخة)" });
    expect(copy.id).toMatch(WORKFLOW_ID_PATTERN);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe("مصدر (نسخة)");
    expect(copy.description).toBe(src.description);
    expect(copy.steps.map((s) => s.id).every((id) => STEP_ID_PATTERN.test(id))).toBe(true);
    expect(new Set(copy.steps.map((s) => s.id)).size).toBe(copy.steps.length);
    for (const id of copy.steps.map((s) => s.id)) expect(src.steps.map((s) => s.id)).not.toContain(id);
    const strip = (w: Workflow) => w.steps.map((s) => (s.kind === "skill" ? `${s.kind}:${s.skillId}` : `${s.kind}:${s.text}`));
    expect(strip(copy)).toEqual(strip(src));
    expect(validateWorkflow(copy, KNOWN).ok).toBe(true);
  });

  it("مستقلّة حتى الخطوات المتداخلة: تعديل النسخة لا يمسّ الأصل، والأصل المجمَّد لا يُكتب فيه", () => {
    const src = deepFreeze(wf("أصل"));
    const before = JSON.stringify(src);
    const copy = duplicateWorkflow(src, { existingIds: new Set(), suffix: " (copy)" });
    expect(copy.steps).not.toBe(src.steps);
    copy.steps.forEach((s, i) => expect(s).not.toBe(src.steps[i]));
    (copy.steps[0] as { text: string }).text = "تغيّر في النسخة";
    copy.steps.reverse();
    copy.name = "اسم آخر";
    expect(JSON.stringify(src)).toBe(before);
  });

  it("لا يُستبدل شيء بصمت: معرّفٌ يطابق مسودةً قائمة يُعاد توليده، والاستحالة تُرمى", () => {
    const src = wf("x");
    const taken = "wf_aaaaaaaaaaaa";
    const queue = [taken, taken, "wf_bbbbbbbbbbbb"];
    const copy = duplicateWorkflow(src, { existingIds: new Set([taken, src.id]), suffix: " (نسخة)", workflowId: () => queue.shift()! });
    expect(copy.id).toBe("wf_bbbbbbbbbbbb");
    expect(() => duplicateWorkflow(src, { existingIds: new Set([taken]), suffix: "", workflowId: () => taken })).toThrow();
  });

  it("خمسون نسخة من مسودةٍ واحدة بلا تصادم معرّفات", () => {
    const src = wf("متكرّرة");
    const existing = new Set([src.id]);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const copy = duplicateWorkflow(src, { existingIds: existing, suffix: " (نسخة)" });
      expect(existing.has(copy.id)).toBe(false);
      existing.add(copy.id);
      ids.add(copy.id);
    }
    expect(ids.size).toBe(50);
  });

  it("مع القوالب (4B): نسخة مسودةٍ من قالب صالحة، والقالب الأصلي لا يتغيّر", () => {
    const templates = builtInWorkflowTemplates();
    const before = JSON.stringify(templates);
    for (const t of templates) {
      const draft = instantiateTemplate(t, "ar");
      const copy = duplicateWorkflow(draft, { existingIds: new Set([draft.id]), suffix: " (نسخة)" });
      expect(validateWorkflow(copy, KNOWN).ok, t.id).toBe(true);
      expect(copy.id).not.toBe(t.id);
    }
    expect(JSON.stringify(templates)).toBe(before);
  });

  it("المولِّد الافتراضي هو المولِّد المعتمد (wf_…)", () => {
    expect(duplicateWorkflow(wf("y"), { existingIds: new Set(), suffix: "" }).id).toMatch(WORKFLOW_ID_PATTERN);
    expect(newWorkflowId()).toMatch(WORKFLOW_ID_PATTERN);
  });
});

describe("حدود الشيفرة", () => {
  it("صافية: لا متصفح ولا شبكة ولا بيئة ولا مؤقّتات ولا تقييم ولا وقت", () => {
    const code = stripComments(read("lib/automations/manage.ts"));
    expect(code).not.toMatch(/\bwindow\b|localStorage|\bfetch\(|XMLHttpRequest|WebSocket|process\.env|\beval\(|new Function|setTimeout|setInterval|\bimport\(|Date\.now|new Date/);
  });
});
