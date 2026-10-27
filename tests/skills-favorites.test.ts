/**
 * المرحلة 3C — مفضّلة المهارات: النطاق لكل مستخدم، ومفتاح التخزين، والقراءة الآمنة لما فيه.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - النطاق يُشتقّ على الخادم من هويّة المستخدم: حتميّ، مختلفٌ بين الحسابات، ولا يحمل المعرّف.
 *   - لا مفتاح بلا نطاقٍ صالح — فلا مفضّلة عامّة يتشاركها حسابان على متصفحٍ واحد.
 *   - التالف والقديم والمعدَّل يدويًّا يُقرأ فارغًا؛ والمجهول والمشوَّه والمكرّر يُتجاهل.
 *   - لا يُحفظ إلا معرّفات — وحدود الشيفرة: لا شبكة ولا بيئة، والتخزين داخل try.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  FAVORITES_KEY_PREFIX,
  FAVORITES_STORAGE_VERSION,
  favoritesStorageKey,
  parseFavorites,
  serializeFavorites,
  toggleFavorite,
} from "@/lib/skills/favorites";
import { favoritesScopeFor } from "@/lib/skills/favorites-scope";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const IDS = builtInSkillRegistry().list().map((s) => s.id);
const KNOWN = new Set(IDS);
const raw = (ids: unknown, v: unknown = 1) => JSON.stringify({ v, ids });

describe("النطاق لكل مستخدم", () => {
  it("حتميّ وبشكلٍ ثابت، ومختلفٌ بين الحسابات، ولا يحمل المعرّف", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(favoritesScopeFor(a)).toBe(favoritesScopeFor(a));
    expect(favoritesScopeFor(a)).toMatch(/^[a-f0-9]{32}$/);
    expect(favoritesScopeFor(a)).not.toBe(favoritesScopeFor(b));
    expect(favoritesScopeFor(a)).not.toContain(a.replace(/-/g, "").slice(0, 12));
  });

  it("على الخادم وحده", () => {
    expect(read("lib/skills/favorites-scope.ts").split("\n")[0]).toBe('import "server-only";');
  });
});

describe("مفتاح التخزين", () => {
  it("نطاقٌ صالح ⇒ مفتاحٌ بإصداره ونطاقه", () => {
    const scope = favoritesScopeFor(randomUUID());
    expect(favoritesStorageKey(scope)).toBe(`${FAVORITES_KEY_PREFIX}${scope}`);
    expect(FAVORITES_KEY_PREFIX).toBe("ysd.skillFavorites.v1:");
  });

  it("لا نطاق أو نطاقٌ مشوَّه ⇒ لا مفتاح (لا مفضّلة عامّة مشتركة)", () => {
    for (const bad of [undefined, null, "", "global", randomUUID(), "A".repeat(32), "a".repeat(31), `${"a".repeat(32)}:x`]) {
      expect(favoritesStorageKey(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe("قراءة ما في التخزين", () => {
  it("الفارغ والتالف والشكل الخاطئ والإصدار الآخر ⇒ قائمةٌ فارغة", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "garbage",
      "{",
      "null",
      "[]",
      '["arabic-proofreader"]',
      '{"ids":["arabic-proofreader"]}',
      raw(["arabic-proofreader"], 2),
      raw(["arabic-proofreader"], "1"),
      raw("arabic-proofreader"),
      raw({ 0: "arabic-proofreader" }),
    ]) {
      expect(parseFavorites(bad, KNOWN), String(bad)).toEqual([]);
    }
  });

  it("يبقى المعروف الصالح وحده، بترتيبه، بلا تكرار", () => {
    const stored = raw([
      "removed-skill",
      "explain-code",
      "../etc/passwd",
      "ARABIC-PROOFREADER",
      "arabic-proofreader",
      7,
      null,
      { id: "summarize-text" },
      "explain-code",
      "__proto__",
      "constructor",
    ]);
    expect(parseFavorites(stored, KNOWN)).toEqual(["explain-code", "arabic-proofreader"]);
  });

  it("لا يتجاوز عدد المهارات المعروفة مهما كبرت القائمة المحفوظة", () => {
    const huge = raw([...Array.from({ length: 5000 }, (_, i) => `x-${i}`), ...IDS, ...IDS]);
    expect(parseFavorites(huge, KNOWN)).toEqual(IDS);
  });

  it("الكتابة تُخرج الشكل الصحيح، والقراءة تعيده كما هو", () => {
    const ids = ["study-questions", "arabic-proofreader"];
    const text = serializeFavorites(ids);
    expect(JSON.parse(text)).toEqual({ v: FAVORITES_STORAGE_VERSION, ids });
    expect(parseFavorites(text, KNOWN)).toEqual(ids);
  });

  it("التبديل يضيف في الآخر ويزيل بلا مساس بالبقيّة", () => {
    expect(toggleFavorite([], "explain-code")).toEqual(["explain-code"]);
    expect(toggleFavorite(["explain-code"], "arabic-proofreader")).toEqual(["explain-code", "arabic-proofreader"]);
    expect(toggleFavorite(["explain-code", "arabic-proofreader"], "explain-code")).toEqual(["arabic-proofreader"]);
  });
});

describe("حدود الشيفرة", () => {
  it("التنسيق صافٍ: لا متصفح ولا شبكة ولا بيئة", () => {
    const code = stripComments(read("lib/skills/favorites.ts"));
    expect(code).not.toMatch(/\bwindow\b|localStorage|\bfetch\(|process\.env/);
  });

  it("الخطّاف: التخزين داخل try، ولا شبكة، ولا مفتاحٌ مكتوب يدويًّا", () => {
    const code = stripComments(read("components/extensions/use-skill-favorites.ts"));
    expect(code).not.toMatch(/\bfetch\(|process\.env|sessionStorage/);
    // كل مفتاح من favoritesStorageKey — لا سلسلةٌ حرفية تُكتب في التخزين
    expect(code).not.toMatch(/localStorage\.(get|set|remove)Item\(\s*["'`]/);
    const accesses = code.match(/localStorage\.(getItem|setItem)\(/g) ?? [];
    expect(accesses.length).toBeGreaterThan(0);
    // كل وصولٍ داخل كتلة try
    for (const fn of ["readRaw", "writeRaw"]) {
      const body = code.slice(code.indexOf(`function ${fn}`), code.indexOf("\n}\n", code.indexOf(`function ${fn}`)));
      expect(body, fn).toMatch(/try \{[\s\S]*localStorage/);
    }
  });

  it("الصفحتان تشتقّان النطاق من الهويّة الموثَّقة، وصفحة المهارة تمرّر الفهرس كلّه", () => {
    const index = stripComments(read("app/(app)/extensions/page.tsx"));
    const detail = stripComments(read("app/(app)/extensions/[id]/page.tsx"));
    for (const [name, src] of [["index", index], ["detail", detail]] as const) {
      expect(src, name).toMatch(/favoritesScope=\{favoritesScopeFor\(ctx\.userId\)\}/);
      // الهويّة قبل النطاق: لا نطاق قبل التحقّق من الجلسة
      expect(src.indexOf('redirect("/login")'), name).toBeLessThan(src.indexOf("favoritesScopeFor(ctx.userId)"));
    }
    expect(detail).toMatch(/catalogIds=\{registry\.list\(\)\.map\(\(s\) => s\.id\)\}/);
  });
});
