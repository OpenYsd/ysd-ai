/**
 * اختبار حي لموفر OpenRouter — لا يعمل إلا عند YSD_LIVE=1 مع وجود المفتاح.
 * يتحقق من قراءة المفتاح دون كشفه، وأن البث الحقيقي يعمل عبر openrouter/free،
 * أو أن الخطأ يصل برسالة عربية واضحة دون أي تسريب.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

const live = process.env.YSD_LIVE === "1";

describe.runIf(live)("OpenRouterProvider (live)", () => {
  beforeAll(() => {
    const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2]?.trim() ?? "";
    }
  });

  it("يقرأ المفتاح من البيئة دون كشفه", async () => {
    const { OpenRouterProvider } = await import("../lib/ai/openrouter");
    const provider = new OpenRouterProvider();
    expect(provider.isConfigured()).toBe(true);
  });

  it("بث حقيقي عبر openrouter/free أو خطأ عربي واضح", async () => {
    const { OpenRouterProvider } = await import("../lib/ai/openrouter");
    const provider = new OpenRouterProvider();
    const chunks: { type: string; error?: string; text?: string }[] = [];

    for await (const chunk of provider.streamChat({
      modelId: "openrouter/free",
      messages: [{ role: "user", content: "قل «مرحبا» فقط، كلمة واحدة." }],
      maxTokens: 32,
    })) {
      chunks.push({ type: chunk.type, error: chunk.error, text: chunk.text });
    }

    const full = chunks
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const errEvent = chunks.find((c) => c.type === "error");
    const last = chunks[chunks.length - 1];

    if (errEvent) {
      // خطأ مقبول (ضغط النماذج المجانية مثلًا) لكن يجب أن يكون عربيًا وبلا أسرار
      expect(errEvent.error).toMatch(/[؀-ۿ]/);
      expect(errEvent.error).not.toMatch(/sk-or|api[_-]?key|bearer/i);
      console.log("[live] openrouter error surfaced:", errEvent.error);
    } else {
      expect(last?.type).toBe("done");
      expect(full.length).toBeGreaterThan(0);
      console.log("[live] openrouter streamed:", full.slice(0, 80));
    }
  }, 60_000);
});

describe.runIf(!live)("OpenRouterProvider (live) — متخطى", () => {
  it("يتخطى الاختبار الحي بدون YSD_LIVE=1", () => {
    expect(true).toBe(true);
  });
});
