/**
 * الأتمتة في التنقل والمسارات — وحدةٌ متاحة بصفحةٍ فعلية (المرحلة 4A).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - السجلّ: `automations` متاحة على `/automations` في الشريط الأعلى بعد الإضافات، والمسار المشابه لا يُنسب إليها.
 *   - سياسة المسارات: `/automations` وفروعها محميّة، وليست عامّة، والقوائم القديمة لم تفقد عضوًا.
 *   - الصفحة: مكوّن خادم يحمي بالتوجيه إلى `/login` قبل اشتقاق النطاق من الهويّة الموثَّقة، ويمرّر من
 *     المهارات المعرّف والاسم والصلاحيات وحدها — لا تعليماتٍ ولا استعلامًا.
 *   - الهيكل: أيقونةٌ من السجلّ، وبلا لوحة جانبية، ولا رابطٌ مكتوب يدويًّا.
 *   - التوثيق يقول ما يعمل وما لا يعمل.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PLATFORM_MODULES, activeModuleId, availableModules, railModules } from "@/lib/platform/modules";
import { PROTECTED_PREFIXES, isProtectedPath, isPublicPath } from "@/lib/route-policy";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const PAGE = "app/(app)/automations/page.tsx";

describe("سجلّ الوحدات: الأتمتة متاحة", () => {
  it("متاحة على /automations بمسارٍ واحد تملكه، في الشريط الأعلى بعد الإضافات", () => {
    expect(PLATFORM_MODULES.find((m) => m.id === "automations")).toMatchObject({
      status: "available",
      href: "/automations",
      routes: ["/automations"],
      placement: "primary",
      labelKey: "moduleAutomations",
    });
    expect(railModules("primary").map((m) => m.id)).toEqual(["chat", "projects", "library", "extensions", "automations"]);
    expect(availableModules().find((m) => m.id === "automations")?.href).toBe("/automations");
  });

  it("الوحدة النشطة: /automations وفروعها — والمسار المشابه لا", () => {
    expect(activeModuleId("/automations")).toBe("automations");
    expect(activeModuleId("/automations/x")).toBe("automations");
    expect(activeModuleId("/automationsx")).toBeNull();
    expect(activeModuleId("/automation")).toBeNull();
  });

  it("الشيفرة وصفحة النماذج باقيتان مخطَّطتين — لا وحدة تُفتح بغير صفحتها", () => {
    expect(PLATFORM_MODULES.filter((m) => m.status === "planned").map((m) => m.id).sort()).toEqual(["code", "models"]);
  });
});

describe("سياسة المسارات: الأتمتة محميّة", () => {
  it("/automations وفروعها محميّة بحدّ مقطع، وليست عامّة", () => {
    expect(isProtectedPath("/automations")).toBe(true);
    expect(isProtectedPath("/automations/new")).toBe(true);
    expect(isProtectedPath("/automationsx")).toBe(false);
    expect(isPublicPath("/automations")).toBe(false);
    expect(isPublicPath("/automations/new")).toBe(false);
  });

  it("البادئة في القائمة نفسها التي يشغّلها الوسيط — والأعضاء القدامى باقون", () => {
    expect(PROTECTED_PREFIXES).toContain("/automations");
    for (const p of ["/chat", "/files", "/projects", "/settings", "/account", "/usage", "/admin", "/extensions"]) {
      expect(PROTECTED_PREFIXES, p).toContain(p);
    }
  });
});

describe("صفحة الأتمتة", () => {
  it("مكوّن خادم يحمي بـ/login قبل أي اشتقاق، والنطاق من ctx.userId", () => {
    expect(existsSync(PAGE)).toBe(true);
    const src = stripComments(read(PAGE));
    expect(src).not.toMatch(/^"use client"/m);
    expect(src).toMatch(/redirect\("\/login"\)/);
    expect(src).toMatch(/draftsScope=\{automationDraftsScopeFor\(ctx\.userId\)\}/);
    expect(src.indexOf('redirect("/login")')).toBeLessThan(src.indexOf("automationDraftsScopeFor(ctx.userId)"));
  });

  it("من المهارات: المعرّف والاسم والصلاحيات وحدها — لا تعليمات ولا استعلام ولا جدول", () => {
    const src = stripComments(read(PAGE));
    expect(src).toMatch(/\.map\(\(s\) => \(\{ id: s\.id, name: s\.name, capabilities: s\.capabilities \}\)\)/);
    expect(src).not.toMatch(/instructions|\.from\(|\.rpc\(|\bfetch\(/);
  });
});

describe("الهيكل والتوثيق", () => {
  it("أيقونة الأتمتة من السجلّ، وبلا لوحة جانبية، ولا رابطٌ مكتوب يدويًّا", () => {
    const shell = read("components/shell/app-shell.tsx");
    expect(shell).toMatch(/\n  automations: Workflow,/);
    expect(shell).toMatch(/id === "automations"\) return null;/);
    expect(shell).not.toMatch(/href="\/automations/);
  });

  it("التوثيق: الوحدة متاحة، والمسودات لا تُنفَّذ، والمؤجَّل مسمّى", () => {
    const modules = read("docs/architecture/platform-modules.md");
    expect(modules).toMatch(/\| Automations \| متاحة/);
    const doc = read("docs/architecture/automations.md");
    for (const s of ["AUTOMATION_BOUNDARIES", "ysd.automationDrafts.v1:", "لا تشغيل", "المؤجَّل"]) expect(doc, s).toContain(s);
  });
});
