/**
 * المرحلة 4A — مساحة الأتمتة: القائمة والمحرّر والمعاينة بالمكوّنات الحقيقية.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - الإنشاء والتعديل والحذف (بتأكيد) يُحفظ في مفتاح المستخدم وحده بالشكل الصارم، والقائمة تتبعه.
 *   - الخطوات تُضاف وتُحرَّك وتُحذف، والترتيب المحفوظ والمعاينة يطابقان ما في المحرّر.
 *   - التحقّق معلَن: ملخّص alert مركَّزٌ عليه، وكل حقلٍ خاطئ aria-invalid بوصفٍ مربوط، ولا حفظ.
 *   - المعاينة للقراءة: لا حقول، والمهارة المعطّلة والمحذوفة معلنتان، وزرّا التعديل والعودة وحدهما.
 *   - لا زرّ تشغيلٍ ولا تفعيل، ولا شبكة ولا تنقّل، والصفحة تقول «مسودات فقط».
 *   - عزل الحسابات في التخزين وفي ذاكرة التبويب، والتخزين التالف والمحجوب والممتلئ، والحدّ خمسون.
 *   - الوضع الصارم، وHTML الخادم لا يعرف المسودات ولا النطاق، والإماهة بلا خطأ.
 *   - العربية من اليمين والإنجليزية من اليسار.
 *
 * يُستبدل الموجّه وزرّ قائمة الجوال وحدهما.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/automations",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { AutomationsView } from "@/components/automations/automations-view";
import { useWorkflowDrafts } from "@/components/automations/use-workflow-drafts";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { DRAFTS_KEY_PREFIX, draftsStorageKey } from "@/lib/automations/drafts";
import { automationDraftsScopeFor } from "@/lib/automations/drafts-scope";
import { workflowSchema, type Workflow } from "@/lib/automations/workflow";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const SKILLS = builtInSkillRegistry()
  .list()
  .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
const nameOf = (id: string, l: Locale = "ar") => SKILLS.find((s) => s.id === id)!.name[l];

const L = {
  ar: {
    title: "الأتمتة",
    note: "مسودات فقط في هذا الإصدار: لا تشغيل، ولا جدولة، ولا تنفيذ في الخلفية، ولا اتصال بأي نموذج.",
    empty: "لا مسودات بعد. أنشئ مسودة سير عمل لتصمّم خطواتها وتعاينها.",
    newDraft: "مسودة جديدة",
    list: "مسودات سير العمل",
    badge: "مسودة · لا تُنفَّذ",
    name: "اسم سير العمل",
    description: "الوصف (اختياري)",
    stepsHeading: "الخطوات بالترتيب",
    stepText: "نص الخطوة",
    stepSkill: "المهارة",
    addInstruction: "إضافة تعليمات",
    addSkill: "إضافة مهارة",
    addReview: "إضافة مراجعة يدوية",
    save: "حفظ المسودة",
    cancel: "إلغاء",
    saved: "حُفظت المسودة.",
    deleted: "حُذفت المسودة.",
    summary: "لم تُحفظ المسودة. صحّح ما يلي:",
    nameRequired: "الاسم مطلوب.",
    textRequired: "نص الخطوة مطلوب.",
    unknownSkill: "هذه المهارة غير موجودة في الفهرس المدمج.",
    limit: "بلغت حدّ 50 مسودة؛ احذف مسودة لتحفظ غيرها.",
    previewNote: "معاينة للقراءة فقط: الخطوات تُعرض ولا تُنفَّذ، ولا يُرسل شيء إلى أي نموذج.",
    notExecutable: "تعتمد على صلاحية غير مفعّلة في هذا الإصدار.",
    skillUnknown: "لا توجد مهارة بهذا المعرّف في الفهرس المدمج.",
    edit: "تعديل",
    preview: "معاينة",
    del: "حذف",
    confirm: "تأكيد الحذف",
    back: "العودة إلى المسودات",
    notSaved: "تعذّر الحفظ في هذا المتصفح — تبقى المسودات حتى تُغلق التبويب أو تُعيد تحميله.",
    unavailable: "تعذّر ربط المسودات بحسابك، فلا تُنشأ هنا.",
    disabled: "غير مفعّلة في هذا الإصدار",
  },
  en: {
    title: "Automations",
    note: "Drafts only in this version: no running, no scheduling, no background execution and no model calls.",
    newDraft: "New draft",
    name: "Workflow name",
    stepText: "Step text",
    save: "Save draft",
    badge: "Draft · not executable",
    previewNote: "Read-only preview: steps are shown, never executed, and nothing is sent to any model.",
    back: "Back to drafts",
  },
} as const;

/** ما لا يجوز أن يعد به زرٌّ ما دام التنفيذ لم يُبنَ */
const PROMISE = /تشغيل|شغّل|تفعيل|فعّل|جدولة|نفّذ الآن|قريبًا|\brun\b|activate|enable|schedule|execute|trigger|coming soon/i;

const newScope = () => automationDraftsScopeFor(randomUUID());
const keyOf = (scope: string) => draftsStorageKey(scope)!;
const stored = (scope: string): { v: number; workflows: Workflow[] } | null => {
  const raw = window.localStorage.getItem(keyOf(scope));
  return raw === null ? null : JSON.parse(raw);
};
let seq = 0;
const wf = (name: string, steps: Workflow["steps"] = [{ id: `st_${String(++seq).padStart(12, "0")}`, kind: "instruction", text: `نص ${name}` }]): Workflow =>
  workflowSchema.parse({ schemaVersion: 1, id: `wf_${String(++seq).padStart(12, "0")}`, name, description: "", steps });
const seed = (scope: string, workflows: Workflow[]) => window.localStorage.setItem(keyOf(scope), JSON.stringify({ v: 1, workflows }));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const view = (locale: Locale, scope: string | null | undefined) => (
  <I18nProvider initialLocale={locale}>
    <AutomationsView skills={SKILLS} draftsScope={scope} />
  </I18nProvider>
);
const btn = (name: string) => screen.getByRole("button", { name });
const editorSteps = () => within(screen.getByRole("list", { name: L.ar.stepsHeading })).getAllByRole("listitem");
const cardNames = () =>
  within(screen.getByRole("list", { name: L.ar.list }))
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);

/** مسودةٌ من الواجهة: اسمٌ، ونصّ الخطوة الأولى، وما يُضاف بعدها */
function createViaUi(name: string, firstText: string, extra: (() => void)[] = []) {
  fireEvent.click(btn(L.ar.newDraft));
  fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: name } });
  fireEvent.change(within(editorSteps()[0]!).getByLabelText(L.ar.stepText), { target: { value: firstText } });
  for (const f of extra) f();
  fireEvent.click(btn(L.ar.save));
}

describe("القائمة والوسوم", () => {
  it("فراغٌ يقول كيف تبدأ، والصفحة تقول «مسودات فقط»، ولا زرّ يعد بتشغيل", () => {
    render(view("ar", newScope()));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(L.ar.title);
    expect(screen.getByRole("note").textContent).toBe(L.ar.note);
    expect(screen.getByRole("status").textContent).toBe(L.ar.empty);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([L.ar.newDraft]);
    for (const b of buttons) expect(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`).not.toMatch(PROMISE);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("الإنشاء والتعديل والحذف", () => {
  it("الإنشاء يحفظ في مفتاح المستخدم وحده بالشكل الصارم، والبطاقة تحمل وسم المسودة وعدد الخطوات", () => {
    const scope = newScope();
    render(view("ar", scope));
    createViaUi("  مراجعة أسبوعية  ", "اجمع الملاحظات");
    expect(screen.getByRole("status").textContent).toBe(L.ar.saved);
    expect(cardNames()).toEqual(["مراجعة أسبوعية"]);
    const card = within(screen.getByRole("list", { name: L.ar.list })).getByRole("listitem");
    expect(within(card).getByText(L.ar.badge)).toBeTruthy();
    expect(card.textContent).toContain("الخطوات: 1");
    const s = stored(scope)!;
    expect(s.v).toBe(1);
    expect(s.workflows).toHaveLength(1);
    const w = s.workflows[0]!;
    expect(Object.keys(w).sort()).toEqual(["description", "id", "name", "schemaVersion", "steps"]);
    expect(w).toMatchObject({ schemaVersion: 1, name: "مراجعة أسبوعية", description: "" });
    expect(w.id).toMatch(/^wf_[a-z0-9]{12}$/);
    expect(w.steps).toEqual([{ id: expect.stringMatching(/^st_[a-z0-9]{12}$/), kind: "instruction", text: "اجمع الملاحظات" }]);
    expect(Object.keys(window.localStorage)).toEqual([keyOf(scope)]);
  });

  it("الخطوات: إضافةٌ بأنواعها الثلاثة، وتحريك، وحذف — والمحفوظ بالترتيب المرئي", () => {
    const scope = newScope();
    render(view("ar", scope));
    fireEvent.click(btn(L.ar.newDraft));
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "ترتيب" } });
    fireEvent.change(within(editorSteps()[0]!).getByLabelText(L.ar.stepText), { target: { value: "أولًا" } });
    fireEvent.click(btn(L.ar.addSkill));
    fireEvent.change(within(editorSteps()[1]!).getByLabelText(L.ar.stepSkill), { target: { value: "arabic-proofreader" } });
    fireEvent.click(btn(L.ar.addReview));
    fireEvent.change(within(editorSteps()[2]!).getByLabelText(L.ar.stepText), { target: { value: "راجع" } });
    fireEvent.click(btn(L.ar.addInstruction));
    fireEvent.change(within(editorSteps()[3]!).getByLabelText(L.ar.stepText), { target: { value: "للحذف" } });
    expect(editorSteps().map((li) => li.getAttribute("data-step-kind"))).toEqual(["instruction", "skill", "review", "instruction"]);
    // الأطراف معطّلة: الأولى لا تصعد والأخيرة لا تنزل
    expect((btn("تحريك لأعلى: الخطوة 1") as HTMLButtonElement).disabled).toBe(true);
    expect((btn("تحريك لأسفل: الخطوة 4") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn("تحريك لأعلى: الخطوة 3"));
    fireEvent.click(btn("حذف الخطوة: الخطوة 4"));
    expect(editorSteps().map((li) => li.getAttribute("data-step-kind"))).toEqual(["instruction", "review", "skill"]);
    expect(within(editorSteps()[1]!).getByRole("group").querySelector("legend")?.textContent).toBe("الخطوة 2 · مراجعة يدوية");
    fireEvent.click(btn(L.ar.save));
    expect(stored(scope)!.workflows[0]!.steps.map((s) => (s.kind === "skill" ? s.skillId : s.text))).toEqual(["أولًا", "راجع", "arabic-proofreader"]);
  });

  it("التعديل يحدّث المسودة نفسها في مكانها، والإلغاء لا يغيّر شيئًا", () => {
    const scope = newScope();
    const a = wf("أ");
    const b = wf("ب");
    seed(scope, [a, b]);
    render(view("ar", scope));
    fireEvent.click(btn("تعديل: أ"));
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "أ معدّلة" } });
    fireEvent.click(btn(L.ar.cancel));
    expect(stored(scope)!.workflows.map((w) => w.name)).toEqual(["أ", "ب"]);
    fireEvent.click(btn("تعديل: أ"));
    expect((screen.getByLabelText(L.ar.name) as HTMLInputElement).value).toBe("أ");
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "أ معدّلة" } });
    fireEvent.click(btn(L.ar.save));
    const s = stored(scope)!;
    expect(s.workflows.map((w) => [w.id, w.name])).toEqual([[a.id, "أ معدّلة"], [b.id, "ب"]]);
    expect(cardNames()).toEqual(["أ معدّلة", "ب"]);
  });

  it("الحذف بتأكيدٍ مضمَّن: الإلغاء يُبقي، والتأكيد يحذف من المفتاح ويُعلن", () => {
    const scope = newScope();
    seed(scope, [wf("تبقى"), wf("تُحذف")]);
    render(view("ar", scope));
    fireEvent.click(btn("حذف: تُحذف"));
    const group = screen.getByRole("group", { name: L.ar.confirm });
    fireEvent.click(within(group).getByRole("button", { name: L.ar.cancel }));
    expect(cardNames()).toEqual(["تبقى", "تُحذف"]);
    fireEvent.click(btn("حذف: تُحذف"));
    fireEvent.click(within(screen.getByRole("group", { name: L.ar.confirm })).getByRole("button", { name: L.ar.confirm }));
    expect(cardNames()).toEqual(["تبقى"]);
    expect(stored(scope)!.workflows.map((w) => w.name)).toEqual(["تبقى"]);
    expect(screen.getByRole("status").textContent).toBe(L.ar.deleted);
  });
});

describe("التحقّق المعلَن", () => {
  it("الفارغ لا يُحفظ: ملخّصٌ مركَّز، والحقول aria-invalid بوصفٍ مربوط", () => {
    const scope = newScope();
    render(view("ar", scope));
    fireEvent.click(btn(L.ar.newDraft));
    fireEvent.click(btn(L.ar.save));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(L.ar.summary);
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([L.ar.nameRequired, `الخطوة 1: ${L.ar.textRequired}`]);
    expect(document.activeElement).toBe(alert);
    const name = screen.getByLabelText(L.ar.name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe(L.ar.nameRequired);
    const text = within(editorSteps()[0]!).getByLabelText(L.ar.stepText);
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(text.getAttribute("aria-describedby")!)?.textContent).toBe(`الخطوة 1: ${L.ar.textRequired}`);
    expect(stored(scope)).toBeNull();
    // التصحيح يُحفظ
    fireEvent.change(name, { target: { value: "مكتملة" } });
    fireEvent.change(text, { target: { value: "نص" } });
    fireEvent.click(btn(L.ar.save));
    expect(stored(scope)!.workflows).toHaveLength(1);
  });

  it("مهارة غير مختارة، ومهارة محذوفة من الفهرس: لا حفظ، والسبب بمكانه", () => {
    const scope = newScope();
    const removed = wf("قديمة", [{ id: "st_aaaaaaaaaaaa", kind: "skill", skillId: "removed-skill" }]);
    seed(scope, [removed]);
    render(view("ar", scope));
    fireEvent.click(btn("تعديل: قديمة"));
    const select = within(editorSteps()[0]!).getByLabelText(L.ar.stepSkill) as HTMLSelectElement;
    expect(select.value).toBe("removed-skill");
    expect(select.selectedOptions[0]?.textContent).toBe("مهارة غير معروفة");
    fireEvent.click(btn(L.ar.save));
    expect(within(screen.getByRole("alert")).getByText(`الخطوة 1: ${L.ar.unknownSkill}`)).toBeTruthy();
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(btn(L.ar.save));
    expect(within(screen.getByRole("alert")).getByText("الخطوة 1: اختر مهارة لهذه الخطوة.")).toBeTruthy();
    expect(stored(scope)!.workflows).toEqual([removed]);
  });

  it("الحدّ خمسون مسودة: الجديدة لا تُحفظ والسبب معلَن", () => {
    const scope = newScope();
    seed(scope, Array.from({ length: 50 }, (_, i) => wf(`م${i}`)));
    render(view("ar", scope));
    createViaUi("الحادية والخمسون", "نص");
    expect(screen.getByRole("alert").textContent).toBe(L.ar.limit);
    expect(stored(scope)!.workflows).toHaveLength(50);
  });

  it("قائمة المهارات في الخطوة: المدمجة كلّها، والمعطّلة موسومة", () => {
    render(view("ar", newScope()));
    fireEvent.click(btn(L.ar.newDraft));
    fireEvent.click(btn(L.ar.addSkill));
    const options = Array.from((within(editorSteps()[1]!).getByLabelText(L.ar.stepSkill) as HTMLSelectElement).options).map((o) => [o.value, o.textContent]);
    expect(options[0]).toEqual(["", "اختر مهارة"]);
    expect(options.slice(1).map((o) => o[0])).toEqual(SKILLS.map((s) => s.id));
    expect(options.find((o) => o[0] === "document-qa")?.[1]).toBe(`${nameOf("document-qa")} — تعتمد على صلاحية معطّلة`);
    expect(options.find((o) => o[0] === "arabic-proofreader")?.[1]).toBe(nameOf("arabic-proofreader"));
  });
});

describe("المعاينة للقراءة", () => {
  it("بالترتيب والأرقام، بلا حقول، والمعطّلة والمحذوفة معلنتان، وزرّان فقط", () => {
    const scope = newScope();
    const w = wf("معاينة", [
      { id: "st_000000000001", kind: "instruction", text: "سطر أول\nسطر ثانٍ" },
      { id: "st_000000000002", kind: "skill", skillId: "document-qa" },
      { id: "st_000000000003", kind: "skill", skillId: "removed-skill" },
      { id: "st_000000000004", kind: "review", text: "<b>ليس HTML</b>" },
    ]);
    seed(scope, [w]);
    render(view("ar", scope));
    fireEvent.click(btn("معاينة: معاينة"));
    const section = document.querySelector<HTMLElement>("[data-workflow-preview]")!;
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe("معاينة");
    expect(within(section).getByRole("note").textContent).toBe(L.ar.previewNote);
    const items = within(within(section).getByRole("list", { name: L.ar.stepsHeading })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-step-kind"))).toEqual(["instruction", "skill", "skill", "review"]);
    expect(items[0]!.textContent).toContain("الخطوة 1 · تعليمات");
    expect(items[0]!.querySelector("p")?.textContent).toBe("سطر أول\nسطر ثانٍ");
    expect(items[1]!.textContent).toContain(nameOf("document-qa"));
    expect(within(items[1]!).getByText(L.ar.notExecutable)).toBeTruthy();
    expect(within(items[1]!).getByTitle(L.ar.disabled).textContent).toBe("قراءة ملفات المكتبة");
    expect(items[2]!.textContent).toContain(L.ar.skillUnknown);
    expect(items[3]!.querySelector("b")).toBeNull();
    expect(items[3]!.textContent).toContain("<b>ليس HTML</b>");
    // للقراءة: لا حقل، وزرّا التعديل والعودة وحدهما
    expect(section.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual([L.ar.edit, L.ar.back]);
    // المعاينة لا تغيّر المحفوظ
    expect(stored(scope)!.workflows).toEqual([w]);
    fireEvent.click(btn(L.ar.edit));
    expect((screen.getByLabelText(L.ar.name) as HTMLInputElement).value).toBe("معاينة");
    fireEvent.click(btn(L.ar.cancel));
    fireEvent.click(btn("معاينة: معاينة"));
    fireEvent.click(btn(L.ar.back));
    expect(cardNames()).toEqual(["معاينة"]);
  });

  it("لا شبكة ولا تنقّل ولا مفتاح غير المسودات — عبر الإنشاء والمعاينة والتعديل والحذف", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const href = window.location.href;
    const scope = newScope();
    render(view("ar", scope));
    createViaUi("بلا شبكة", "نص", [
      () => fireEvent.click(btn(L.ar.addSkill)),
      () => fireEvent.change(within(editorSteps()[1]!).getByLabelText(L.ar.stepSkill), { target: { value: "explain-code" } }),
    ]);
    fireEvent.click(btn("معاينة: بلا شبكة"));
    fireEvent.click(btn(L.ar.edit));
    fireEvent.click(btn(L.ar.save));
    fireEvent.click(btn("حذف: بلا شبكة"));
    fireEvent.click(within(screen.getByRole("group", { name: L.ar.confirm })).getByRole("button", { name: L.ar.confirm }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const fn of Object.values(nav)) expect(fn).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const k of Object.keys(window.localStorage)) expect(k.startsWith(DRAFTS_KEY_PREFIX)).toBe(true);
  });
});

describe("عزل الحسابات والتخزين", () => {
  it("تبديل الحساب يقرأ مفتاحًا آخر، والعودة تعيد المسودات كما كانت", () => {
    const a = newScope();
    const b = newScope();
    const { rerender } = render(view("ar", a));
    createViaUi("مسودة أ", "نص أ");
    rerender(view("ar", b));
    expect(screen.getByRole("status").textContent).toBe(L.ar.empty);
    createViaUi("مسودة ب", "نص ب");
    rerender(view("ar", a));
    expect(cardNames()).toEqual(["مسودة أ"]);
    expect(stored(a)!.workflows.map((w) => w.name)).toEqual(["مسودة أ"]);
    expect(stored(b)!.workflows.map((w) => w.name)).toEqual(["مسودة ب"]);
    expect(Object.keys(window.localStorage).sort()).toEqual([keyOf(a), keyOf(b)].sort());
  });

  it("محرّرٌ مفتوح بمسودة حساب، ثم تبدّل الحساب: يُغلق، ولا يُكتب نصّ الأول تحت مفتاح الثاني", () => {
    const a = newScope();
    const b = newScope();
    const mine = wf("مسودة أ الخاصة");
    seed(a, [mine]);
    const { rerender } = render(view("ar", a));
    fireEvent.click(btn("تعديل: مسودة أ الخاصة"));
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "نصّ لم يُحفظ من أ" } });
    rerender(view("ar", b));
    expect(screen.queryByLabelText(L.ar.name)).toBeNull();
    expect(document.body.textContent).not.toContain("نصّ لم يُحفظ من أ");
    expect(document.body.textContent).not.toContain("مسودة أ الخاصة");
    expect(screen.getByRole("status").textContent).toBe(L.ar.empty);
    expect(stored(b)).toBeNull();
    expect(stored(a)!.workflows).toEqual([mine]);
  });

  it("الامتلاء: المسودة للجلسة و«لم تُحفظ» معلنة — ولا تظهر لحسابٍ آخر", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const a = newScope();
    const b = newScope();
    const { rerender } = render(view("ar", a));
    createViaUi("في الذاكرة", "نص");
    expect(cardNames()).toEqual(["في الذاكرة"]);
    expect(document.querySelector("[data-drafts-not-saved]")?.textContent).toBe(L.ar.notSaved);
    expect(window.localStorage.getItem(keyOf(a))).toBeNull();
    rerender(view("ar", b));
    expect(screen.queryByRole("list", { name: L.ar.list })).toBeNull();
    expect(document.querySelector("[data-drafts-not-saved]")).toBeNull();
    rerender(view("ar", a));
    expect(cardNames()).toEqual(["في الذاكرة"]);
  });

  it("القراءة المحجوبة والقيم التالفة: الصفحة تعمل، والسليم من المختلط يبقى", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(view("ar", newScope()));
    expect(screen.getByRole("status").textContent).toBe(L.ar.empty);
    cleanup();
    vi.restoreAllMocks();
    for (const bad of ["{", "null", "[]", JSON.stringify({ v: 2, workflows: [wf("x")] })]) {
      const scope = newScope();
      window.localStorage.setItem(keyOf(scope), bad);
      render(view("ar", scope));
      expect(screen.getByRole("status").textContent, bad).toBe(L.ar.empty);
      cleanup();
    }
    const scope = newScope();
    window.localStorage.setItem(keyOf(scope), JSON.stringify({ v: 1, workflows: [{ junk: 1 }, wf("سليمة"), { ...wf("بلا خطوات"), steps: [] }] }));
    render(view("ar", scope));
    expect(cardNames()).toEqual(["سليمة"]);
  });

  it("بلا نطاقٍ صالح: لا مسودات ولا إنشاء ولا وصول إلى التخزين", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    for (const scope of [undefined, null, "", "global", randomUUID()]) {
      render(view("ar", scope));
      expect(screen.getByRole("status").textContent, String(scope)).toBe(L.ar.unavailable);
      expect(screen.queryByRole("button", { name: L.ar.newDraft }), String(scope)).toBeNull();
      cleanup();
    }
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("تبويبٌ آخر للحساب نفسه: حدث storage يحدّث القائمة", () => {
    const scope = newScope();
    render(view("ar", scope));
    seed(scope, [wf("من تبويب آخر")]);
    fireEvent(window, new StorageEvent("storage", { key: keyOf(scope) }));
    expect(cardNames()).toEqual(["من تبويب آخر"]);
  });

  it("الوضع الصارم: حفظٌ واحد لمسودةٍ واحدة", () => {
    const scope = newScope();
    render(<StrictMode>{view("ar", scope)}</StrictMode>);
    createViaUi("صارم", "نص");
    expect(stored(scope)!.workflows).toHaveLength(1);
    expect(cardNames()).toEqual(["صارم"]);
  });
});

describe("HTML الخادم والإماهة واللغتان", () => {
  it("HTML الخادم لا يعرف المسودات ولا النطاق: متطابقٌ بين حسابين، بلا قائمةٍ ولا «لا مسودات»", () => {
    const a = newScope();
    const b = newScope();
    seed(a, [wf("سرّية على الخادم")]);
    for (const locale of ["ar", "en"] as const) {
      const html = renderToString(view(locale, a));
      expect(html, locale).toBe(renderToString(view(locale, b)));
      expect(html, locale).not.toContain("سرّية على الخادم");
      expect(html, locale).not.toContain(a);
      expect(html, locale).toContain('aria-busy="true"');
      expect(html, locale).not.toContain(L.ar.empty);
    }
  });

  it("الخطّاف وحده: لقطة الخادم فارغة حتى لو كان في التخزين مسودات", () => {
    const scope = newScope();
    seed(scope, [wf("في التخزين")]);
    function Probe() {
      const d = useWorkflowDrafts(scope);
      return <span>{d.workflows.length}</span>;
    }
    expect(renderToString(<Probe />)).toBe("<span>0</span>");
  });

  it("الإماهة بلا خطأ قابل للاسترداد ولا سجلّ إماهة، ثم تظهر المسودات المحفوظة", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const scope = newScope();
    seed(scope, [wf("بعد الإماهة")]);
    for (const locale of ["ar", "en"] as const) {
      const container = document.createElement("div");
      container.innerHTML = renderToString(view(locale, scope));
      document.body.appendChild(container);
      const recoverable: unknown[] = [];
      render(view(locale, scope), { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
      expect(recoverable, locale).toEqual([]);
      await waitFor(() => expect(container.textContent, locale).toContain("بعد الإماهة"));
      cleanup();
      container.remove();
    }
    const logs = consoleError.mock.calls.filter((c) => /hydrat|#418|#423|#425/i.test(c.map(String).join(" ")));
    expect(logs).toEqual([]);
  });

  it("الإنجليزية: التسميات، والسهم يشير إلى البداية من اليسار؛ والعربية من اليمين", () => {
    const scope = newScope();
    seed(scope, [wf("Weekly review")]);
    render(view("en", scope));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(L.en.title);
    expect(screen.getByRole("note").textContent).toBe(L.en.note);
    expect(screen.getByText(L.en.badge)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview: Weekly review" }));
    expect(screen.getAllByRole("note").map((n) => n.textContent)).toContain(L.en.previewNote);
    expect(screen.getByRole("button", { name: L.en.back }).querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-left");
    cleanup();
    render(view("ar", scope));
    fireEvent.click(btn("معاينة: Weekly review"));
    expect(btn(L.ar.back).querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-right");
  });
});

describe("حرّاس الواجهة", () => {
  const FILES = readdirSync("components/automations").map((f) => `components/automations/${f}`);
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("لا اتجاه فيزيائيّ ولا لون مباشر ولا dark:", () => {
    for (const f of FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr)-\d|\b(left|right)-\d|text-(left|right)\b|rounded-[lr]-|border-[lr]\b/);
      expect(stripComments(src), f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(stripComments(src), f).not.toMatch(/\bdark:/);
    }
  });

  it("كل زرٍّ في المحرّر له اسمٌ مسموع، وكل حقلٍ له تسمية", () => {
    render(view("ar", newScope()));
    fireEvent.click(btn(L.ar.newDraft));
    fireEvent.click(btn(L.ar.addSkill));
    fireEvent.click(btn(L.ar.addReview));
    for (const b of screen.getAllByRole("button")) {
      expect((b.getAttribute("aria-label") ?? b.textContent ?? "").trim().length, b.outerHTML.slice(0, 80)).toBeGreaterThan(0);
      expect(b.getAttribute("type")).toMatch(/^(button|submit)$/);
    }
    for (const field of Array.from(document.querySelectorAll("input, textarea, select"))) {
      expect(document.querySelector(`label[for="${field.id}"]`), field.outerHTML.slice(0, 60)).not.toBeNull();
    }
    expect(screen.getAllByRole("group").length).toBeGreaterThanOrEqual(4);
  });
});
