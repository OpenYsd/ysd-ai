/**
 * الإضافات في التنقل والمسارات — وحدةٌ متاحة بصفحةٍ فعلية (المرحلة 3A).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - السجلّ: `extensions` متاحة على `/extensions` في الشريط الأعلى بعد المكتبة، والمسار الفرعي
 *     يُنسب إليها والمسار المشابه لا.
 *   - سياسة المسارات: `/extensions` وفروعها محميّة، وليست عامّة، والقوائم القديمة لم تفقد عضوًا.
 *   - الصفحتان موجودتان في `app/(app)/extensions`، تحميان بالتوجيه إلى `/login`، وتقرآن السجلّ المدمج.
 *   - البحث السريع يجد «الإضافات» بلا همزة وبجزءٍ من الكلمة.
 *   - الهيكل: أيقونة من السجلّ لا رابطٌ مكتوب يدويًّا، وبلا لوحة جانبية كالمكتبة.
 *
 * بلا محاكاة: الدوال الحقيقية، والصفحات والهيكل والقاموس تُقرأ نصًّا.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { PLATFORM_MODULES, activeModuleId, availableModules, railModules } from "@/lib/platform/modules";
import { PROTECTED_PREFIXES, isProtectedPath, isPublicPath } from "@/lib/route-policy";
import { normalizeForSearch, searchItems, type QuickSearchItem } from "@/lib/platform/search";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LIST_PAGE = "app/(app)/extensions/page.tsx";
const DETAIL_PAGE = "app/(app)/extensions/[id]/page.tsx";

describe("سجلّ الوحدات: الإضافات متاحة", () => {
  it("متاحة على /extensions بمسارٍ واحد تملكه، وفي الشريط الأعلى", () => {
    const ext = PLATFORM_MODULES.find((m) => m.id === "extensions");
    expect(ext).toBeTruthy();
    expect(ext).toMatchObject({
      status: "available",
      href: "/extensions",
      routes: ["/extensions"],
      placement: "primary",
      labelKey: "moduleExtensions",
    });
  });

  it("ترتيب الشريط الأعلى: المحادثة ثم المشاريع ثم المكتبة ثم الإضافات — والإعدادات أسفله وحدها", () => {
    expect(railModules("primary").map((m) => m.id)).toEqual(["chat", "projects", "library", "extensions"]);
    expect(railModules("secondary").map((m) => m.id)).toEqual(["settings"]);
  });

  it("البحث السريع يعرفها من السجلّ نفسه", () => {
    const ext = availableModules().find((m) => m.id === "extensions");
    expect(ext?.href).toBe("/extensions");
  });

  it("الوحدة النشطة: الفهرس وصفحة المهارة كلاهما إضافات — والمسار المشابه لا", () => {
    expect(activeModuleId("/extensions")).toBe("extensions");
    expect(activeModuleId("/extensions/arabic-proofreader")).toBe("extensions");
    expect(activeModuleId("/extensionsx")).toBeNull();
    expect(activeModuleId("/extension")).toBeNull();
  });
});

describe("سياسة المسارات: الإضافات محميّة", () => {
  it("/extensions وفروعها محميّة بحدّ مقطع — والمسار المشابه مجهول", () => {
    expect(isProtectedPath("/extensions")).toBe(true);
    expect(isProtectedPath("/extensions/x")).toBe(true);
    expect(isProtectedPath("/extensions/arabic-proofreader")).toBe(true);
    expect(isProtectedPath("/extensionsx")).toBe(false);
    expect(isPublicPath("/extensions")).toBe(false);
    expect(isPublicPath("/extensions/x")).toBe(false);
    expect(isPublicPath("/extensionsx")).toBe(false);
  });

  it("البادئة في القائمة نفسها التي يشغّلها الوسيط — والأعضاء السبعة القدامى باقون", () => {
    expect(PROTECTED_PREFIXES).toContain("/extensions");
    for (const p of ["/chat", "/files", "/projects", "/settings", "/account", "/usage", "/admin"]) {
      expect(PROTECTED_PREFIXES, p).toContain(p);
    }
  });
});

describe("صفحتا الإضافات", () => {
  it("موجودتان تحت app/(app)/extensions — فهرسٌ وصفحة مهارة", () => {
    expect(existsSync(LIST_PAGE), LIST_PAGE).toBe(true);
    expect(existsSync(DETAIL_PAGE), DETAIL_PAGE).toBe(true);
  });

  it("كلتاهما تحمي بالتوجيه إلى /login وتقرأ السجلّ المدمج — ومكوّنا خادم لا عميل", () => {
    for (const p of [LIST_PAGE, DETAIL_PAGE]) {
      if (!existsSync(p)) continue; // الغياب يسقطه الاختبار السابق بوضوح؛ هنا يُقاس المحتوى
      const src = readSrc(p);
      expect(src, p).toMatch(/redirect\("\/login"\)/);
      expect(src, p).toMatch(/builtInSkillRegistry\(\)/);
      expect(src, p).not.toMatch(/^"use client"/m);
    }
  });

  it("صفحة المهارة تتحقّق من شكل المعرّف وتعود إلى الفهرس عند المجهول — لا 404 ولا رمي", () => {
    if (!existsSync(DETAIL_PAGE)) return;
    const src = readSrc(DETAIL_PAGE);
    expect(src).toMatch(/SKILL_ID_PATTERN\.test\(/);
    expect(src).toMatch(/redirect\("\/extensions"\)/);
  });
});

describe("البحث السريع يجد الإضافات", () => {
  it("التسمية في القاموس سطرٌ واحد: «الإضافات» / Extensions", () => {
    expect(readSrc("lib/i18n.tsx")).toMatch(/^  moduleExtensions: \{ ar: "الإضافات", en: "Extensions" \},$/m);
  });

  it("بلا همزة، وبجزءٍ من الكلمة، وبالهمزة كما كُتبت — وغيرها لا", () => {
    const ext = availableModules().find((m) => m.id === "extensions")!;
    const items: QuickSearchItem[] = [
      { kind: "page", id: "chat", label: "المحادثة", href: "/chat" },
      { kind: "page", id: ext.id, label: "الإضافات", href: ext.href },
      { kind: "conversation", id: "c1", label: "إضافة ميزة", href: "/chat/c1" },
    ];
    expect(normalizeForSearch("الإضافات")).toBe("الاضافات");
    for (const q of ["اضافات", "الإض", "الاضافات", "إضافات", "الإضافات"]) {
      const pages = searchItems(items, q).filter((i) => i.kind === "page");
      expect(pages.map((i) => i.href), q).toEqual(["/extensions"]);
    }
    expect(searchItems(items, "الأتمتة")).toEqual([]);
  });
});

describe("الهيكل", () => {
  const shell = readSrc("components/shell/app-shell.tsx");

  it("أيقونة Puzzle للإضافات في خريطة الأيقونات — مستوردة من lucide", () => {
    expect(shell).toContain("\n  extensions: Puzzle,\n");
    expect(shell).toMatch(/import \{[^}]*\bPuzzle\b[^}]*\} from "lucide-react"/);
  });

  it("بلا لوحة جانبية كالمكتبة — صفحة كاملة العرض", () => {
    expect(shell).toContain('id === "library" || id === "extensions"');
  });

  it("ولا رابطٌ مكتوب يدويًّا: التنقل من السجلّ وحده", () => {
    expect(shell).not.toMatch(/href="\/extensions/);
  });
});
