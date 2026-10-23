/**
 * حدود وحدات المنصّة — lib/platform/modules.ts.
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 * أن يكون التنقل صادقًا: كل وحدة «متاحة» لها صفحة موجودة فعلًا، وكل وحدة «مخطَّطة»
 * بلا رابط ولا تظهر في شريط الأيقونات ولا في البحث السريع. فلا زرّ يوهم بوظيفةٍ لم تُبنَ.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  PLATFORM_MODULES,
  activeModuleId,
  availableModules,
  railModules,
  type PlatformModuleId,
} from "@/lib/platform/modules";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ALL: PlatformModuleId[] = ["chat", "projects", "code", "library", "extensions", "automations", "models", "settings"];

describe("سجلّ الوحدات", () => {
  it("الوحدات الثماني مسجّلة مرّة واحدة لكلٍّ منها", () => {
    expect(PLATFORM_MODULES.map((m) => m.id).sort()).toEqual([...ALL].sort());
  });

  it("كل وحدة متاحة لها صفحة موجودة في app/(app)، وكل مخطَّطة بلا رابط ولا مسارات", () => {
    for (const m of PLATFORM_MODULES) {
      if (m.status === "available") {
        expect(m.href, m.id).toMatch(/^\/[a-z]+$/);
        expect(existsSync(`app/(app)${m.href}/page.tsx`), `${m.id} → ${m.href}`).toBe(true);
        expect(m.routes, m.id).toContain(m.href);
      } else {
        expect(m.href, m.id).toBeNull();
        expect(m.routes, m.id).toEqual([]);
      }
    }
  });

  it("المخطَّط اليوم: الشيفرة والإضافات والأتمتة وصفحة النماذج — لا تُعرض", () => {
    const planned = PLATFORM_MODULES.filter((m) => m.status === "planned").map((m) => m.id).sort();
    expect(planned).toEqual(["automations", "code", "extensions", "models"]);
    const shown = [...railModules("primary"), ...railModules("secondary"), ...availableModules()].map((m) => m.id);
    for (const id of planned) expect(shown, id).not.toContain(id);
  });

  it("شريط الأيقونات: المحادثة والمشاريع والمكتبة أعلاه، والإعدادات أسفله", () => {
    expect(railModules("primary").map((m) => m.id)).toEqual(["chat", "projects", "library"]);
    expect(railModules("secondary").map((m) => m.id)).toEqual(["settings"]);
  });

  it("الوحدة النشطة من المسار — والمسار المشابه لا يُحسب", () => {
    expect(activeModuleId("/chat")).toBe("chat");
    expect(activeModuleId("/chat/3f2a")).toBe("chat");
    expect(activeModuleId("/projects")).toBe("projects");
    expect(activeModuleId("/projects/abc")).toBe("projects");
    expect(activeModuleId("/files")).toBe("library");
    expect(activeModuleId("/settings")).toBe("settings");
    expect(activeModuleId("/account")).toBeNull();
    expect(activeModuleId("/chatter")).toBeNull();
    expect(activeModuleId("/")).toBeNull();
  });

  it("المشاريع تُسمّى مشاريع: لا «العمل» ولا «Work» قبل أن يوجد مساعدٌ ينفّذ مهامّ", () => {
    const projects = PLATFORM_MODULES.find((m) => m.href === "/projects");
    expect(projects?.id).toBe("projects");
    expect(projects?.labelKey).toBe("moduleProjects");
    const i18n = readSrc("lib/i18n.tsx");
    expect(i18n).toMatch(/^  moduleProjects: { ar: "المشاريع", en: "Projects" },$/m);
    expect(i18n).not.toMatch(/moduleWork/);
  });

  it("لكل اسم وحدة نصّ عربي وإنجليزي قصير في القاموس", () => {
    const i18n = readSrc("lib/i18n.tsx");
    for (const m of PLATFORM_MODULES) {
      const line = new RegExp(`^  ${m.labelKey}: \\{ ar: "([^"]{1,12})", en: "([^"]{1,14})" \\},$`, "m");
      expect(i18n, m.labelKey).toMatch(line);
    }
  });

  it("الهيكل يبني التنقل من السجلّ، ولكل وحدة متاحة أيقونة", () => {
    const shell = readSrc("components/shell/app-shell.tsx");
    expect(shell).toMatch(/railModules\("primary"\)/);
    expect(shell).toMatch(/railModules\("secondary"\)/);
    for (const m of availableModules()) {
      expect(shell, m.id).toMatch(new RegExp(`\\n  ${m.id}: [A-Z][A-Za-z]+,`));
    }
    // لا روابط مكتوبة يدويًّا لوحدات مخطَّطة
    expect(shell).not.toMatch(/href="\/(code|extensions|automations|models)\b/);
  });
});
