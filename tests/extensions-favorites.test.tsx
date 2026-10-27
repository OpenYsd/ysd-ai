/**
 * المرحلة 3C — المفضّلة في الفهرس وصفحة المهارة.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - النجمة زرّ تبديلٍ معلَن الحالة (aria-pressed) خارج رابط البطاقة، والإضافة والإزالة تُحفظان
 *     معرّفاتٍ وحدها بمفتاح المستخدم.
 *   - «المفضّلة» مرشّحٌ يُضاف إلى التصنيف والبحث العربي، وفراغه يقول كيف تُضاف لا «لا نتائج».
 *   - المحفوظ التالف أو القديم أو المجهول يُتجاهل بأمان، والكتابة التالية تنظّفه.
 *   - الحساب الآخر لا يرى مفضّلة الأول — في التخزين وفي ذاكرة التبويب معًا — والعودة تعيدها.
 *   - التخزين الممتلئ أو المحجوب لا يكسر الصفحة: المفضّلة للجلسة، و«لم تُحفظ» معلَنة.
 *   - HTML الخادم لا يعرف المفضّلة ولا النطاق، والإماهة بلا خطأ، ثم تظهر المفضّلة.
 *   - التفضيل علامةٌ لا فعل: لا شبكة ولا تنقّل ولا مسودة، و«استخدام في محادثة» كما كان،
 *     والمعطّلة تُفضَّل وتبقى صلاحيتها معطّلة.
 *
 * المكوّنات الحقيقية مع السجلّ والقاموس الحقيقيين؛ يُستبدل الموجّه وزرّ قائمة الجوال وحدهما.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/extensions",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { ExtensionsView } from "@/components/extensions/extensions-view";
import { SkillDetail } from "@/components/extensions/skill-detail";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { skillChatHref } from "@/lib/skills/chat-draft";
import { FAVORITES_KEY_PREFIX, favoritesStorageKey } from "@/lib/skills/favorites";
import { favoritesScopeFor } from "@/lib/skills/favorites-scope";
import type { SkillManifest } from "@/lib/skills/manifest";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const SKILLS = builtInSkillRegistry().list();
const CATALOG = SKILLS.map((s) => s.id);
function skill(id: string): SkillManifest {
  const found = builtInSkillRegistry().get(id);
  if (!found) throw new Error(`built-in skill missing from the registry: ${id}`);
  return found;
}
const PROOFREADER = skill("arabic-proofreader");
const EXPLAIN = skill("explain-code");
const DOCUMENT_QA = skill("document-qa");

const L = {
  ar: {
    filter: "المفضّلة",
    star: "مفضّلة",
    add: "إضافة إلى المفضّلة",
    remove: "إزالة من المفضّلة",
    empty: "لا مهارات مفضّلة بعد. اضغط النجمة على أي مهارة لتجدها هنا.",
    noMatch: "لا مهارات تطابق البحث.",
    notSaved: "تعذّر حفظ المفضّلة في هذا المتصفح — تبقى حتى تُغلق التبويب أو تُعيد تحميله.",
    list: "قائمة المهارات",
    search: "بحث في المهارات",
    categories: "تصفية حسب التصنيف",
    useInChat: "استخدام في محادثة",
    disabled: "غير مفعّلة في هذا الإصدار",
  },
  en: {
    filter: "Favorites",
    star: "Favorite",
    add: "Add to favorites",
    remove: "Remove from favorites",
    empty: "No favorite skills yet. Press the star on any skill to find it here.",
    noMatch: "No skills match your search.",
    notSaved: "Favorites couldn't be saved in this browser — they last until you close or reload this tab.",
    list: "Skills list",
    search: "Search skills",
    categories: "Filter by category",
    useInChat: "Use in chat",
    disabled: "Not enabled in this version",
  },
} as const;

/** ما لا يجوز أن يعد به زرٌّ ما دام التنفيذ لم يُبنَ — كما في حارس المرحلة 3A */
const PROMISE = /ثبّت|تثبيت|تفعيل|فعّل|تشغيل|شغّل|قريبًا|install|enable|activate|run\b|execute|coming soon/i;

/** نطاقٌ جديد لكل اختبار: ذاكرة التبويب على مستوى الوحدة، فلا يرث اختبارٌ ما كتبه غيره */
const newScope = () => favoritesScopeFor(randomUUID());
const keyOf = (scope: string) => {
  const key = favoritesStorageKey(scope);
  if (!key) throw new Error("invalid test scope");
  return key;
};
const seed = (scope: string, value: unknown) =>
  window.localStorage.setItem(keyOf(scope), typeof value === "string" ? value : JSON.stringify(value));
const stored = (scope: string): unknown => {
  const raw = window.localStorage.getItem(keyOf(scope));
  return raw === null ? null : JSON.parse(raw);
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const index = (locale: Locale, scope: string | null | undefined) => (
  <I18nProvider initialLocale={locale}>
    <ExtensionsView skills={SKILLS} favoritesScope={scope} />
  </I18nProvider>
);
/** `catalog: "none"` يحذف الفهرس فعلًا — `undefined` الصريح كان سيأخذ الافتراضي */
const detail = (
  s: SkillManifest,
  locale: Locale,
  scope: string | null | undefined,
  catalog: readonly string[] | "none" = CATALOG,
) => (
  <I18nProvider initialLocale={locale}>
    <SkillDetail skill={s} favoritesScope={scope} catalogIds={catalog === "none" ? undefined : catalog} />
  </I18nProvider>
);

const list = (locale: Locale = "ar") => screen.getByRole("list", { name: L[locale].list });
const cards = (locale: Locale = "ar") => within(list(locale)).getAllByRole("link");
const hrefs = (locale: Locale = "ar") => cards(locale).map((a) => a.getAttribute("href"));
const star = (s: SkillManifest, locale: Locale = "ar") =>
  screen.getByRole("button", { name: `${L[locale].star}: ${s.name[locale]}` });
const filterButton = (locale: Locale = "ar") => screen.getByRole("button", { name: new RegExp(`^${L[locale].filter}`) });
const chip = (name: string) => within(screen.getByRole("group", { name: L.ar.categories })).getByRole("button", { name });
const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed");
const pressedStars = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-favorite-toggle][aria-pressed="true"]')).map((b) =>
    b.getAttribute("aria-label"),
  );
const statusTexts = () => screen.queryAllByRole("status").map((s) => s.textContent);

describe("الإضافة والإزالة", () => {
  it("النجمة تبدّل حالتها المعلنة وتلميحها، وتحفظ المعرّف وحده بمفتاح المستخدم", () => {
    const scope = newScope();
    render(index("ar", scope));
    const button = star(PROOFREADER);
    expect(pressed(button)).toBe("false");
    expect(button.getAttribute("title")).toBe(L.ar.add);
    expect(filterButton().textContent).toBe(`${L.ar.filter}0`);

    fireEvent.click(button);
    expect(pressed(star(PROOFREADER))).toBe("true");
    expect(star(PROOFREADER).getAttribute("title")).toBe(L.ar.remove);
    expect(filterButton().textContent).toBe(`${L.ar.filter}1`);
    expect(stored(scope)).toEqual({ v: 1, ids: ["arabic-proofreader"] });
    // مفتاحٌ واحد في التخزين كلّه: لا مسودة ولا رمز ولا شيء غير المفضّلة
    expect(Object.keys(window.localStorage)).toEqual([keyOf(scope)]);

    fireEvent.click(star(EXPLAIN));
    expect(stored(scope)).toEqual({ v: 1, ids: ["arabic-proofreader", "explain-code"] });

    fireEvent.click(star(PROOFREADER));
    expect(pressed(star(PROOFREADER))).toBe("false");
    expect(pressed(star(EXPLAIN))).toBe("true");
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code"] });
  });

  it("النجمة زرٌّ أصيل خارج رابط البطاقة، يُركَّز بلوحة المفاتيح، وباسمٍ يميّز مهارته", () => {
    render(index("ar", newScope()));
    const stars = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-favorite-toggle]"));
    expect(stars).toHaveLength(SKILLS.length);
    expect(new Set(stars.map((b) => b.getAttribute("aria-label"))).size).toBe(SKILLS.length);
    for (const b of stars) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
      expect(b.closest("a")).toBeNull();
      expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      b.focus();
      expect(document.activeElement).toBe(b);
    }
    // بعد رابط بطاقتها في ترتيب التنقّل
    const [card] = cards();
    const [first] = stars;
    if (!card || !first) throw new Error("card or star missing");
    expect(card.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("الوضع الصارم: نقرةٌ واحدة تُحفظ مرّةً واحدة، والثانية تعيد الحال", () => {
    const scope = newScope();
    render(<StrictMode>{index("ar", scope)}</StrictMode>);
    fireEvent.click(star(EXPLAIN));
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code"] });
    expect(pressed(star(EXPLAIN))).toBe("true");
    fireEvent.click(star(EXPLAIN));
    expect(stored(scope)).toEqual({ v: 1, ids: [] });
    expect(pressed(star(EXPLAIN))).toBe("false");
  });
});

describe("مرشّح المفضّلة", () => {
  it("يعرض المفضّلة بترتيب الفهرس، ويجتمع مع التصنيف والبحث العربي", async () => {
    const scope = newScope();
    seed(scope, { v: 1, ids: ["document-qa", "explain-code", "arabic-proofreader"] });
    render(index("ar", scope));
    expect(hrefs()).toHaveLength(SKILLS.length);

    fireEvent.click(filterButton());
    expect(pressed(filterButton())).toBe("true");
    expect(hrefs()).toEqual(["/extensions/arabic-proofreader", "/extensions/explain-code", "/extensions/document-qa"]);

    fireEvent.click(chip("الكتابة"));
    expect(hrefs()).toEqual(["/extensions/arabic-proofreader"]);
    fireEvent.click(chip("الكل"));

    const box = screen.getByRole("searchbox", { name: L.ar.search });
    fireEvent.change(box, { target: { value: "الشيفره" } });
    await waitFor(() => expect(hrefs()).toEqual(["/extensions/explain-code"]));
    // مهارةٌ موجودة لكنها ليست مفضّلة ⇒ «لا نتائج» لا «لا مفضّلة»
    fireEvent.change(box, { target: { value: "ترجمه" } });
    await waitFor(() => expect(statusTexts()).toEqual([L.ar.noMatch]));
    // إطفاء المرشّح يعيدها مع البحث نفسه
    fireEvent.click(filterButton());
    expect(pressed(filterButton())).toBe("false");
    await waitFor(() => expect(hrefs()).toEqual(["/extensions/translate-ar-en"]));
  });

  it("الفراغ: لا مفضّلة ⇒ كيف تُضاف؛ وإزالة الأخيرة من داخل المرشّح تُظهره", () => {
    const scope = newScope();
    render(index("ar", scope));
    fireEvent.click(filterButton());
    expect(statusTexts()).toEqual([L.ar.empty]);
    expect(screen.queryByRole("list", { name: L.ar.list })).toBeNull();

    fireEvent.click(filterButton());
    fireEvent.click(star(EXPLAIN));
    fireEvent.click(filterButton());
    expect(hrefs()).toEqual(["/extensions/explain-code"]);
    fireEvent.click(star(EXPLAIN));
    expect(statusTexts()).toEqual([L.ar.empty]);
    expect(stored(scope)).toEqual({ v: 1, ids: [] });
  });

  it("البحث والتصفية كما كانا حين لا مفضّلة", async () => {
    render(index("ar", newScope()));
    fireEvent.click(chip("الكتابة"));
    expect(hrefs()).toEqual(SKILLS.filter((s) => s.category === "writing").map((s) => `/extensions/${s.id}`));
    fireEvent.click(chip("الكل"));
    fireEvent.change(screen.getByRole("searchbox", { name: L.ar.search }), { target: { value: "code" } });
    await waitFor(() => expect(hrefs()).toEqual(["/extensions/explain-code"]));
    fireEvent.change(screen.getByRole("searchbox", { name: L.ar.search }), { target: { value: "zzzz" } });
    await waitFor(() => expect(statusTexts()).toEqual([L.ar.noMatch]));
  });
});

describe("المحفوظ غير الصالح", () => {
  it("المعرّف المجهول أو المحذوف أو المشوّه أو المكرّر يُتجاهل، والكتابة التالية تنظّفه", () => {
    const scope = newScope();
    seed(scope, { v: 1, ids: ["removed-skill", "explain-code", "../etc/passwd", "explain-code", 42, "__proto__"] });
    render(index("ar", scope));
    expect(pressedStars()).toEqual([`${L.ar.star}: ${EXPLAIN.name.ar}`]);
    expect(filterButton().textContent).toBe(`${L.ar.filter}1`);
    fireEvent.click(star(PROOFREADER));
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code", "arabic-proofreader"] });
  });

  it("القيمة التالفة أو بإصدارٍ آخر تُقرأ فارغة بلا كسر، والكتابة تستبدلها بالشكل الصحيح", () => {
    for (const bad of ["{", "null", "[]", '"explain-code"', JSON.stringify({ v: 2, ids: ["explain-code"] }), JSON.stringify({ ids: "explain-code" })]) {
      const scope = newScope();
      seed(scope, bad);
      render(index("ar", scope));
      expect(pressedStars(), bad).toEqual([]);
      expect(filterButton().textContent, bad).toBe(`${L.ar.filter}0`);
      fireEvent.click(star(EXPLAIN));
      expect(stored(scope), bad).toEqual({ v: 1, ids: ["explain-code"] });
      cleanup();
    }
  });
});

describe("عزل الحسابات", () => {
  it("تبديل الحساب يقرأ مفتاحًا آخر، والعودة تعيد المفضّلة كما كانت", () => {
    const a = newScope();
    const b = newScope();
    const { rerender } = render(index("ar", a));
    fireEvent.click(star(PROOFREADER));

    rerender(index("ar", b));
    expect(pressedStars()).toEqual([]);
    fireEvent.click(star(EXPLAIN));

    rerender(index("ar", a));
    expect(pressedStars()).toEqual([`${L.ar.star}: ${PROOFREADER.name.ar}`]);
    expect(stored(a)).toEqual({ v: 1, ids: ["arabic-proofreader"] });
    expect(stored(b)).toEqual({ v: 1, ids: ["explain-code"] });
    // لا مفتاح عامّ مشترك — مفتاحٌ لكل نطاق، ولا يحمل أيٌّ منهما غير بادئته ونطاقه
    expect(Object.keys(window.localStorage).sort()).toEqual([keyOf(a), keyOf(b)].sort());
    for (const key of Object.keys(window.localStorage)) expect(key).toMatch(/^ysd\.skillFavorites\.v1:[a-f0-9]{32}$/);
  });

  it("ما بقي في ذاكرة التبويب لحسابٍ لا يظهر لغيره، ولا إعلانه", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const a = newScope();
    const b = newScope();
    const { rerender } = render(index("ar", a));
    fireEvent.click(star(PROOFREADER));
    expect(statusTexts()).toEqual([L.ar.notSaved]);

    rerender(index("ar", b));
    expect(pressedStars()).toEqual([]);
    expect(statusTexts()).toEqual([]);

    rerender(index("ar", a));
    expect(pressedStars()).toEqual([`${L.ar.star}: ${PROOFREADER.name.ar}`]);
  });

  it("بلا نطاقٍ صالح لا مفضّلة ولا أزرار لها — ولا قراءة ولا كتابة", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    for (const scope of [undefined, null, "", "global", randomUUID()]) {
      render(index("ar", scope));
      expect(document.querySelectorAll("[data-favorite-toggle]"), String(scope)).toHaveLength(0);
      expect(screen.queryByRole("button", { name: new RegExp(`^${L.ar.filter}`) }), String(scope)).toBeNull();
      cleanup();
      render(detail(PROOFREADER, "ar", scope));
      expect(document.querySelectorAll("[data-favorite-toggle]"), String(scope)).toHaveLength(0);
      cleanup();
    }
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("تبويبٌ آخر للحساب نفسه: حدث storage يحدّث النجوم، ومسح التخزين يفرغها", () => {
    const scope = newScope();
    render(index("ar", scope));
    seed(scope, { v: 1, ids: ["study-questions"] });
    fireEvent(window, new StorageEvent("storage", { key: keyOf(scope) }));
    expect(pressedStars()).toEqual([`${L.ar.star}: ${skill("study-questions").name.ar}`]);
    window.localStorage.clear();
    fireEvent(window, new StorageEvent("storage", { key: null }));
    expect(pressedStars()).toEqual([]);
  });
});

describe("تعذّر التخزين", () => {
  it("الامتلاء: المفضّلة تعمل للجلسة و«لم تُحفظ» معلنة، ثم تُحفظ حين يعود التخزين", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const scope = newScope();
    render(index("ar", scope));
    fireEvent.click(star(EXPLAIN));
    expect(pressed(star(EXPLAIN))).toBe("true");
    expect(statusTexts()).toEqual([L.ar.notSaved]);
    expect(stored(scope)).toBeNull();

    setItem.mockRestore();
    fireEvent.click(star(PROOFREADER));
    expect(statusTexts()).toEqual([]);
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code", "arabic-proofreader"] });
  });

  it("القراءة المحجوبة: الصفحة تُعرض بلا مفضّلة، والكتابة التي لا تُقرأ تُعلن «لم تُحفظ»", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const scope = newScope();
    render(index("ar", scope));
    expect(hrefs()).toHaveLength(SKILLS.length);
    expect(pressedStars()).toEqual([]);
    fireEvent.click(star(EXPLAIN));
    expect(pressed(star(EXPLAIN))).toBe("true");
    expect(statusTexts()).toEqual([L.ar.notSaved]);
  });

  it("التخزين غائبٌ كلّه (الوصول إليه يرمي): لا كسر، والمفضّلة للجلسة", () => {
    const own = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      render(index("en", newScope()));
      expect(hrefs("en")).toHaveLength(SKILLS.length);
      fireEvent.click(star(EXPLAIN, "en"));
      expect(pressed(star(EXPLAIN, "en"))).toBe("true");
      expect(statusTexts()).toEqual([L.en.notSaved]);
    } finally {
      cleanup();
      if (own) Object.defineProperty(window, "localStorage", own);
      else delete (window as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("صفحة المهارة", () => {
  it("زرّ التفضيل الموسوم يبدّل حالتها ويُبقي بقيّة المفضّلة", () => {
    const scope = newScope();
    seed(scope, { v: 1, ids: ["explain-code", "study-questions"] });
    render(detail(PROOFREADER, "ar", scope));
    const button = screen.getByRole("button", { name: L.ar.star });
    expect(pressed(button)).toBe("false");
    expect(button.getAttribute("title")).toBe(L.ar.add);
    fireEvent.click(button);
    expect(pressed(screen.getByRole("button", { name: L.ar.star }))).toBe("true");
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code", "study-questions", "arabic-proofreader"] });
    fireEvent.click(screen.getByRole("button", { name: L.ar.star }));
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code", "study-questions"] });
  });

  it("بلا الفهرس، أو بفهرسٍ لا يضمّ المهارة: لا زرّ — كي لا تمحو الكتابةُ بقيّة المفضّلة", () => {
    const scope = newScope();
    seed(scope, { v: 1, ids: ["explain-code"] });
    for (const catalog of ["none", ["explain-code"]] as const) {
      render(detail(PROOFREADER, "ar", scope, catalog));
      expect(screen.queryByRole("button", { name: L.ar.star })).toBeNull();
      cleanup();
    }
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code"] });
  });

  it("الأزرار: النسخ والتفضيل وحدهما، ولا نصّ يعد بتنفيذ", () => {
    render(detail(PROOFREADER, "ar", newScope()));
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([L.ar.star, "نسخ التعليمات"]);
    for (const b of buttons) {
      expect(b.textContent ?? "").not.toMatch(PROMISE);
      expect(b.getAttribute("title") ?? "").not.toMatch(PROMISE);
    }
  });
});

describe("الحدود: التفضيل علامةٌ لا فعل", () => {
  it("المهارة المعطّلة تُفضَّل، وصلاحيتها تبقى معطّلة، ولا رابط محادثة لها", () => {
    const scope = newScope();
    render(detail(DOCUMENT_QA, "ar", scope));
    fireEvent.click(screen.getByRole("button", { name: L.ar.star }));
    expect(pressed(screen.getByRole("button", { name: L.ar.star }))).toBe("true");
    expect(stored(scope)).toEqual({ v: 1, ids: ["document-qa"] });
    expect(screen.queryByRole("link", { name: L.ar.useInChat })).toBeNull();
    expect(screen.getByText("قراءة ملفات المكتبة").closest("li")?.textContent).toContain(L.ar.disabled);
    expect(screen.getByRole("note")).toBeTruthy();
    cleanup();

    // وفي الفهرس: مفضّلةٌ تحت المرشّح، وشارتها المعطّلة كما هي
    render(index("ar", scope));
    fireEvent.click(filterButton());
    expect(hrefs()).toEqual(["/extensions/document-qa"]);
    const [only] = cards();
    if (!only) throw new Error("document-qa card missing");
    expect(within(only).getByTitle(L.ar.disabled).textContent).toBe("قراءة ملفات المكتبة");
  });

  it("المرحلة 3B كما كانت: «استخدام في محادثة» بالرابط نفسه قبل التفضيل وبعده، باللغتين", () => {
    for (const locale of ["ar", "en"] as const) {
      render(detail(PROOFREADER, locale, newScope()));
      const link = () => screen.getByRole("link", { name: L[locale].useInChat });
      expect(link().getAttribute("href")).toBe(skillChatHref("arabic-proofreader"));
      fireEvent.click(screen.getByRole("button", { name: L[locale].star }));
      expect(link().getAttribute("href")).toBe(skillChatHref("arabic-proofreader"));
      cleanup();
    }
  });

  it("لا شبكة ولا تنقّل ولا مسودة محادثة", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const href = window.location.href;
    const scope = newScope();

    render(index("ar", scope));
    fireEvent.click(star(PROOFREADER));
    fireEvent.click(filterButton());
    fireEvent.click(star(PROOFREADER));
    cleanup();
    render(detail(EXPLAIN, "ar", scope));
    fireEvent.click(screen.getByRole("button", { name: L.ar.star }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    for (const fn of Object.values(nav)) expect(fn).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    // لا مسودة ولا شيء خارج بادئة المفضّلة
    for (const key of Object.keys(window.localStorage)) expect(key.startsWith(FAVORITES_KEY_PREFIX)).toBe(true);
    expect(stored(scope)).toEqual({ v: 1, ids: ["explain-code"] });
  });

  it("أزرار الفهرس: الرقائق والمرشّح ونجمةٌ لكل مهارة — ولا نصّ يعد بتنفيذ", () => {
    render(index("ar", newScope()));
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6 + 1 + SKILLS.length);
    for (const b of buttons) {
      expect(b.textContent ?? "").not.toMatch(PROMISE);
      expect(b.getAttribute("aria-label") ?? "").not.toMatch(PROMISE);
      expect(b.getAttribute("title") ?? "").not.toMatch(PROMISE);
    }
  });
});

describe("الإنجليزية", () => {
  it("الفهرس وصفحة المهارة بتسمياتهما", () => {
    const scope = newScope();
    render(index("en", scope));
    expect(filterButton("en").textContent).toBe(`${L.en.filter}0`);
    const button = star(PROOFREADER, "en");
    expect(button.getAttribute("title")).toBe(L.en.add);
    fireEvent.click(button);
    expect(star(PROOFREADER, "en").getAttribute("title")).toBe(L.en.remove);
    fireEvent.click(star(PROOFREADER, "en"));
    fireEvent.click(filterButton("en"));
    expect(statusTexts()).toEqual([L.en.empty]);
    cleanup();

    render(detail(EXPLAIN, "en", scope));
    expect(screen.getByRole("button", { name: L.en.star }).textContent).toBe(L.en.star);
  });
});

describe("HTML الخادم والإماهة", () => {
  it("HTML الخادم لا يعرف المفضّلة ولا النطاق: متطابقٌ بين حسابين وتخزينين", () => {
    const a = newScope();
    const b = newScope();
    seed(a, { v: 1, ids: ["explain-code", "arabic-proofreader"] });
    for (const locale of ["ar", "en"] as const) {
      const html = renderToString(index(locale, a));
      expect(html, locale).toBe(renderToString(index(locale, b)));
      expect(html, locale).not.toContain(a);
      const probe = document.createElement("div");
      probe.innerHTML = html;
      expect(probe.querySelectorAll("[data-favorite-toggle]"), locale).toHaveLength(SKILLS.length);
      expect(probe.querySelectorAll('[data-favorite-toggle][aria-pressed="true"]'), locale).toHaveLength(0);
      const page = renderToString(detail(PROOFREADER, locale, a));
      expect(page, locale).toBe(renderToString(detail(PROOFREADER, locale, b)));
    }
  });

  it("الإماهة بلا خطأ قابل للاسترداد ولا سجلّ إماهة، ثم تظهر المفضّلة المحفوظة", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const scope = newScope();
    seed(scope, { v: 1, ids: ["explain-code", "arabic-proofreader"] });
    const cases = [
      { name: "index", element: (l: Locale) => index(l, scope), expected: 2 },
      { name: "detail", element: (l: Locale) => detail(PROOFREADER, l, scope), expected: 1 },
    ];
    for (const { name, element, expected } of cases) {
      for (const locale of ["ar", "en"] as const) {
        const container = document.createElement("div");
        container.innerHTML = renderToString(element(locale));
        document.body.appendChild(container);
        const recoverable: unknown[] = [];
        render(element(locale), { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
        expect(recoverable, `${name}/${locale}`).toEqual([]);
        await waitFor(() =>
          expect(container.querySelectorAll('[data-favorite-toggle][aria-pressed="true"]'), `${name}/${locale}`).toHaveLength(
            expected,
          ),
        );
        cleanup();
        container.remove();
      }
    }
    const hydrationLogs = consoleError.mock.calls.filter((c) => /hydrat|#418|#423|#425/i.test(c.map(String).join(" ")));
    expect(hydrationLogs).toEqual([]);
  });
});
