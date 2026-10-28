/**
 * الهيكل الموحّد — شريط الأيقونات، ولوحة السياق، وقائمة الحساب، والبحث السريع.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - لا يظهر في التنقل إلا ما يعمل؛ الأيقونات بأسماءٍ مسموعة، والوحدة النشطة معلَنة (aria-current).
 *   - اللوحة تتبع الوحدة: المحادثات والمشاريع، أو أقسام الإعدادات، أو لا لوحة للمكتبة.
 *   - اللوحة ومجموعتاها قابلة للطي ومعلَنة الحالة (aria-expanded).
 *   - قائمة الحساب تُكشف وتُغلق بـEsc وتعيد التركيز؛ ورابط الإدارة للمشرف وحده.
 *   - Ctrl+K أو أيقونة البحث تفتح البحث، والأسهم وEnter تفتح النتيجة، وEsc يغلق.
 *   - كل زرّ له اسم مسموع، ولا اتجاه فيزيائيّ (يمين/يسار) في الهيكل الجديد.
 *
 * الهيكل الحقيقي مع المزوّدات الحقيقية؛ لا يُستبدل إلا موجّه Next (غير مُركَّب في jsdom).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";

const push = vi.fn();
let pathname = "/chat";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

import { AppShell } from "@/components/shell/app-shell";
import { ThemeProvider } from "@/components/theme";
import { I18nProvider } from "@/lib/i18n";

const conversations = [
  { id: "c1", title: "إعداد خطة السفر", updated_at: "2026-10-01" },
  { id: "c2", title: "ملخص الاجتماع", updated_at: "2026-10-02" },
];
const projects = [
  { id: "p1", name: "مشروع المدرسة" },
  { id: "p2", name: "Website relaunch" },
];

function renderShell(opts: { isAdmin?: boolean; locale?: "ar" | "en" } = {}) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={opts.locale ?? "ar"}>
        <AppShell userName="سارة" tier="free" conversations={conversations} projects={projects} isAdmin={opts.isAdmin}>
          <div>المحتوى</div>
        </AppShell>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const nav = () => screen.getByRole("navigation", { name: "التنقل الرئيسي" });
const panel = () => document.getElementById("shell-panel");

beforeEach(() => {
  pathname = "/chat";
  push.mockReset();
});
afterEach(() => cleanup());

describe("شريط الأيقونات", () => {
  it("يعرض الوحدات المتاحة فقط — أيقونات بأسماءٍ مسموعة بلا نصٍّ مرئي", () => {
    renderShell();
    const rail = within(nav());
    expect(rail.getByRole("link", { name: "المحادثة" }).getAttribute("href")).toBe("/chat");
    expect(rail.getByRole("link", { name: "المشاريع" }).getAttribute("href")).toBe("/projects");
    expect(rail.getByRole("link", { name: "المكتبة" }).getAttribute("href")).toBe("/files");
    expect(rail.getByRole("link", { name: "الإضافات" }).getAttribute("href")).toBe("/extensions");
    expect(rail.getByRole("link", { name: "الأتمتة" }).getAttribute("href")).toBe("/automations");
    expect(rail.getByRole("link", { name: "الإعدادات" }).getAttribute("href")).toBe("/settings");
    for (const label of ["الشيفرة", "النماذج", "العمل"]) {
      expect(rail.queryByRole("link", { name: label }), label).toBeNull();
    }
    // أيقونات فقط: لا تسميات مرئية تزاحم الشريط
    for (const a of rail.getAllByRole("link")) expect(a.textContent?.trim(), a.getAttribute("aria-label") ?? "").toBe("");
  });

  it("الوحدة النشطة معلَنة بـaria-current", () => {
    pathname = "/projects/p1";
    renderShell();
    expect(within(nav()).getByRole("link", { name: "المشاريع" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav()).getByRole("link", { name: "المحادثة" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("قائمة الحساب", () => {
  it("تُكشف من الصورة الرمزية: الاسم والباقة والحساب والاستهلاك والخروج", () => {
    renderShell();
    const toggle = within(nav()).getByRole("button", { name: "قائمة الحساب" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("shell-user-menu")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const menu = within(document.getElementById("shell-user-menu")!);
    expect(menu.getByText("سارة")).toBeTruthy();
    expect(menu.getByRole("link", { name: "الحساب والاستهلاك" }).getAttribute("href")).toBe("/account");
    expect(menu.getByRole("link", { name: "استهلاكي" }).getAttribute("href")).toBe("/usage");
    expect(menu.getByRole("button", { name: "تسجيل الخروج" }).closest("form")?.getAttribute("action")).toBe("/auth/signout");
  });

  it("Esc يغلقها ويعيد التركيز إلى زرّها، والنقر خارجها يغلقها", () => {
    renderShell();
    const toggle = within(nav()).getByRole("button", { name: "قائمة الحساب" });
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("shell-user-menu")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.mouseDown(document.body);
    expect(document.getElementById("shell-user-menu")).toBeNull();
  });

  it("رابط الإدارة للمشرف وحده", () => {
    renderShell();
    fireEvent.click(within(nav()).getByRole("button", { name: "قائمة الحساب" }));
    expect(screen.queryByRole("link", { name: "لوحة الإدارة" })).toBeNull();
    cleanup();
    renderShell({ isAdmin: true });
    fireEvent.click(within(nav()).getByRole("button", { name: "قائمة الحساب" }));
    expect(screen.getByRole("link", { name: "لوحة الإدارة" }).getAttribute("href")).toBe("/admin");
  });
});

describe("لوحة المحادثات والمشاريع", () => {
  it("تُطوى اللوحة وتُفتح، والحالة معلَنة", () => {
    renderShell();
    const toggle = within(nav()).getByRole("button", { name: "طي الشريط الجانبي" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    const reopen = within(nav()).getByRole("button", { name: "توسيع الشريط الجانبي" });
    expect(reopen.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.className).toContain("md:hidden");
  });

  it("محادثة جديدة صفٌّ في رأس اللوحة، ثم المحادثات والمشاريع — بلا حقل تصفية مكرّر", () => {
    renderShell();
    const p = within(panel()!);
    expect(p.getByRole("link", { name: "محادثة جديدة" }).getAttribute("href")).toBe("/chat");
    expect(p.getByRole("link", { name: "إعداد خطة السفر" }).getAttribute("href")).toBe("/chat/c1");
    expect(p.queryByRole("textbox")).toBeNull();
  });

  it("مجموعتا المحادثات والمشاريع قابلتان للطي", () => {
    renderShell();
    const group = screen.getByRole("button", { name: "المشاريع" });
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "مشروع المدرسة" })).toBeTruthy();
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("shell-projects")?.hidden).toBe(true);
  });

  it("روابط المشاريع تفتح صفحة المشروع", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Website relaunch" }).getAttribute("href")).toBe("/projects/p2");
  });
});

describe("اللوحة تتبع الوحدة", () => {
  it("الإعدادات: بحثها وأقسامها بدل المحادثات، والبحث يرشّح الأقسام", () => {
    pathname = "/settings";
    renderShell();
    const p = within(panel()!);
    expect(panel()?.getAttribute("aria-label")).toBe("الإعدادات");
    expect(p.queryByRole("link", { name: "محادثة جديدة" })).toBeNull();
    const sections = p.getByRole("navigation", { name: "أقسام الإعدادات" });
    expect(within(sections).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "المظهر",
      "اللغة",
      "النموذج الافتراضي",
      "الخصوصية وتحسين YSD",
      "البيانات والخصوصية",
    ]);
    fireEvent.change(p.getByRole("searchbox", { name: "ابحث في الإعدادات" }), { target: { value: "سطوع" } });
    expect(within(sections).getAllByRole("button").map((b) => b.textContent)).toEqual(["المظهر"]);
  });

  it("المكتبة: الصفحة بعرضها كاملًا — لا لوحة ولا زرّ طيٍّ بلا عمل", () => {
    pathname = "/files";
    renderShell();
    expect(panel()).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "طي الشريط الجانبي" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "المكتبة" }).getAttribute("aria-current")).toBe("page");
  });

  it("الإضافات: فهرسٌ بعرض الصفحة كالمكتبة — لا لوحة، والوحدة النشطة معلَنة في الفهرس وصفحة المهارة", () => {
    for (const p of ["/extensions", "/extensions/arabic-proofreader"]) {
      pathname = p;
      renderShell();
      expect(panel(), p).toBeNull();
      expect(within(nav()).queryByRole("button", { name: "طي الشريط الجانبي" }), p).toBeNull();
      expect(within(nav()).getByRole("link", { name: "الإضافات" }).getAttribute("aria-current"), p).toBe("page");
      cleanup();
    }
  });

  it("الأتمتة (المرحلة 4A): صفحةٌ بعرضها — لا لوحة، والوحدة النشطة معلَنة", () => {
    pathname = "/automations";
    renderShell();
    expect(panel()).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "طي الشريط الجانبي" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "الأتمتة" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("البحث السريع", () => {
  it("Ctrl+K يفتحه، والكتابة ترشّح، وEnter يفتح النتيجة المختارة", () => {
    renderShell();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = screen.getByRole("dialog", { name: "بحث سريع" });
    const box = within(dialog).getByRole("combobox");
    fireEvent.change(box, { target: { value: "ملخص" } });
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("ملخص الاجتماع")]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/chat/c2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("أيقونة البحث في رأس اللوحة تفتحه؛ يجد الأقسام والمشاريع، والأسهم تنقل الاختيار، وEsc يغلق", () => {
    renderShell();
    fireEvent.click(within(panel()!).getByRole("button", { name: "بحث سريع" }));
    const dialog = screen.getByRole("dialog");
    const box = within(dialog).getByRole("combobox");
    fireEvent.change(box, { target: { value: "م" } });
    const kinds = within(dialog).getAllByRole("option").map((o) => o.getAttribute("data-search-kind"));
    expect(kinds).toContain("page");
    expect(kinds).toContain("project");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(within(dialog).getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("لا نتائج ⇒ رسالة صريحة، ولا تظهر وحدة مخطَّطة", () => {
    renderShell();
    fireEvent.click(within(panel()!).getByRole("button", { name: "بحث سريع" }));
    const box = within(screen.getByRole("dialog")).getByRole("combobox");
    fireEvent.change(box, { target: { value: "الشيفرة" } });
    expect(screen.getByText("لا نتائج")).toBeTruthy();
  });
});

describe("الإتاحة والاتجاه", () => {
  it("كل زرّ في الهيكل له اسم مسموع — والقائمة مفتوحة أيضًا", () => {
    renderShell({ isAdmin: true });
    fireEvent.click(within(nav()).getByRole("button", { name: "قائمة الحساب" }));
    for (const b of screen.getAllByRole("button")) {
      const name = b.getAttribute("aria-label") ?? b.textContent ?? "";
      expect(name.trim(), b.outerHTML.slice(0, 80)).not.toBe("");
    }
  });

  it("الإنجليزية: نفس البنية بأسماء إنجليزية", () => {
    renderShell({ locale: "en" });
    const n = within(screen.getByRole("navigation", { name: "Main navigation" }));
    for (const label of ["Chat", "Projects", "Library", "Extensions", "Automations", "Settings"]) expect(n.getByRole("link", { name: label })).toBeTruthy();
    expect(n.getByRole("button", { name: "Account menu" })).toBeTruthy();
  });

  it("لا خصائص اتجاه فيزيائية في ملفات الهيكل والإعدادات الجديدة", () => {
    for (const f of [
      "components/shell/app-shell.tsx",
      "components/shell/quick-search.tsx",
      "components/settings/settings-search.tsx",
      "components/settings/settings-form.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr)-\d|\b(left|right)-\d|text-(left|right)\b|rounded-[lr]-|border-[lr]\b/);
    }
  });
});
