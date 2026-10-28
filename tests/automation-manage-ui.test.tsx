/**
 * المرحلة 4C — إدارة المسودات في مساحة الأتمتة: البحث والترتيب وإنشاء النسخة، بالمكوّنات الحقيقية.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - البحث بالعربية والإنجليزية في الاسم والوصف، وفراغٌ صادق، ولا يمسّ المحفوظ ولا معرض القوالب.
 *   - الترتيب حتميّ للعرض وحده: التخزين بترتيبه، والمعرّفات والمحتوى كما هي.
 *   - النسخة بفعلٍ صريح: معرّفاتٌ جديدة، والأصل كما هو، وحدّ الخمسين، والأصل غير الصالح لا يُنسخ.
 *   - تعذّر التخزين: النسخة للجلسة ومعلنةٌ أنها لم تُحفظ؛ والمحرّر المفتوح لا يُمسّ.
 *   - عزل الحسابات، والوضع الصارم، والإماهة، واللغتان، والقوالب، وغياب الشبكة والنماذج.
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
import { builtInWorkflowTemplates } from "@/lib/automations/templates";
import { STEP_ID_PATTERN, WORKFLOW_ID_PATTERN, workflowSchema, type Workflow } from "@/lib/automations/workflow";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const SKILLS = builtInSkillRegistry()
  .list()
  .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
const TEMPLATES = builtInWorkflowTemplates();

const L = {
  ar: {
    mine: "مسوداتي",
    search: "بحث في المسودات",
    sort: "ترتيب المسودات",
    created: "ترتيب الإنشاء",
    asc: "الاسم تصاعديًّا",
    desc: "الاسم تنازليًّا",
    noMatch: "لا مسودات تطابق البحث.",
    dup: "إنشاء نسخة",
    suffix: " (نسخة)",
    duplicated: "أُنشئت نسخة جديدة.",
    notPersisted: "أُنشئت النسخة لكنها لم تُحفظ في هذا المتصفح — تبقى حتى تُغلق التبويب أو تُعيد تحميله.",
    invalid: "لم تُنشأ النسخة: صحّح المسودة الأصلية أولًا.",
    limit: "بلغت حدّ 50 مسودة؛ احذف مسودة لتحفظ غيرها.",
    list: "مسودات سير العمل",
    gallery: "قوالب جاهزة",
    name: "اسم سير العمل",
    save: "حفظ المسودة",
    cancel: "إلغاء",
  },
  en: {
    mine: "My drafts",
    search: "Search drafts",
    sort: "Sort drafts",
    asc: "Name, A to Z",
    noMatch: "No drafts match your search.",
    dup: "Duplicate",
    suffix: " (copy)",
    duplicated: "A new copy was created.",
    list: "Workflow drafts",
  },
} as const;
const PROMISE = /تشغيل|شغّل|تفعيل|فعّل|جدولة|\brun\b|activate|enable|schedule|execute|trigger|coming soon/i;

const newScope = () => automationDraftsScopeFor(randomUUID());
const keyOf = (scope: string) => draftsStorageKey(scope)!;
const rawOf = (scope: string) => window.localStorage.getItem(keyOf(scope));
const stored = (scope: string): Workflow[] => {
  const raw = rawOf(scope);
  return raw === null ? [] : (JSON.parse(raw) as { workflows: Workflow[] }).workflows;
};
let seq = 0;
const id12 = () => String(++seq).padStart(12, "0");
const wf = (name: string, description = "", steps?: Workflow["steps"]): Workflow =>
  workflowSchema.parse({
    schemaVersion: 1,
    id: `wf_${id12()}`,
    name,
    description,
    steps: steps ?? [
      { id: `st_${id12()}`, kind: "instruction", text: `نص ${name}` },
      { id: `st_${id12()}`, kind: "skill", skillId: "summarize-text" },
    ],
  });
const seed = (scope: string, workflows: Workflow[]) => window.localStorage.setItem(keyOf(scope), JSON.stringify({ v: 1, workflows }));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const view = (locale: Locale, scope: string | null | undefined, withTemplates = true) => (
  <I18nProvider initialLocale={locale}>
    <AutomationsView skills={SKILLS} draftsScope={scope} templates={withTemplates ? TEMPLATES : undefined} />
  </I18nProvider>
);
const btn = (name: string) => screen.getByRole("button", { name });
const names = (l: Locale = "ar") =>
  within(screen.getByRole("list", { name: L[l].list }))
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
const searchBox = (l: Locale = "ar") => screen.getByRole("searchbox", { name: L[l].search });
const sortBox = (l: Locale = "ar") => screen.getByRole("combobox", { name: L[l].sort }) as HTMLSelectElement;
const typeSearch = async (q: string, l: Locale = "ar") => {
  fireEvent.change(searchBox(l), { target: { value: q } });
  await waitFor(() => expect((searchBox(l) as HTMLInputElement).value).toBe(q));
};

describe("البحث", () => {
  it("عربيّ وإنجليزيّ في الاسم والوصف، وفراغٌ صادق، والمسح يعيد الكلّ — والمحفوظ والقوالب كما هي", async () => {
    const scope = newScope();
    seed(scope, [wf("مراجعة أسبوعية", "متابعة الإنجاز"), wf("Weekly review", "check PROGRESS"), wf("خطة بحث", "الفرضيات")]);
    const before = rawOf(scope);
    render(view("ar", scope));
    expect(screen.getByRole("heading", { level: 2, name: L.ar.mine })).toBeTruthy();
    await typeSearch("مراجعه");
    await waitFor(() => expect(names()).toEqual(["مراجعة أسبوعية"]));
    await typeSearch("الانجاز");
    await waitFor(() => expect(names()).toEqual(["مراجعة أسبوعية"]));
    await typeSearch("WEEKLY");
    await waitFor(() => expect(names()).toEqual(["Weekly review"]));
    await typeSearch("progress");
    await waitFor(() => expect(names()).toEqual(["Weekly review"]));
    await typeSearch("zzzz");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(L.ar.noMatch));
    expect(screen.queryByRole("list", { name: L.ar.list })).toBeNull();
    // المعرض لا يتأثّر بالبحث
    expect(within(document.querySelector<HTMLElement>("[data-template-gallery]")!).getAllByRole("listitem")).toHaveLength(3);
    await typeSearch("");
    await waitFor(() => expect(names()).toEqual(["مراجعة أسبوعية", "Weekly review", "خطة بحث"]));
    expect(rawOf(scope)).toBe(before);
  });

  it("بلا مسودات: لا شريط بحثٍ ولا ترتيب — فراغ المرحلة 4A كما هو", () => {
    render(view("ar", newScope()));
    expect(screen.queryByRole("searchbox", { name: L.ar.search })).toBeNull();
    expect(screen.queryByRole("combobox", { name: L.ar.sort })).toBeNull();
  });
});

describe("الترتيب", () => {
  it("ثلاثة خيارات؛ الاسم باتجاهيه للعرض وحده، والتخزين بترتيبه ومعرّفاته ومحتواه", async () => {
    const scope = newScope();
    seed(scope, [wf("ب"), wf("ج"), wf("أ")]);
    const before = rawOf(scope);
    render(view("ar", scope));
    expect(Array.from(sortBox().options).map((o) => [o.value, o.textContent])).toEqual([
      ["created", L.ar.created],
      ["name-asc", L.ar.asc],
      ["name-desc", L.ar.desc],
    ]);
    expect(sortBox().value).toBe("created");
    expect(names()).toEqual(["ب", "ج", "أ"]);
    fireEvent.change(sortBox(), { target: { value: "name-asc" } });
    expect(names()).toEqual(["أ", "ب", "ج"]);
    fireEvent.change(sortBox(), { target: { value: "name-desc" } });
    expect(names()).toEqual(["ج", "ب", "أ"]);
    fireEvent.change(sortBox(), { target: { value: "created" } });
    expect(names()).toEqual(["ب", "ج", "أ"]);
    expect(rawOf(scope)).toBe(before);
  });

  it("الترتيب والبحث معًا، ويبقيان بعد التعديل والعودة", async () => {
    const scope = newScope();
    seed(scope, [wf("خطة ب"), wf("أخرى"), wf("خطة أ")]);
    render(view("ar", scope));
    fireEvent.change(sortBox(), { target: { value: "name-asc" } });
    await typeSearch("خطه");
    await waitFor(() => expect(names()).toEqual(["خطة أ", "خطة ب"]));
    fireEvent.click(btn("تعديل: خطة ب"));
    fireEvent.click(btn(L.ar.cancel));
    expect(names()).toEqual(["خطة أ", "خطة ب"]);
  });
});

describe("إنشاء نسخة", () => {
  it("بفعلٍ صريح وحده: نسخةٌ بمعرّفاتٍ جديدة، والأصل كما هو، وتُعلن", () => {
    const scope = newScope();
    const src = wf("مصدر", "وصف");
    seed(scope, [src]);
    render(view("ar", scope));
    expect(stored(scope)).toHaveLength(1);
    fireEvent.click(btn(`${L.ar.dup}: مصدر`));
    const [orig, copy] = stored(scope);
    expect(orig).toEqual(src);
    expect(copy!.id).toMatch(WORKFLOW_ID_PATTERN);
    expect(copy!.id).not.toBe(src.id);
    expect(copy!.name).toBe(`مصدر${L.ar.suffix}`);
    expect(copy!.description).toBe("وصف");
    expect(copy!.steps.every((s) => STEP_ID_PATTERN.test(s.id))).toBe(true);
    expect(copy!.steps.map((s) => s.id).some((id) => src.steps.map((x) => x.id).includes(id))).toBe(false);
    const content = (w: Workflow) => w.steps.map((s) => (s.kind === "skill" ? `${s.kind}:${s.skillId}` : `${s.kind}:${s.text}`));
    expect(content(copy!)).toEqual(content(src));
    expect(screen.getByRole("status").textContent).toBe(L.ar.duplicated);
    expect(names()).toEqual(["مصدر", `مصدر${L.ar.suffix}`]);
  });

  it("النسخة مستقلّة: تعديلها لا يمسّ الأصل، والنسخة من النسخة بمعرّفٍ ثالث", () => {
    const scope = newScope();
    const src = wf("أصل");
    seed(scope, [src]);
    render(view("ar", scope));
    fireEvent.click(btn(`${L.ar.dup}: أصل`));
    fireEvent.click(btn(`تعديل: أصل${L.ar.suffix}`));
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "نسختي المعدّلة" } });
    fireEvent.click(btn(L.ar.save));
    fireEvent.click(btn(`${L.ar.dup}: نسختي المعدّلة`));
    const all = stored(scope);
    expect(all[0]).toEqual(src);
    expect(all.map((w) => w.name)).toEqual(["أصل", "نسختي المعدّلة", `نسختي المعدّلة${L.ar.suffix}`]);
    expect(new Set(all.map((w) => w.id)).size).toBe(3);
  });

  it("حدّ الخمسين: لا نسخة، والسبب معلَن، والعدد كما هو", () => {
    const scope = newScope();
    seed(scope, Array.from({ length: 50 }, (_, i) => wf(`م${i}`)));
    render(view("ar", scope));
    fireEvent.click(btn(`${L.ar.dup}: م0`));
    expect(screen.getByRole("alert").textContent).toBe(L.ar.limit);
    expect(stored(scope)).toHaveLength(50);
  });

  it("أصلٌ يشير إلى مهارةٍ محذوفة: قواعد المسودة نفسها ترفض النسخة، والسبب بمكانه", () => {
    const scope = newScope();
    seed(scope, [wf("قديمة", "", [{ id: `st_${id12()}`, kind: "skill", skillId: "removed-skill" }])]);
    render(view("ar", scope));
    fireEvent.click(btn(`${L.ar.dup}: قديمة`));
    expect(screen.getByRole("alert").textContent).toBe(`${L.ar.invalid} الخطوة 1: هذه المهارة غير موجودة في الفهرس المدمج.`);
    expect(stored(scope)).toHaveLength(1);
  });

  it("تعذّر التخزين: النسخة للجلسة ومعلنةٌ صراحةً أنها لم تُحفظ، والمحفوظ كما هو", () => {
    const scope = newScope();
    seed(scope, [wf("محفوظة")]);
    const before = rawOf(scope);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    render(view("ar", scope));
    fireEvent.click(btn(`${L.ar.dup}: محفوظة`));
    expect(names()).toEqual(["محفوظة", `محفوظة${L.ar.suffix}`]);
    expect(document.querySelector("[data-drafts-notice]")?.textContent).toBe(L.ar.notPersisted);
    expect(document.querySelector("[data-drafts-not-saved]")).not.toBeNull();
    expect(rawOf(scope)).toBe(before);
  });

  it("المحرّر المفتوح بتعديلاتٍ لا يُمسّ: لا أزرار نسخٍ أثناء التحرير، والإلغاء يطلب التأكيد", () => {
    const scope = newScope();
    seed(scope, [wf("قيد التحرير")]);
    render(view("ar", scope));
    fireEvent.click(btn("تعديل: قيد التحرير"));
    fireEvent.change(screen.getByLabelText(L.ar.name), { target: { value: "تعديلٌ لم يُحفظ" } });
    expect(screen.queryByRole("button", { name: new RegExp(`^${L.ar.dup}`) })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: L.ar.search })).toBeNull();
    expect((screen.getByLabelText(L.ar.name) as HTMLInputElement).value).toBe("تعديلٌ لم يُحفظ");
    fireEvent.click(btn(L.ar.cancel));
    expect(screen.getByRole("group", { name: "تأكيد تجاهل التعديلات" })).toBeTruthy();
  });

  it("الوضع الصارم: نقرةٌ واحدة ⇒ نسخةٌ واحدة", () => {
    const scope = newScope();
    seed(scope, [wf("صارم")]);
    render(<StrictMode>{view("ar", scope)}</StrictMode>);
    fireEvent.click(btn(`${L.ar.dup}: صارم`));
    expect(stored(scope)).toHaveLength(2);
  });
});

describe("عزل الحسابات", () => {
  it("النسخة من مسودات الحساب نفسه وفي مفتاحه وحده — ولا يرى الآخرُ شيئًا", () => {
    const a = newScope();
    const b = newScope();
    const aDraft = wf("مسودة أ");
    const bDraft = wf("مسودة ب");
    seed(a, [aDraft]);
    seed(b, [bDraft]);
    const { rerender } = render(view("ar", b));
    expect(names()).toEqual(["مسودة ب"]);
    fireEvent.click(btn(`${L.ar.dup}: مسودة ب`));
    expect(stored(b).map((w) => w.name)).toEqual(["مسودة ب", `مسودة ب${L.ar.suffix}`]);
    expect(stored(a)).toEqual([aDraft]);
    rerender(view("ar", a));
    expect(names()).toEqual(["مسودة أ"]);
    expect(document.body.textContent).not.toContain("مسودة ب");
  });

  it("بحثٌ في حسابٍ ثم تبدّل الحساب: يبدأ الآخر بلا بحثٍ ولا نتائج من الأول", async () => {
    const a = newScope();
    const b = newScope();
    seed(a, [wf("سرّ أ")]);
    seed(b, [wf("عامّة ب")]);
    const { rerender } = render(view("ar", a));
    await typeSearch("سر");
    rerender(view("ar", b));
    expect((searchBox() as HTMLInputElement).value).toBe("");
    expect(names()).toEqual(["عامّة ب"]);
  });
});

describe("القوالب واللغتان والإماهة والحدود", () => {
  it("مسودة من قالب (4B) تُنسخ كأي مسودة، والقالب لا يتغيّر، والمعرض والمسودات متمايزان", () => {
    const before = JSON.stringify(TEMPLATES);
    const scope = newScope();
    render(view("ar", scope));
    fireEvent.click(btn(`استخدام القالب: ${TEMPLATES[0]!.title.ar}`));
    fireEvent.click(btn(L.ar.save));
    fireEvent.click(btn(`${L.ar.dup}: ${TEMPLATES[0]!.title.ar}`));
    const all = stored(scope);
    expect(all).toHaveLength(2);
    expect(all.map((w) => w.id)).not.toContain(TEMPLATES[0]!.id);
    expect(JSON.stringify(TEMPLATES)).toBe(before);
    expect(screen.getByRole("heading", { level: 2, name: L.ar.mine })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: L.ar.gallery })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: L.ar.list })).queryByText("قالب · مسودة فقط")).toBeNull();
  });

  it("الإنجليزية: البحث والترتيب والنسخة بتسمياتها ولاحقتها", async () => {
    const scope = newScope();
    seed(scope, [wf("beta"), wf("Alpha")]);
    render(view("en", scope));
    expect(screen.getByRole("heading", { level: 2, name: L.en.mine })).toBeTruthy();
    fireEvent.change(sortBox("en"), { target: { value: "name-asc" } });
    expect(names("en")).toEqual(["Alpha", "beta"]);
    expect(sortBox("en").selectedOptions[0]?.textContent).toBe(L.en.asc);
    fireEvent.click(screen.getByRole("button", { name: `${L.en.dup}: Alpha` }));
    expect(screen.getByRole("status").textContent).toBe(L.en.duplicated);
    expect(stored(scope).map((w) => w.name)).toContain(`Alpha${L.en.suffix}`);
    await typeSearch("nothing-here", "en");
    // إعلان النسخة يبقى حتى الفعل التالي، وفراغ البحث يُعلن بجانبه
    await waitFor(() => expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual([L.en.duplicated, L.en.noMatch]));
  });

  it("HTML الخادم بلا شريطٍ ولا أزرار نسخ (المسودات بعد الإماهة)، والإماهة بلا خطأ ثم يظهران", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const scope = newScope();
    seed(scope, [wf("بعد الإماهة")]);
    for (const locale of ["ar", "en"] as const) {
      const html = renderToString(view(locale, scope));
      expect(html, locale).toBe(renderToString(view(locale, newScope())));
      expect(html, locale).not.toContain("data-drafts-toolbar");
      expect(html, locale).not.toContain(L[locale].dup);
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.appendChild(container);
      const recoverable: unknown[] = [];
      render(view(locale, scope), { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
      expect(recoverable, locale).toEqual([]);
      await waitFor(() => expect(container.querySelector("[data-drafts-toolbar]"), locale).not.toBeNull());
      cleanup();
      container.remove();
    }
    expect(consoleError.mock.calls.filter((c) => /hydrat|#418|#423|#425/i.test(c.map(String).join(" ")))).toEqual([]);
  });

  it("لا شبكة ولا تنقّل ولا نموذج، ولا زرّ يعد بتشغيل — عبر البحث والترتيب والنسخ", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const href = window.location.href;
    const scope = newScope();
    seed(scope, [wf("أ"), wf("ب")]);
    render(view("ar", scope));
    await typeSearch("أ");
    fireEvent.change(sortBox(), { target: { value: "name-desc" } });
    fireEvent.click(btn(`${L.ar.dup}: أ`));
    for (const b of screen.getAllByRole("button")) expect(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`).not.toMatch(PROMISE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    for (const fn of Object.values(nav)) expect(fn).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const k of Object.keys(window.localStorage)) expect(k.startsWith(DRAFTS_KEY_PREFIX)).toBe(true);
  });
});
