/**
 * المرحلة 3D — نطاق مسودة المحادثة الجديدة، ومفتاحها، وحدود الشيفرة، والخروج.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - النطاق يُشتقّ على الخادم من هويّة المستخدم: حتميّ، مختلفٌ بين الحسابات، ولا يحمل المعرّف،
 *     ولا يساوي نطاق المفضّلة للمعرّف نفسه.
 *   - لا مفتاح محادثةٍ جديدة بلا نطاقٍ صالح، ولا يُبنى المفتاح القديم المشترك `ysd-draft:new` أبدًا.
 *   - مفتاح المحادثة القائمة كما كان، فلا تضيع مسودةٌ محفوظة.
 *   - الشريط لا يمسّ من التخزين إلا مفتاحه: لا مسح، ولا تعداد، ولا سلسلةٌ مكتوبة يدويًّا.
 *   - الخروج لا يحذف مسودات أحد: لا مسح من الخادم ولا من الواجهة.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signOut: async () => ({ error: null }) } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => ["sb-abcdefgh-auth-token", "theme"].map((name) => ({ name, value: "x" })),
  }),
}));

import { chatDraftScopeFor } from "@/lib/chat/draft-scope";
import { CHAT_DRAFT_KEY_PREFIX, chatDraftStorageKey } from "@/lib/chat/draft-key";
import { favoritesScopeFor } from "@/lib/skills/favorites-scope";

const { POST } = await import("../app/auth/signout/route");

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const LEGACY = "ysd-draft:new";

describe("النطاق لكل مستخدم", () => {
  it("حتميّ وبشكلٍ ثابت، ومختلفٌ بين الحسابات، ولا يحمل المعرّف", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(chatDraftScopeFor(a)).toBe(chatDraftScopeFor(a));
    expect(chatDraftScopeFor(a)).toMatch(/^[a-f0-9]{32}$/);
    expect(chatDraftScopeFor(a)).not.toBe(chatDraftScopeFor(b));
    expect(chatDraftScopeFor(a)).not.toContain(a.replace(/-/g, "").slice(0, 12));
  });

  it("بصمةٌ غير بصمة المفضّلة للمعرّف نفسه", () => {
    const a = randomUUID();
    expect(chatDraftScopeFor(a)).not.toBe(favoritesScopeFor(a));
  });

  it("على الخادم وحده", () => {
    expect(read("lib/chat/draft-scope.ts").split("\n")[0]).toBe('import "server-only";');
  });
});

describe("مفتاح المسودة", () => {
  const scope = chatDraftScopeFor(randomUUID());
  const conv = randomUUID();

  it("محادثةٌ جديدة بنطاقٍ صالح ⇒ مفتاحٌ بنطاقها", () => {
    expect(chatDraftStorageKey(scope, null)).toBe(`ysd-draft:${scope}:new`);
    expect(CHAT_DRAFT_KEY_PREFIX).toBe("ysd-draft:");
  });

  it("محادثةٌ قائمة ⇒ مفتاحها كما كان، بالنطاق أو بدونه", () => {
    for (const s of [scope, null, undefined]) expect(chatDraftStorageKey(s, conv)).toBe(`ysd-draft:${conv}`);
  });

  it("معرّف محادثةٍ ليس UUID ⇒ لا مفتاح (فلا يُبنى منه مفتاحٌ آخر)", () => {
    for (const bad of ["new", `${scope}:new`, "conv-1", `${conv}:x`, `../${conv}`]) {
      expect(chatDraftStorageKey(scope, bad), bad).toBeNull();
    }
  });

  it("محادثةٌ جديدة بلا نطاقٍ صالح ⇒ لا مفتاح", () => {
    for (const bad of [undefined, null, "", "new", "global", randomUUID(), "A".repeat(32), "a".repeat(31), `${scope}:x`, ` ${scope}`]) {
      expect(chatDraftStorageKey(bad, null), String(bad)).toBeNull();
    }
  });

  it("المفتاح القديم المشترك لا يُبنى من أيّ مدخل", () => {
    for (const s of [undefined, null, "", "new", scope, "a".repeat(32)]) {
      for (const c of [null, "", "new"]) expect(chatDraftStorageKey(s, c), `${String(s)}|${String(c)}`).not.toBe(LEGACY);
    }
  });
});

describe("حدود الشيفرة", () => {
  it("المفتاح صافٍ: لا استيراد ولا متصفح ولا شبكة ولا بيئة", () => {
    const code = stripComments(read("lib/chat/draft-key.ts"));
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/\bwindow\b|localStorage|\bfetch\(|process\.env/);
  });

  it("الشريط: كل وصولٍ إلى التخزين بمفتاحه، ولا مسح ولا تعداد ولا مفتاحٌ مكتوب يدويًّا", () => {
    const code = stripComments(read("components/chat/chat-view.tsx"));
    expect(code).toMatch(/const draftKey = chatDraftStorageKey\(draftScope, conversationId\);/);
    expect(code).not.toMatch(/ysd-draft/);
    expect(code).not.toMatch(/localStorage\.(clear|key)\(|localStorage\.length|Object\.(keys|entries)\(\s*window\.localStorage/);
    expect(code).not.toMatch(/sessionStorage/);
    const drafts = code.match(/localStorage\.(getItem|setItem|removeItem)\(([^,)]+)/g) ?? [];
    // رمز المحرّك المحلّي قراءةٌ لمفتاحه الثابت — وكل ما سواه للمسودة بمفتاحها
    const others = drafts.filter((d) => !/\(draftKey$/.test(d) && d !== 'localStorage.getItem("ysd.localEngineToken"');
    expect(others).toEqual([]);
    expect(drafts.filter((d) => /\(draftKey$/.test(d))).toHaveLength(3);
  });

  it("الشريط يُعاد تركيبه بنطاق الحساب، ولا حفظ قبل الاسترجاع", () => {
    const code = stripComments(read("components/chat/chat-view.tsx"));
    expect(code).toMatch(/<ChatViewBody key=\{`\$\{props\.draftScope \?\? ""\}:\$\{props\.conversationId \?\? "new"\}`\} \{\.\.\.props\} \/>/);
    expect(code).toMatch(/if \(!draftKey \|\| !draftRestored\) return;/);
  });

  it("الصفحتان تشتقّان النطاق من الهويّة الموثَّقة بعد التحقّق من الجلسة", () => {
    for (const file of ["app/(app)/chat/page.tsx", "app/(app)/chat/[id]/page.tsx"]) {
      const src = stripComments(read(file));
      expect(src, file).toMatch(/draftScope=\{chatDraftScopeFor\(ctx\.userId\)\}/);
      expect(src.indexOf('redirect("/login")'), file).toBeGreaterThan(0);
      expect(src.indexOf('redirect("/login")'), file).toBeLessThan(src.indexOf("chatDraftScopeFor(ctx.userId)"));
    }
  });
});

describe("الخروج لا يحذف مسودات أحد", () => {
  it("مسار الخروج: لا مسح للتخزين من الخادم", async () => {
    const res = await POST();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("clear-site-data")).toBeNull();
    const code = stripComments(read("app/auth/signout/route.ts"));
    expect(code).not.toMatch(/Clear-Site-Data|localStorage|sessionStorage|ysd-draft/i);
  });

  it("نموذج الخروج في الهيكل كما كان: POST بلا معالجٍ يمسح التخزين في الواجهة", () => {
    const shell = stripComments(read("components/shell/app-shell.tsx"));
    expect(shell).toContain('<form action="/auth/signout" method="post">');
    expect(shell).not.toMatch(/ysd-draft|localStorage\.(clear|removeItem)\(/);
  });
});
