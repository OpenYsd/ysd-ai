import { describe, it, expect } from "vitest";
import {
  finalizeIncompleteText,
  endsInsideCodeFence,
  INCOMPLETE_NOTICE_TEXT,
  TRUNCATED_NOTICE,
} from "../lib/ai/language-guard";

/**
 * v0.7.0 RC8 — عقد الرد غير المكتمل.
 *
 * قبل هذا: المهلة بعد بثّ جزء كانت تحذف النص الذي شاهده المستخدم، وانقطاع
 * المزوّد بعد أول نص كان يُشغّل احتياطًا بنموذج آخر فيلتصق ردّان.
 */

const fences = (s: string) => (s.match(/```/g) ?? []).length;

describe("★ RC8: finalizeIncompleteText يُغلق السياج ويضيف التنبيه خارجه", () => {
  const PARTIAL = "**مثال**\n\n```python\nimport requests";

  it("★ يغلق السياج المفتوح فيصير العدد زوجيًا", () => {
    const out = finalizeIncompleteText(PARTIAL);
    expect(endsInsideCodeFence(out)).toBe(false);
    expect(fences(out) % 2).toBe(0);
  });

  it("★ التنبيه خارج كتلة الكود (بعد آخر سياج)", () => {
    const out = finalizeIncompleteText(PARTIAL);
    const noticeAt = out.indexOf(INCOMPLETE_NOTICE_TEXT);
    const lastFenceAt = out.lastIndexOf("```");
    expect(noticeAt).toBeGreaterThan(lastFenceAt);
    // وعدد الأسيجة قبل التنبيه زوجي ⇒ لسنا داخل كتلة
    expect(fences(out.slice(0, noticeAt)) % 2).toBe(0);
  });

  it("★ لا يخترع كودًا — النص الأصلي يبقى كما هو حرفيًا", () => {
    const out = finalizeIncompleteText(PARTIAL);
    expect(out.startsWith(PARTIAL)).toBe(true);
    expect(out).not.toMatch(/def |response|return/);
  });

  it("★ idempotent: استدعاؤه مرتين لا يكرّر السياج ولا التنبيه", () => {
    const once = finalizeIncompleteText(PARTIAL);
    const twice = finalizeIncompleteText(once);
    expect(twice).toBe(once);
    expect(fences(twice)).toBe(fences(once));
    expect(twice.split(INCOMPLETE_NOTICE_TEXT).length - 1).toBe(1);
  });

  it("★ نص بلا سياج: تنبيه فقط بلا إضافة أسيجة", () => {
    const out = finalizeIncompleteText("شرح عربي انقطع فجأة عند");
    expect(fences(out)).toBe(0);
    expect(out).toContain(INCOMPLETE_NOTICE_TEXT);
  });

  it("★ سياج مغلق مسبقًا لا يُغلق مرتين", () => {
    const closed = "**مثال**\n\n```py\nx = 1\n```";
    const out = finalizeIncompleteText(closed);
    expect(fences(out)).toBe(fences(closed));
    expect(out).toContain(INCOMPLETE_NOTICE_TEXT);
  });

  it("★ لا يضيف تنبيهًا ثانيًا إن حمل النص عبارة الجودة بالفعل", () => {
    const withQuality = `**مثال**\n\n\`\`\`py\nx = 1\n\`\`\`${TRUNCATED_NOTICE}`;
    const out = finalizeIncompleteText(withQuality);
    expect(out).not.toContain(INCOMPLETE_NOTICE_TEXT);
    expect(out.split(TRUNCATED_NOTICE.trim()).length - 1).toBe(1);
  });
});

describe("★ RC8: عقد مسار المهلة في route", () => {
  const ROUTE = readRoute();

  it("★ مهلة قبل أي نص: لا حفظ ولا completion", () => {
    // الرمي يبقى مشروطًا بغياب النص
    expect(ROUTE).toMatch(/if \(!assistantText\.trim\(\)\) \{\s*\n\s*throw new Error\("hard_limit_abort"\)/);
  });

  it("★ مهلة بعد نص: تُنهى بعقد آمن وتُعلَّم incomplete_timeout", () => {
    expect(ROUTE).toContain('completionStatus = "incomplete_timeout"');
    expect(ROUTE).toContain("finalizeIncompleteText(assistantText)");
  });

  it("★ الفارق المُرسَل يُبثّ فيبقى المحفوظ = المعروض", () => {
    expect(ROUTE).toMatch(/const added = finalized\.slice\(assistantText\.length\);/);
    expect(ROUTE).toMatch(/if \(added\) send\(\{ type: "text", text: added \}\)/);
    expect(ROUTE).toMatch(/assistantText = finalized;/);
  });

  it("★ حارس الرسالة الفارغة باقٍ", () => {
    expect(ROUTE).toContain("if (assistantText.trim())");
  });

  it("★ completion تُحفظ مع metadata الأخرى ولا تستبدل sources", () => {
    expect(ROUTE).toMatch(/meta\.sources = /);
    expect(ROUTE).toMatch(/meta\.completion = \{/);
    expect(ROUTE).toMatch(/if \(Object\.keys\(meta\)\.length > 0\) insertRow\.metadata = meta;/);
  });
});

describe("★ RC8: عقد انقطاع المزوّد بعد أول نص", () => {
  const OR = readOpenRouter();

  it("★ network_error يُعيد ما عُرض بدل إسقاطه", () => {
    /**
     * الحقول هي الشرط لا شكل السطر: `timedOut` أُضيف في v0.9.0 لتمييز مهلتنا
     * عن عطل الشبكة، فتعدّد السطر ولم يتغيّر ما يُعاد للمستخدم.
     */
    expect(OR).toMatch(/return \{\s*status: "network_error",\s*emitted,\s*model: actualModel,/);
  });

  it("★ لا احتياط بعد أن شاهد المستخدم نصًّا", () => {
    expect(OR).toMatch(
      /if \(result\.status === "network_error" && \(result\.emitted \?\? ""\)\.trim\(\)\) \{/,
    );
    // القرار يسبق سطر بناء lastError (أي قبل مسار الاحتياط)
    const guardAt = OR.indexOf('result.status === "network_error" && (result.emitted');
    const fallbackAt = OR.indexOf("// فشل تقني (429/5xx/شبكة)");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(fallbackAt);
  });

  it("★ يُعلَّم incomplete_provider بسبب آمن", () => {
    expect(OR).toContain('completion: "incomplete_provider"');
    expect(OR).toContain('completionReason: "stream_interrupted"');
  });

  it("★ السجل أرقام ومعرّف نموذج فقط — بلا محتوى", () => {
    expect(OR).toMatch(/provider_interrupted_after_flush model=\$\{[^}]+\} text_char_count=/);
  });

  it("★ إجهاض العميل يبقى منفصلًا ولا يُصنَّف مهلة أو مزوّدًا", () => {
    expect(OR).toMatch(/if \(req\.signal\?\.aborted\) return \{ status: "aborted" \};/);
  });
});

function readRoute(): string {
  return require("node:fs").readFileSync("app/api/chat/route.ts", "utf8");
}
function readOpenRouter(): string {
  return require("node:fs").readFileSync("lib/ai/openrouter.ts", "utf8");
}
