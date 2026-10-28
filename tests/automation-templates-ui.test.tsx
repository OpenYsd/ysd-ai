/**
 * المرحلة 4B — القوالب في مساحة الأتمتة: التصفّح والمعاينة والاستخدام والحفظ الصريح، بالمكوّنات الحقيقية.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - المعرض: ثلاث بطاقات بالعنوان والتصنيف ووسم «قالب · مسودة فقط» وعدد الخطوات، وفعلان مسمّيان.
 *   - المعاينة للقراءة: الخطوات بترتيبها، والمهارة المعطّلة والمحذوفة معلنتان، ولا حقل، ولا حفظ.
 *   - «استخدام القالب» يفتح المحرّر بمسودةٍ مستقلّة ولا يحفظ شيئًا؛ الحفظ بفعلٍ صريح وتحقّقٍ ناجح وحدهما.
 *   - التعديلات قبل الحفظ: الاسم والوصف والترتيب والمحتوى — والمحفوظ بمعرّفاتٍ جديدة لا معرّف القالب.
 *   - الاستخدام المتكرّر بلا تصادم معرّفات، والقالب لا يتغيّر.
 *   - التعديلات غير المحفوظة لا تُتجاهل بصمت: تجاهلٌ صريح أو متابعة.
 *   - التخزين الممتلئ والتالف، وعزل الحسابات، والمهارة المحذوفة، واللغتان، والإماهة، والوضع الصارم.
 *   - لا شبكة ولا تنقّل ولا نداء نموذج.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/automations",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { AutomationsView } from "@/components/automations/automations-view";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { DRAFTS_KEY_PREFIX, draftsStorageKey } from "@/lib/automations/drafts";
import { automationDraftsScopeFor } from "@/lib/automations/drafts-scope";
import { builtInWorkflowTemplates, workflowTemplateSchema, type WorkflowTemplate } from "@/lib/automations/templates";
import { STEP_ID_PATTERN, WORKFLOW_ID_PATTERN, type Workflow } from "@/lib/automations/workflow";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const SKILLS = builtInSkillRegistry()
  .list()
  .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
const TEMPLATES = builtInWorkflowTemplates();
const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const LEARNING = tpl("tpl-learning-plan");
const RESEARCH = tpl("tpl-scientific-research-plan");
const skillName = (id: string, l: Locale = "ar") => SKILLS.find((s) => s.id === id)!.name[l];

const L = {
  gallery: "قوالب جاهزة",
  list: "القوالب",
  badge: "قالب · مسودة فقط",
  view: "عرض الخطوات",
  use: "استخدام القالب",
  back: "العودة إلى المسودات",
  previewNote: "معاينة قالبٍ للقراءة فقط: لا يُحفظ شيء ولا يُنفَّذ. «استخدام القالب» يفتح مسودةً جديدة في المحرّر، ولا تُحفظ إلا حين تحفظها بنفسك.",
  origin: "من القالب",
  name: "اسم سير العمل",
  description: "الوصف (اختياري)",
  stepsHeading: "الخطوات بالترتيب",
  stepText: "نص الخطوة",
  stepSkill: "المهارة",
  save: "حفظ المسودة",
  cancel: "إلغاء",
  discard: "تجاهل التعديلات",
  keep: "متابعة التعديل",
  discardGroup: "تأكيد تجاهل التعديلات",
  draftsList: "مسودات سير العمل",
  saved: "حُفظت المسودة.",
  notSaved: "تعذّر الحفظ في هذا المتصفح — تبقى المسودات حتى تُغلق التبويب أو تُعيد تحميله.",
  notExecutable: "تعتمد على صلاحية غير مفعّلة في هذا الإصدار.",
  skillUnknown: "لا توجد مهارة بهذا المعرّف في الفهرس المدمج.",
  unknownSkillIssue: "الخطوة 1: هذه المهارة غير موجودة في الفهرس المدمج.",
  disabled: "غير مفعّلة في هذا الإصدار",
  empty: "لا قوالب متاحة حاليًّا.",
  categories: { learning: "التعلّم", software: "البرمجيات", research: "البحث العلمي" },
} as const;
const PROMISE = /تشغيل|شغّل|تفعيل|فعّل|جدولة|نفّذ الآن|قريبًا|\brun\b|activate|enable|schedule|execute|trigger|install|download|coming soon/i;

const newScope = () => automationDraftsScopeFor(randomUUID());
const keyOf = (scope: string) => draftsStorageKey(scope)!;
const stored = (scope: string): { v: number; workflows: Workflow[] } | null => {
  const raw = window.localStorage.getItem(keyOf(scope));
  return raw === null ? null : JSON.parse(raw);
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const view = (locale: Locale, scope: string | null | undefined, templates: readonly WorkflowTemplate[] = TEMPLATES) => (
  <I18nProvider initialLocale={locale}>
    <AutomationsView skills={SKILLS} draftsScope={scope} templates={templates} />
  </I18nProvider>
);
const btn = (name: string) => screen.getByRole("button", { name });
const gallery = () => document.querySelector<HTMLElement>("[data-template-gallery]")!;
const cards = (l: Locale = "ar") => within(within(gallery()).getByRole("list", { name: l === "ar" ? L.list : "Templates" })).getAllByRole("listitem");
const editorSteps = (l: Locale = "ar") => within(screen.getByRole("list", { name: l === "ar" ? L.stepsHeading : "Steps in order" })).getAllByRole("listitem");
const editorValues = (l: Locale = "ar") =>
  editorSteps(l).map((li) => {
    const field = li.querySelector<HTMLTextAreaElement | HTMLSelectElement>("textarea, select")!;
    return field.value;
  });
const draftNames = () =>
  within(screen.getByRole("list", { name: L.draftsList }))
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
const useTemplate = (t: WorkflowTemplate, l: Locale = "ar") => fireEvent.click(btn(`${l === "ar" ? L.use : "Use template"}: ${t.title[l]}`));

describe("المعرض", () => {
  it("ثلاث بطاقات بالعنوان والتصنيف والوسم والوصف وعدد الخطوات، وفعلان مسمّيان — ولا شيء يُحفظ", () => {
    const scope = newScope();
    render(view("ar", scope));
    expect(within(gallery()).getByRole("heading", { level: 2 }).textContent).toBe(L.gallery);
    const items = cards();
    expect(items.map((li) => li.getAttribute("data-template-id"))).toEqual(TEMPLATES.map((t) => t.id));
    items.forEach((li, i) => {
      const t = TEMPLATES[i]!;
      expect(within(li).getByRole("heading", { level: 3 }).textContent).toBe(t.title.ar);
      expect(within(li).getByText(L.categories[t.category])).toBeTruthy();
      expect(within(li).getByText(L.badge)).toBeTruthy();
      expect(within(li).getByText(t.description.ar)).toBeTruthy();
      expect(li.textContent).toContain(`الخطوات: ${t.steps.length}`);
      expect(within(li).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([`${L.view}: ${t.title.ar}`, `${L.use}: ${t.title.ar}`]);
    });
    for (const b of screen.getAllByRole("button")) expect(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`).not.toMatch(PROMISE);
    expect(stored(scope)).toBeNull();
  });

  it("فهرسٌ فارغ يُعلن صراحةً، بلا أزرار قوالب", () => {
    render(view("ar", newScope(), []));
    expect(within(gallery()).getByRole("status").textContent).toBe(L.empty);
    expect(within(gallery()).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("معاينة القالب", () => {
  it("للقراءة: الخطوات بترتيبها، والمعطّلة معلنة، ولا حقل، وزرّان فقط، ولا حفظ", () => {
    const scope = newScope();
    render(view("ar", scope));
    fireEvent.click(btn(`${L.view}: ${RESEARCH.title.ar}`));
    const section = document.querySelector<HTMLElement>(`[data-template-preview="${RESEARCH.id}"]`)!;
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe(RESEARCH.title.ar);
    expect(within(section).getByRole("note").textContent).toBe(L.previewNote);
    expect(within(section).getByText(L.categories.research)).toBeTruthy();
    const items = within(within(section).getByRole("list", { name: L.stepsHeading })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-step-kind"))).toEqual(["instruction", "skill", "instruction", "skill", "review"]);
    expect(items[0]!.textContent).toContain(RESEARCH.steps[0]!.kind === "instruction" ? RESEARCH.steps[0]!.text.ar : "");
    expect(items[1]!.textContent).toContain(skillName("document-qa"));
    expect(within(items[1]!).getByText(L.notExecutable)).toBeTruthy();
    expect(within(items[1]!).getByTitle(L.disabled)).toBeTruthy();
    expect(items[3]!.textContent).toContain(skillName("summarize-text"));
    expect(within(items[3]!).queryByText(L.notExecutable)).toBeNull();
    expect(section.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual([L.use, L.back]);
    expect(stored(scope)).toBeNull();
    fireEvent.click(btn(L.back));
    expect(cards()).toHaveLength(3);
  });
});

describe("المسودة من القالب", () => {
  it("«استخدام القالب» يفتح المحرّر بنسخةٍ كاملة ولا يحفظ شيئًا؛ والحفظ الصريح وحده يكتب", () => {
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(LEARNING);
    expect(document.querySelector("[data-editor-origin]")?.textContent).toBe(`${L.origin}: ${LEARNING.title.ar}`);
    expect((screen.getByLabelText(L.name) as HTMLInputElement).value).toBe(LEARNING.title.ar);
    expect((screen.getByLabelText(L.description) as HTMLTextAreaElement).value).toBe(LEARNING.description.ar);
    expect(editorSteps().map((li) => li.getAttribute("data-step-kind"))).toEqual(LEARNING.steps.map((s) => s.kind));
    expect(editorValues()).toEqual(LEARNING.steps.map((s) => (s.kind === "skill" ? s.skillId : s.text.ar)));
    // لا حفظ ولا إعلان قبل الفعل الصريح
    expect(stored(scope)).toBeNull();
    expect(document.querySelector("[data-drafts-notice]")).toBeNull();
    fireEvent.click(btn(L.save));
    const s = stored(scope)!;
    expect(s.workflows).toHaveLength(1);
    const w = s.workflows[0]!;
    expect(w.id).toMatch(WORKFLOW_ID_PATTERN);
    expect(w.id).not.toBe(LEARNING.id);
    expect(w.steps.every((x) => STEP_ID_PATTERN.test(x.id))).toBe(true);
    expect(w.steps.map((x) => x.id)).not.toContain("goal");
    expect(screen.getByRole("status").textContent).toBe(L.saved);
    expect(draftNames()).toEqual([LEARNING.title.ar]);
  });

  it("تعديل الاسم والوصف والترتيب والمحتوى قبل الحفظ — والقالب الأصلي لا يتغيّر", () => {
    const before = JSON.stringify(TEMPLATES);
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(RESEARCH);
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "بحثي عن التربة" } });
    fireEvent.change(screen.getByLabelText(L.description), { target: { value: "نسختي" } });
    fireEvent.change(within(editorSteps()[0]!).getByLabelText(L.stepText), { target: { value: "ما أثر الملوحة في نموّ القمح؟" } });
    fireEvent.click(btn("تحريك لأعلى: الخطوة 3"));
    fireEvent.click(btn("حذف الخطوة: الخطوة 4"));
    fireEvent.click(btn(L.save));
    const w = stored(scope)!.workflows[0]!;
    expect(w.name).toBe("بحثي عن التربة");
    expect(w.description).toBe("نسختي");
    expect(w.steps.map((s) => (s.kind === "skill" ? s.skillId : s.text))).toEqual([
      "ما أثر الملوحة في نموّ القمح؟",
      RESEARCH.steps[2]!.kind === "instruction" ? RESEARCH.steps[2]!.text.ar : "",
      "document-qa",
      RESEARCH.steps[4]!.kind === "review" ? RESEARCH.steps[4]!.text.ar : "",
    ]);
    expect(JSON.stringify(TEMPLATES)).toBe(before);
    expect(Object.isFrozen(RESEARCH.steps[0])).toBe(true);
  });

  it("الاستخدام المتكرّر لقالبٍ واحد: مسودتان مستقلّتان بلا تصادم معرّفات", () => {
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(LEARNING);
    fireEvent.click(btn(L.save));
    useTemplate(LEARNING);
    fireEvent.click(btn(L.save));
    const [a, b] = stored(scope)!.workflows;
    expect(a!.id).not.toBe(b!.id);
    const sa = new Set(a!.steps.map((s) => s.id));
    expect(b!.steps.some((s) => sa.has(s.id))).toBe(false);
    expect(draftNames()).toEqual([LEARNING.title.ar, LEARNING.title.ar]);
  });

  it("مسودة القالب مسودةٌ عادية بعد الحفظ: تُعاين وتُعدَّل بمحرّر المرحلة 4A", () => {
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(RESEARCH);
    fireEvent.click(btn(L.save));
    fireEvent.click(btn(`معاينة: ${RESEARCH.title.ar}`));
    const items = within(document.querySelector<HTMLElement>("[data-workflow-preview]")!).getAllByRole("listitem");
    expect(within(items[1]!).getByText(L.notExecutable)).toBeTruthy();
    fireEvent.click(btn("تعديل"));
    expect(document.querySelector("[data-editor-origin]")).toBeNull();
    expect((screen.getByLabelText(L.name) as HTMLInputElement).value).toBe(RESEARCH.title.ar);
  });
});

describe("التعديلات غير المحفوظة", () => {
  it("الإلغاء مع تعديلات: تأكيدٌ صريح يُركَّز فيه على «متابعة التعديل»؛ المتابعة تُبقي، والتجاهل يُغلق بلا حفظ", () => {
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(LEARNING);
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "خطتي أنا" } });
    fireEvent.click(btn(L.cancel));
    const group = screen.getByRole("group", { name: L.discardGroup });
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: L.keep }));
    fireEvent.click(within(group).getByRole("button", { name: L.keep }));
    expect(screen.queryByRole("group", { name: L.discardGroup })).toBeNull();
    expect((screen.getByLabelText(L.name) as HTMLInputElement).value).toBe("خطتي أنا");
    fireEvent.click(btn(L.cancel));
    fireEvent.click(within(screen.getByRole("group", { name: L.discardGroup })).getByRole("button", { name: L.discard }));
    expect(screen.queryByLabelText(L.name)).toBeNull();
    expect(cards()).toHaveLength(3);
    expect(stored(scope)).toBeNull();
  });

  it("بلا تعديلات: الإلغاء يُغلق مباشرةً — والقالب ما زال متاحًا", () => {
    render(view("ar", newScope()));
    useTemplate(LEARNING);
    fireEvent.click(btn(L.cancel));
    expect(screen.queryByRole("group", { name: L.discardGroup })).toBeNull();
    expect(screen.queryByLabelText(L.name)).toBeNull();
    expect(cards()).toHaveLength(3);
  });

  it("المعرض لا يُعرض أثناء التحرير — فلا يستبدل قالبٌ مسودةً مفتوحة", () => {
    render(view("ar", newScope()));
    useTemplate(LEARNING);
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "قيد التحرير" } });
    expect(document.querySelector("[data-template-gallery]")).toBeNull();
    expect(screen.queryByRole("button", { name: `${L.use}: ${RESEARCH.title.ar}` })).toBeNull();
  });

  it("امتلاء التخزين عند الحفظ: لا تضيع المسودة — تبقى للجلسة و«لم تُحفظ» معلنة", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(LEARNING);
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "لا تضيع" } });
    fireEvent.click(btn(L.save));
    expect(draftNames()).toEqual(["لا تضيع"]);
    expect(document.querySelector("[data-drafts-not-saved]")?.textContent).toBe(L.notSaved);
    expect(window.localStorage.getItem(keyOf(scope))).toBeNull();
  });

  it("قيمةٌ تالفة في التخزين لا تمنع البدء من قالب، والحفظ يكتب الشكل الصحيح", () => {
    const scope = newScope();
    window.localStorage.setItem(keyOf(scope), "{");
    render(view("ar", scope));
    expect(cards()).toHaveLength(3);
    useTemplate(LEARNING);
    fireEvent.click(btn(L.save));
    expect(stored(scope)!.workflows.map((w) => w.name)).toEqual([LEARNING.title.ar]);
  });
});

describe("عزل الحسابات", () => {
  it("مسودة القالب لحسابها: الحساب الآخر لا يراها، والعودة تعيدها", () => {
    const a = newScope();
    const b = newScope();
    const { rerender } = render(view("ar", a));
    useTemplate(LEARNING);
    fireEvent.click(btn(L.save));
    rerender(view("ar", b));
    expect(screen.queryByRole("list", { name: L.draftsList })).toBeNull();
    expect(cards()).toHaveLength(3);
    useTemplate(RESEARCH);
    fireEvent.click(btn(L.save));
    rerender(view("ar", a));
    expect(draftNames()).toEqual([LEARNING.title.ar]);
    expect(stored(a)!.workflows.map((w) => w.name)).toEqual([LEARNING.title.ar]);
    expect(stored(b)!.workflows.map((w) => w.name)).toEqual([RESEARCH.title.ar]);
  });

  it("محرّر قالبٍ مفتوح بتعديلات، ثم تبدّل الحساب: يُغلق، ولا يُكتب شيء تحت مفتاح الآخر", () => {
    const a = newScope();
    const b = newScope();
    const { rerender } = render(view("ar", a));
    useTemplate(LEARNING);
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "تعديل من أ" } });
    rerender(view("ar", b));
    expect(screen.queryByLabelText(L.name)).toBeNull();
    expect(document.body.textContent).not.toContain("تعديل من أ");
    expect(stored(a)).toBeNull();
    expect(stored(b)).toBeNull();
  });
});

describe("الصلاحيات والمهارات", () => {
  const withRemoved = workflowTemplateSchema.parse({
    templateVersion: 1,
    id: "tpl-test-removed-skill",
    schemaVersion: 1,
    category: "research",
    draftOnly: true,
    title: { ar: "قالب بمهارة محذوفة", en: "Template with a removed skill" },
    description: { ar: "قالب اختبار يشير إلى مهارة لم تعد في الفهرس.", en: "A test template that points to a skill no longer in the catalog." },
    steps: [
      { key: "gone", kind: "skill", skillId: "removed-skill" },
      { key: "check", kind: "review", text: { ar: "راجع", en: "Review" } },
    ],
  });

  it("مهارةٌ محذوفة: «غير موجودة» في المعاينة، ومحرّرها لا يحفظها — مثل أي مسودة", () => {
    const scope = newScope();
    render(view("ar", scope, [withRemoved]));
    fireEvent.click(btn(`${L.view}: ${withRemoved.title.ar}`));
    const items = within(document.querySelector<HTMLElement>("[data-template-preview]")!).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain(L.skillUnknown);
    fireEvent.click(btn(L.use));
    const select = within(editorSteps()[0]!).getByLabelText(L.stepSkill) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("مهارة غير معروفة");
    fireEvent.click(btn(L.save));
    expect(within(screen.getByRole("alert")).getByText(L.unknownSkillIssue)).toBeTruthy();
    expect(stored(scope)).toBeNull();
  });

  it("مهارةٌ معطّلة الصلاحية تبقى مرجعًا لا يُنفَّذ: في محرّر القالب موسومة، والمسودة تُحفظ مسودة", () => {
    const scope = newScope();
    render(view("ar", scope));
    useTemplate(RESEARCH);
    const select = within(editorSteps()[1]!).getByLabelText(L.stepSkill) as HTMLSelectElement;
    expect(select.value).toBe("document-qa");
    expect(select.selectedOptions[0]?.textContent).toBe(`${skillName("document-qa")} — تعتمد على صلاحية معطّلة`);
    fireEvent.click(btn(L.save));
    expect(stored(scope)!.workflows[0]!.steps[1]).toMatchObject({ kind: "skill", skillId: "document-qa" });
  });
});

describe("اللغتان والإماهة والوضع الصارم والحدود", () => {
  it("الإنجليزية: المعرض والمعاينة والمحرّر بنصوص القالب الإنجليزية", () => {
    const scope = newScope();
    render(view("en", scope));
    expect(within(gallery()).getByRole("heading", { level: 2 }).textContent).toBe("Ready-made templates");
    expect(within(cards("en")[2]!).getByText("Scientific research")).toBeTruthy();
    expect(within(cards("en")[0]!).getByText("Template · draft only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `View steps: ${RESEARCH.title.en}` }));
    expect(screen.getAllByRole("note").map((n) => n.textContent).join(" ")).toContain("Read-only template preview");
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));
    expect((screen.getByLabelText("Workflow name") as HTMLInputElement).value).toBe(RESEARCH.title.en);
    expect(document.querySelector("[data-editor-origin]")?.textContent).toBe(`From template: ${RESEARCH.title.en}`);
    expect(editorValues("en")[0]).toBe(RESEARCH.steps[0]!.kind === "instruction" ? RESEARCH.steps[0]!.text.en : "");
  });

  it("HTML الخادم: المعرض ثابتٌ ومتطابقٌ بين حسابين، وأزراره معطّلة قبل الإماهة؛ والإماهة بلا خطأ ثم تتفعّل", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = newScope();
    const b = newScope();
    for (const locale of ["ar", "en"] as const) {
      const html = renderToString(view(locale, a));
      expect(html, locale).toBe(renderToString(view(locale, b)));
      for (const t of TEMPLATES) expect(html, `${locale}/${t.id}`).toContain(t.title[locale]);
      const probe = document.createElement("div");
      probe.innerHTML = html;
      const tplButtons = Array.from(probe.querySelectorAll<HTMLButtonElement>("[data-template-gallery] button"));
      expect(tplButtons, locale).toHaveLength(6);
      expect(tplButtons.every((x) => x.disabled), locale).toBe(true);

      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.appendChild(container);
      const recoverable: unknown[] = [];
      render(view(locale, a), { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
      expect(recoverable, locale).toEqual([]);
      await waitFor(() => expect(Array.from(container.querySelectorAll<HTMLButtonElement>("[data-template-gallery] button")).every((x) => !x.disabled), locale).toBe(true));
      cleanup();
      container.remove();
    }
    expect(consoleError.mock.calls.filter((c) => /hydrat|#418|#423|#425/i.test(c.map(String).join(" ")))).toEqual([]);
  });

  it("الوضع الصارم: استخدامٌ واحد وحفظٌ واحد ⇒ مسودةٌ واحدة", () => {
    const scope = newScope();
    render(<StrictMode>{view("ar", scope)}</StrictMode>);
    useTemplate(LEARNING);
    fireEvent.click(btn(L.save));
    expect(stored(scope)!.workflows).toHaveLength(1);
  });

  it("لا شبكة ولا تنقّل ولا نداء نموذج — عبر التصفّح والمعاينة والاستخدام والتعديل والحفظ والحذف", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const href = window.location.href;
    const scope = newScope();
    render(view("ar", scope));
    fireEvent.click(btn(`${L.view}: ${LEARNING.title.ar}`));
    fireEvent.click(btn(L.use));
    fireEvent.change(screen.getByLabelText(L.name), { target: { value: "بلا شبكة" } });
    fireEvent.click(btn(L.save));
    fireEvent.click(btn("حذف: بلا شبكة"));
    fireEvent.click(within(screen.getByRole("group", { name: "تأكيد الحذف" })).getByRole("button", { name: "تأكيد الحذف" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const fn of Object.values(nav)) expect(fn).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const k of Object.keys(window.localStorage)) expect(k.startsWith(DRAFTS_KEY_PREFIX)).toBe(true);
  });
});
