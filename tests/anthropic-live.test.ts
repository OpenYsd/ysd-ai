/**
 * اختبار حي لموفر Anthropic — لا يعمل إلا عند YSD_LIVE=1
 * يتحقق أن المفتاح يُقرأ من البيئة (دون طباعته) وأن أخطاء الموفر
 * تصل كرسائل عربية واضحة عبر الطبقة الموحدة.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const live = process.env.YSD_LIVE === "1";

describe.runIf(live)("AnthropicProvider (live)", () => {
  beforeAll(() => {
    // تحميل .env.local يدويًا (vitest لا يحمّله تلقائيًا)
    const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2]?.trim() ?? "";
    }
  });

  it("يقرأ المفتاح من البيئة دون كشفه", async () => {
    const { AnthropicProvider } = await import("../lib/ai/anthropic");
    const provider = new AnthropicProvider();
    expect(provider.isConfigured()).toBe(true);
  });

  it("يعيد رسالة عربية واضحة عند فشل الطلب (مثل نفاد الرصيد)", async () => {
    const { AnthropicProvider } = await import("../lib/ai/anthropic");
    const provider = new AnthropicProvider();
    const chunks: { type: string; error?: string; text?: string }[] = [];

    for await (const chunk of provider.streamChat({
      modelId: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "قل مرحبًا فقط." }],
      maxTokens: 16,
    })) {
      chunks.push({ type: chunk.type, error: chunk.error, text: chunk.text });
    }

    const last = chunks[chunks.length - 1];
    expect(last).toBeDefined();
    // إمّا نجاح حقيقي (رصيد متوفر) أو خطأ برسالة عربية — لا انهيار ولا رسالة إنجليزية خام
    if (last?.type === "error") {
      expect(last.error).toBeTruthy();
      // رسالة عربية: تحتوي حروفًا عربية ولا تحتوي تفاصيل تقنية خام
      expect(last.error).toMatch(/[؀-ۿ]/);
      expect(last.error).not.toMatch(/api[_-]?key|sk-ant|bearer/i);
      console.log("[live] error kind surfaced to user:", last.error);
    } else {
      expect(last?.type).toBe("done");
      console.log("[live] streaming succeeded — credit available");
    }
  }, 30_000);
});

describe.runIf(!live)("AnthropicProvider (live) — skipped", () => {
  it("يتخطى الاختبار الحي بدون YSD_LIVE=1", () => {
    expect(true).toBe(true);
  });
});
