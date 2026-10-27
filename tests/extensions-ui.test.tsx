/**
 * الإضافات — فهرس المهارات المدمجة وصفحة المهارة (المرحلة 3A).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - الفهرس يعرض ما في السجلّ المدمج كما هو: العنوان والعدد والوصف، وبطاقةٌ لكل مهارة
 *     برابط صفحتها، بترتيب الفهرس، باسمها بلغة الواجهة.
 *   - البحث عربيٌّ بلا تشكيل ولا فرقٍ بين التاء المربوطة والهاء، ويجد المعرّف والوسم
 *     الإنجليزيّ من واجهةٍ عربية؛ والفراغ معلَن (status) لا صامت.
 *   - التصفية بالتصنيف معلنة الحالة (aria-pressed)، و«الكل» يعيد الجميع.
 *   - الصلاحية المعطّلة تظهر باهتةً باسمها مع تلميحٍ يسمّي حدّها — لا مخفيّةً ولا عاملة.
 *   - صفحة المهارة: العودة إلى الفهرس، والإصدار بالاتجاه اللاتيني، وحالة كل صلاحية نصًّا
 *     بلا مفاتيح، وملاحظة «لا تعمل آليًّا» لما يعتمد على صلاحيةٍ معطّلة وحده.
 *   - النسخ فعلٌ واحد: ينسخ التعليمات بلغة الواجهة ويعلن «نُسخت»، ويعلن «تعذّر النسخ»
 *     عند رفض الحافظة أو غيابها — بلا استثناء.
 *   - الصدق: لا زرّ ولا رابط يعد بتثبيتٍ أو تفعيلٍ أو تشغيلٍ أو «قريبًا»؛ أزرار الفهرس
 *     رقائق التصنيف وحدها، وزرّ الصفحة زرّ النسخ وحده.
 *   - HTML الخادم حتميّ، والإماهة في المتصفح بلا خطأ قابل للاسترداد ولا سجلّ إماهة.
 *   - الشيفرة: لا اتجاه فيزيائيّ، ولا لون مباشر، ولا ساعة ولا عشوائية أثناء العرض،
 *     ولا شبكة ولا بيئة، ولا «قريبًا».
 *
 * المكوّنات الحقيقية مع السجلّ الحقيقي والقاموس الحقيقي؛ يُستبدل الموجّه وزرّ قائمة الجوال والحافظة فقط.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/extensions",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { ExtensionsView } from "@/components/extensions/extensions-view";
import { SkillDetail } from "@/components/extensions/skill-detail";
import { I18nProvider, type Locale } from "@/lib/i18n";
import type { SkillManifest } from "@/lib/skills/manifest";
import { builtInSkillRegistry } from "@/lib/skills/registry";

// عرض الخادم الحقيقي (react-dom/server) — المشروع بلا @types/react-dom، فيُحمَّل بنوعٍ صريح لما نستعمله وحده
const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

/** البيانات من السجلّ المدمج نفسه — لا نسخ يدويّ لنصوص المهارات كي لا يتقادم الاختبار عنها */
const SKILLS = builtInSkillRegistry().list();
function skill(id: string): SkillManifest {
  const found = builtInSkillRegistry().get(id);
  if (!found) throw new Error(`built-in skill missing from the registry: ${id}`);
  return found;
}
const PROOFREADER = skill("arabic-proofreader");
const DOCUMENT_QA = skill("document-qa");

/** ما لا يجوز أن يعد به زرٌّ أو رابط ما دام التنفيذ لم يُبنَ */
const PROMISE =
  /ثبّت|تثبيت|تفعيل|فعّل|تشغيل|شغّل|استخدام في المحادثة|قريبًا|install|enable|activate|run\b|execute|use in chat|coming soon/i;

const LABELS = {
  ar: { list: "قائمة المهارات", search: "بحث في المهارات", filter: "تصفية حسب التصنيف", copy: "نسخ التعليمات" },
  en: { list: "Skills list", search: "Search skills", filter: "Filter by category", copy: "Copy instructions" },
} as const;

// الحافظة غائبة في jsdom؛ تُعرَّف خاصيّةً قابلة للإزالة على الكائن نفسه ثم تُعاد كما كانت
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}
function restoreClipboard() {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
}

afterEach(() => {
  cleanup();
  restoreClipboard();
  vi.restoreAllMocks();
});

const index = (locale: Locale) => (
  <I18nProvider initialLocale={locale}>
    <ExtensionsView skills={SKILLS} />
  </I18nProvider>
);
const detail = (s: SkillManifest, locale: Locale) => (
  <I18nProvider initialLocale={locale}>
    <SkillDetail skill={s} />
  </I18nProvider>
);
const renderIndex = (locale: Locale = "ar") => render(index(locale));
const renderDetail = (s: SkillManifest, locale: Locale = "ar") => render(detail(s, locale));

const list = (locale: Locale = "ar") => screen.getByRole("list", { name: LABELS[locale].list });
const cards = (locale: Locale = "ar") => within(list(locale)).getAllByRole("link");
const hrefs = (locale: Locale = "ar") => cards(locale).map((a) => a.getAttribute("href"));
const cardNames = (locale: Locale = "ar") => cards(locale).map((a) => a.querySelector("bdi")?.textContent);
const chips = () => screen.getByRole("group", { name: LABELS.ar.filter });
const chip = (name: string) => within(chips()).getByRole("button", { name });
const section = (title: string) => {
  const found = screen.getByRole("heading", { level: 2, name: title }).closest("section");
  if (!found) throw new Error(`section missing for heading: ${title}`);
  return found;
};
/** صفوف قائمة الصلاحيات: [الاسم، الحالة] لكلٍّ منها */
const capabilityRows = (title = "الصلاحيات") =>
  within(section(title))
    .getAllByRole("listitem")
    .map((li) => Array.from(li.children).map((c) => c.textContent));

describe("فهرس الإضافات", () => {
  it("يعرض العنوان والعدد والوصف، وبطاقةً لكل مهارة مدمجة برابط صفحتها بترتيب الفهرس", () => {
    renderIndex();
    expect(SKILLS).toHaveLength(8);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("الإضافات");
    const header = screen.getByRole("heading", { level: 1 }).closest("header")?.textContent ?? "";
    expect(header).toContain("8");
    expect(header).toContain("مهارات مدمجة");
    expect(screen.getByText("مهارات مدمجة تُوجّه المحادثة: تصفّحها، واقرأ تعليماتها، وانسخها إلى محادثتك.")).toBeTruthy();
    expect(hrefs()).toEqual(SKILLS.map((s) => `/extensions/${s.id}`));
    expect(cardNames()).toEqual(SKILLS.map((s) => s.name.ar));
    // ملخّص كل مهارة بالعربية على بطاقتها
    for (const s of SKILLS) expect(within(list()).getByText(s.summary.ar)).toBeTruthy();
  });

  it("البحث: عربيٌّ بالهاء مكان التاء المربوطة، وبالمعرّف الإنجليزي، والفراغ معلَن", async () => {
    renderIndex();
    const box = screen.getByRole("searchbox", { name: LABELS.ar.search });
    fireEvent.change(box, { target: { value: "ترجمه" } });
    await waitFor(() => expect(hrefs()).toEqual(["/extensions/translate-ar-en"]));
    fireEvent.change(box, { target: { value: "code" } });
    await waitFor(() => expect(hrefs()).toEqual(["/extensions/explain-code"]));
    fireEvent.change(box, { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("لا مهارات تطابق البحث."));
    expect(screen.queryByRole("list", { name: LABELS.ar.list })).toBeNull();
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(hrefs()).toHaveLength(8));
  });

  it("التصفية بالتصنيف معلنة الحالة، و«الكل» يعيد الجميع", () => {
    renderIndex();
    expect(within(chips()).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "الكل",
      "الكتابة",
      "البحث",
      "التعلّم",
      "الإنتاجية",
      "الشيفرة",
    ]);
    expect(chip("الكل").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("الكتابة"));
    expect(chip("الكتابة").getAttribute("aria-pressed")).toBe("true");
    expect(chip("الكل").getAttribute("aria-pressed")).toBe("false");
    const writing = SKILLS.filter((s) => s.category === "writing");
    expect(writing).toHaveLength(3);
    expect(hrefs()).toEqual(writing.map((s) => `/extensions/${s.id}`));
    fireEvent.click(chip("الكل"));
    expect(chip("الكل").getAttribute("aria-pressed")).toBe("true");
    expect(hrefs()).toHaveLength(8);
  });

  it("شارة الصلاحية المعطّلة باهتةٌ باسمها وتلميحها يسمّي حدّها؛ والمسموحة بلا تلميح", () => {
    renderIndex();
    const card = cards().find((a) => a.getAttribute("href") === "/extensions/document-qa");
    if (!card) throw new Error("document-qa card missing");
    const disabled = within(card).getByTitle("غير مفعّلة في هذا الإصدار");
    expect(disabled.textContent).toBe("قراءة ملفات المكتبة");
    expect(disabled.className).toContain("text-ink-faint");
    expect(disabled.className).toContain("border-dashed");
    expect(within(card).getByText("تعليمات نصّية").getAttribute("title")).toBeNull();
    expect(within(card).getByText("البحث")).toBeTruthy();
    expect(within(card).getByText(`v${DOCUMENT_QA.version}`).getAttribute("dir")).toBe("ltr");
    // المهارة التصريحية وحدها لا تحمل شارةً معطّلة
    const plain = cards().find((a) => a.getAttribute("href") === "/extensions/arabic-proofreader");
    if (!plain) throw new Error("arabic-proofreader card missing");
    expect(within(plain).queryByTitle("غير مفعّلة في هذا الإصدار")).toBeNull();
  });

  it("الإنجليزية", async () => {
    renderIndex("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Extensions");
    expect(cardNames("en")).toEqual(SKILLS.map((s) => s.name.en));
    expect(screen.getByRole("group", { name: LABELS.en.filter })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: LABELS.en.search }), { target: { value: "proofreader" } });
    await waitFor(() => expect(hrefs("en")).toEqual(["/extensions/arabic-proofreader"]));
  });
});

describe("صفحة المهارة", () => {
  it("المدقّق اللغوي: الاسم والعودة والإصدار، وصلاحيةٌ تصريحية تعمل — بلا ملاحظة تعطيل", () => {
    renderDetail(PROOFREADER);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PROOFREADER.name.ar);
    expect(screen.getByRole("link", { name: "العودة إلى الإضافات" }).getAttribute("href")).toBe("/extensions");
    expect(screen.getByText(PROOFREADER.version).getAttribute("dir")).toBe("ltr");
    expect(screen.getByText("الإصدار", { exact: false })).toBeTruthy();
    expect(screen.getByText("مدمجة في المنصّة")).toBeTruthy();
    expect(screen.getByText("الكتابة")).toBeTruthy();
    expect(screen.getByText(PROOFREADER.summary.ar)).toBeTruthy();
    expect(screen.getByText(PROOFREADER.description.ar)).toBeTruthy();
    expect(capabilityRows()).toEqual([["تعليمات نصّية", "تعمل كتعليمات تُقرأ وتُنسخ"]]);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/تعتمد على صلاحيةٍ غير مفعّلة/)).toBeNull();
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe(PROOFREADER.instructions.ar);
    expect(pre?.getAttribute("dir")).toBe("auto");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(within(section("أمثلة على الاستخدام")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      PROOFREADER.examples.map((e) => e.ar),
    );
    expect(screen.getByText(/لا تثبيت لإضافات خارجية ولا تنفيذ تلقائي/)).toBeTruthy();
  });

  it("سؤال وجواب عن المستندات: الصلاحية المعطّلة بحالتها نصًّا، وملاحظةٌ أنها لا تعمل آليًّا", () => {
    renderDetail(DOCUMENT_QA);
    expect(capabilityRows()).toEqual([
      ["تعليمات نصّية", "تعمل كتعليمات تُقرأ وتُنسخ"],
      ["قراءة ملفات المكتبة", "غير مفعّلة في هذا الإصدار"],
    ]);
    expect(screen.getByRole("note").textContent).toBe(
      "تعتمد على صلاحيةٍ غير مفعّلة، فلا تعمل آليًّا بعد — تعليماتها للقراءة والنسخ.",
    );
    // حالةٌ نصّية لا مفاتيح: لا زرّ ولا مفتاح ولا صندوق اختيار في قسم الصلاحيات
    const caps = within(section("الصلاحيات"));
    expect(caps.queryByRole("button")).toBeNull();
    expect(caps.queryByRole("switch")).toBeNull();
    expect(caps.queryByRole("checkbox")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe(DOCUMENT_QA.instructions.ar);
  });

  it("الإنجليزية", () => {
    renderDetail(PROOFREADER, "en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(PROOFREADER.name.en);
    expect(screen.getByRole("link", { name: "Back to Extensions" }).getAttribute("href")).toBe("/extensions");
    expect(screen.getByText("Writing")).toBeTruthy();
    expect(screen.getByText("Built into the platform")).toBeTruthy();
    expect(capabilityRows("Capabilities")).toEqual([["Instruction template", "Works as instructions you read and copy"]]);
    expect(document.querySelector("pre")?.textContent).toBe(PROOFREADER.instructions.en);
    expect(within(section("Example requests")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      PROOFREADER.examples.map((e) => e.en),
    );
  });
});

describe("نسخ التعليمات", () => {
  it("ينسخ تعليمات المهارة بلغة الواجهة مرّةً واحدة ويعلن «نُسخت»", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    renderDetail(PROOFREADER);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: LABELS.ar.copy }));
    expect((await screen.findByRole("status")).textContent).toBe("نُسخت");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(PROOFREADER.instructions.ar);
  });

  it("رفض الحافظة ⇒ «تعذّر النسخ» بإرشادٍ يدوي، لا صمت", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setClipboard({ writeText });
    renderDetail(PROOFREADER);
    fireEvent.click(screen.getByRole("button", { name: LABELS.ar.copy }));
    expect((await screen.findByRole("status")).textContent).toContain("تعذّر النسخ");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("غياب الحافظة ⇒ «تعذّر النسخ» بلا استثناء", async () => {
    setClipboard(undefined);
    renderDetail(PROOFREADER);
    fireEvent.click(screen.getByRole("button", { name: LABELS.ar.copy }));
    expect((await screen.findByRole("status")).textContent).toContain("تعذّر النسخ");
  });

  it("الإنجليزية: «Copy instructions» ينسخ النصّ الإنجليزي ويعلن «Copied»", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    renderDetail(PROOFREADER, "en");
    fireEvent.click(screen.getByRole("button", { name: LABELS.en.copy }));
    expect((await screen.findByRole("status")).textContent).toBe("Copied");
    expect(writeText).toHaveBeenCalledWith(PROOFREADER.instructions.en);
  });
});

describe("الصدق: لا وعد بما لم يُبنَ", () => {
  const nameOf = (el: Element) => el.getAttribute("aria-label") ?? el.textContent ?? "";

  it("لا زرّ ولا رابط يعد بتثبيتٍ أو تفعيلٍ أو تشغيل — في الفهرس وكل صفحة مهارة، بالعربية والإنجليزية", () => {
    for (const locale of ["ar", "en"] as const) {
      renderIndex(locale);
      // أزرار الفهرس رقائق التصنيف وحدها
      const group = screen.getByRole("group", { name: LABELS[locale].filter });
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(6);
      for (const b of buttons) expect(group.contains(b), b.outerHTML.slice(0, 80)).toBe(true);
      for (const el of [...buttons, ...screen.getAllByRole("link")]) {
        expect(nameOf(el), `${locale} index: ${el.outerHTML.slice(0, 120)}`).not.toMatch(PROMISE);
      }
      expect(document.body.textContent, `${locale} index`).not.toMatch(/قريبًا|coming soon/i);
      cleanup();

      for (const s of SKILLS) {
        renderDetail(s, locale);
        // زرٌّ واحد لفعلٍ واحد
        const only = screen.getAllByRole("button");
        expect(only, `${s.id}/${locale}`).toHaveLength(1);
        expect(only[0]?.textContent, `${s.id}/${locale}`).toBe(LABELS[locale].copy);
        for (const el of [...only, ...screen.getAllByRole("link")]) {
          expect(nameOf(el), `${s.id}/${locale}: ${el.outerHTML.slice(0, 120)}`).not.toMatch(PROMISE);
        }
        expect(document.body.textContent, `${s.id}/${locale}`).not.toMatch(/قريبًا|coming soon/i);
        cleanup();
      }
    }
  });

  it("كل زرّ له اسم مسموع في الفهرس وصفحة المهارة", () => {
    renderIndex();
    renderDetail(DOCUMENT_QA);
    for (const b of screen.getAllByRole("button")) {
      const name = b.getAttribute("aria-label") ?? b.textContent ?? "";
      expect(name.trim(), b.outerHTML.slice(0, 80)).not.toBe("");
    }
  });
});

describe("HTML الخادم والإماهة", () => {
  it("حتميّ: عرضان متطابقان يحملان الاسم العربي ورابط العودة", () => {
    const element = detail(PROOFREADER, "ar");
    const first = renderToString(element);
    expect(renderToString(element)).toBe(first);
    expect(first).toContain(PROOFREADER.name.ar);
    expect(first).toContain('href="/extensions"');
    expect(first).not.toMatch(/قريبًا|coming soon/i);
  });

  it("الإماهة بالشجرة نفسها بلا خطأ قابل للاسترداد ولا سجلّ إماهة — للتصريحية والمعطّلة باللغتين", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const s of [PROOFREADER, DOCUMENT_QA]) {
      for (const locale of ["ar", "en"] as const) {
        const element = detail(s, locale);
        const container = document.createElement("div");
        container.innerHTML = renderToString(element);
        document.body.appendChild(container);
        const recoverable: unknown[] = [];
        render(element, { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
        expect(recoverable, `${s.id}/${locale}`).toEqual([]);
        expect(container.querySelector("h1")?.textContent, `${s.id}/${locale}`).toBe(s.name[locale]);
        cleanup();
        container.remove();
      }
    }
    const hydrationLogs = consoleError.mock.calls.filter((c) => /hydrat|#418|#423|#425/i.test(c.map(String).join(" ")));
    expect(hydrationLogs).toEqual([]);
  });
});

describe("حرّاس الشيفرة", () => {
  const FILES = ["components/extensions/extensions-view.tsx", "components/extensions/skill-detail.tsx"];
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  // التعليقات عربيةٌ تشرح السبب وقد تذكر ما يُمنع؛ فالفحوص التقنية على الشيفرة وحدها
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("لا اتجاه فيزيائيّ ولا لون مباشر ولا dark: — المنطقيّ والرموز وحدها", () => {
    for (const f of FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr)-\d|\b(left|right)-\d|text-(left|right)\b|rounded-[lr]-|border-[lr]\b/);
      expect(stripComments(src), f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(stripComments(src), f).not.toMatch(/\bdark:/);
    }
  });

  it("لا ساعة ولا عشوائية أثناء العرض، ولا شبكة ولا بيئة", () => {
    for (const f of FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/Date\.now|new Date|Math\.random/);
      expect(code, f).not.toMatch(/\bfetch\(/);
      expect(code, f).not.toMatch(/process\.env/);
    }
  });

  it("لا «قريبًا» ولا «استخدام في المحادثة» في المصدر كلّه", () => {
    for (const f of FILES) {
      expect(read(f), f).not.toMatch(/use in chat|coming soon|قريبًا/i);
    }
  });
});
