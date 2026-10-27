/**
 * المرحلة 3B — المهارة في المحادثة: حلّ المعرّف على الخادم، ورابط المهارة، ودمج المسودة.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - الرابط يحمل المعرّف وحده؛ والخادم لا يقبل إلا مهارةً مدمجة تعمل كلّها في مسارٍ نصّي.
 *   - المعرّف المشوَّه أو المكرّر أو المجهول لا يُحقن منه شيء، ولا يُعاد المعامل الخام إلى العميل.
 *   - المهارة المعتمدة على صلاحيةٍ معطّلة تُرفض باسم سببها — ولا منح يغيّر ذلك (لا مدخل للمنح هنا).
 *   - الدمج لا يمسّ ما كتبه المستخدم إلا بالاختيار الصريح.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mergeSkillDraft, skillChatHref, SKILL_CHAT_PARAM } from "@/lib/skills/chat-draft";
import { resolveSkillChatRequest } from "@/lib/skills/chat-request";
import { evaluateSkill } from "@/lib/skills/permissions";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const SKILLS = builtInSkillRegistry().list();
const EXECUTABLE = SKILLS.filter((s) => evaluateSkill(s).executable);
const UNSUPPORTED = SKILLS.filter((s) => !evaluateSkill(s).executable);

describe("رابط المهارة", () => {
  it("المعرّف وحده في الرابط، مُرمَّزًا", () => {
    expect(SKILL_CHAT_PARAM).toBe("skill");
    expect(skillChatHref("arabic-proofreader")).toBe("/chat?skill=arabic-proofreader");
    expect(skillChatHref("a&b=c d")).toBe("/chat?skill=a%26b%3Dc%20d");
    for (const s of SKILLS) expect(skillChatHref(s.id), s.id).not.toContain(s.instructions.ar.slice(0, 10));
  });
});

describe("حلّ المعامل على الخادم", () => {
  it("بلا معامل ⇒ null: صفحة المحادثة كما كانت", () => {
    expect(resolveSkillChatRequest(undefined)).toBeNull();
  });

  it("كل مهارةٍ تصريحية مدمجة ⇒ اسمها وتعليماتها باللغتين من السجلّ نفسه", () => {
    expect(EXECUTABLE.map((s) => s.id)).toEqual([
      "arabic-proofreader",
      "summarize-text",
      "translate-ar-en",
      "meeting-notes-actions",
      "explain-code",
      "study-questions",
    ]);
    for (const s of EXECUTABLE) {
      expect(resolveSkillChatRequest(s.id), s.id).toEqual({ ok: true, id: s.id, name: s.name, instructions: s.instructions });
    }
  });

  it("المهارة المعتمدة على صلاحيةٍ معطّلة ⇒ unsupported، بلا نصّ", () => {
    expect(UNSUPPORTED.map((s) => s.id).sort()).toEqual(["document-qa", "web-research-brief"]);
    for (const s of UNSUPPORTED) {
      const r = resolveSkillChatRequest(s.id);
      expect(r, s.id).toEqual({ ok: false, reason: "unsupported" });
      expect(Object.keys(r ?? {}).sort(), s.id).toEqual(["ok", "reason"]);
    }
  });

  it("المجهول والمشوَّه والمكرّر ⇒ unknown — والمعامل الخام لا يعود إلى العميل", () => {
    const bad: (string | string[])[] = [
      "",
      "no-such-skill",
      "Arabic-Proofreader",
      "arabic_proofreader",
      "arabic-proofreader ",
      "../etc/passwd",
      "arabic-proofreader/../x",
      "<script>alert(1)</script>",
      "arabic-proofreader?x=1",
      "a".repeat(49),
      ["arabic-proofreader", "summarize-text"],
      [],
    ];
    for (const raw of bad) {
      const r = resolveSkillChatRequest(raw);
      expect(r, JSON.stringify(raw)).toEqual({ ok: false, reason: "unknown" });
      expect(JSON.stringify(r), JSON.stringify(raw)).not.toContain("script");
    }
  });
});

describe("دمج المسودة", () => {
  const INS = "تعليمات";
  it("الاستبدال يأخذ التعليمات وحدها", () => {
    expect(mergeSkillDraft("مسودتي", INS, "replace")).toBe(INS);
  });
  it("الإضافة بعد المسودة بسطرٍ فارغ، ولا تمسّ ما كُتب إلا فراغ آخره", () => {
    expect(mergeSkillDraft("مسودتي", INS, "append")).toBe(`مسودتي\n\n${INS}`);
    expect(mergeSkillDraft("مسودتي  \n\n", INS, "append")).toBe(`مسودتي\n\n${INS}`);
    expect(mergeSkillDraft("  أولًا\nثانيًا", INS, "append")).toBe(`  أولًا\nثانيًا\n\n${INS}`);
  });
  it("المسودة الفارغة أو الفراغ وحده ⇒ التعليمات كما هي في الحالين", () => {
    for (const mode of ["replace", "append"] as const) {
      expect(mergeSkillDraft("", INS, mode), mode).toBe(INS);
      expect(mergeSkillDraft(" \n ", INS, mode), mode).toBe(INS);
    }
  });
});

describe("حدود الشيفرة", () => {
  it("المحلِّل على الخادم وحده، والعقد الذي يستورده الشريط بلا سجلّ ولا zod", () => {
    expect(read("lib/skills/chat-request.ts").split("\n")[0]).toBe('import "server-only";');
    const draft = stripComments(read("lib/skills/chat-draft.ts"));
    // استيراداتٌ نوعيّة فقط — فلا يحمل شريط المحادثة الفهرسَ ولا المخطّط إلى حزمته
    for (const line of draft.split("\n").filter((l) => /^import /.test(l))) expect(line).toMatch(/^import type /);
    for (const f of ["lib/skills/chat-draft.ts", "lib/skills/chat-request.ts", "components/chat/skill-draft-notice.tsx"]) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/\bfetch\(|process\.env|dangerouslySetInnerHTML|eval\(|new Function/);
    }
  });

  it("المحادثة الجديدة وحدها تحلّ المعامل؛ والمحادثة القائمة لا تعرفه", () => {
    const page = stripComments(read("app/(app)/chat/page.tsx"));
    expect(page).toMatch(/resolveSkillChatRequest\(\(await searchParams\)\[SKILL_CHAT_PARAM\]\)/);
    expect(page).toMatch(/skillRequest=\{skillRequest\}/);
    expect(read("app/(app)/chat/[id]/page.tsx")).not.toMatch(/skill/i);
  });

  it("الشريط لا يرسل ولا يُنشئ محادثةً من المهارة: لا send ولا ensureConversation في مسارها", () => {
    const view = read("components/chat/chat-view.tsx");
    const start = view.indexOf("const [skillNotice, setSkillNotice]");
    const end = view.indexOf("const skillDraftNotice =");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = stripComments(view.slice(start, end));
    expect(block).not.toMatch(/\bsend\(|ensureConversation|fetch\(|setMessages|system/);
  });
});
