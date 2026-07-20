/**
 * منع الإكمال الفارغ (v0.6.5 RC6) — وحدات + تكامل عبر البثّ بمحاكاة fetch.
 * لا يُرسل أي طلب توليد حقيقي ولا يستهلك حصة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import {
  _resetCooldowns,
  COOLDOWN_MS,
  cooldownReason,
  cooldownRemainingMs,
  isCoolingDown,
} from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";
import {
  NO_COMPLETION_MESSAGE,
  buildNoCompletionMessage,
  isEmptyCompletion,
} from "../lib/ai/empty-completion";

const WM_Q = "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟";

describe("★ كشف الإكمال الفارغ", () => {
  it("فارغ أو مسافات أو أسطر فقط = فاشل", () => {
    expect(isEmptyCompletion("")).toBe(true);
    expect(isEmptyCompletion("   ")).toBe(true);
    expect(isEmptyCompletion("\n\n  \t")).toBe(true);
    expect(isEmptyCompletion(undefined)).toBe(true);
    expect(isEmptyCompletion(null)).toBe(true);
  });

  it("نص حقيقي ليس فارغًا", () => {
    expect(isEmptyCompletion("مرحبًا")).toBe(false);
  });
});

describe("★ رسالة تعذّر الإكمال", () => {
  it("مع اكتشاف Elden Ring وذكر القناع الأبيض → الصيغة الخاصة", () => {
    const m = buildNoCompletionMessage(WM_Q);
    expect(m).toContain("عرفت أنك تقصد Elden Ring");
    expect(m).toContain("White Mask");
    expect(m).toContain("ولا أبغى أعطيك معلومة خاطئة");
    expect(m).not.toMatch(/اللعبة التي تقصدها|وضّح اسم/); // لا يسأل عن الاسم
  });

  it("مع اكتشاف اللعبة بلا ذكر العنصر → صيغة عامة تذكر الاسم", () => {
    const m = buildNoCompletionMessage("في الدن رينق كيف أطوّر سلاحي؟");
    expect(m).toContain("عرفت أنك تقصد Elden Ring");
    expect(m).not.toContain("White Mask");
  });

  it("بلا كيان معروف → رسالة عربية عامة واضحة لا رسالة فارغة", () => {
    expect(buildNoCompletionMessage("اكتب لي قصيدة قصيرة")).toBe(NO_COMPLETION_MESSAGE);
    expect(NO_COMPLETION_MESSAGE).toMatch(/[؀-ۿ]/);
  });
});

// ── تكامل عبر مسار البثّ ───────────────────────────────────────────────────
/** بثّ SSE بمحتوى نصي */
function sse(text: string, model: string, finish = "stop"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,20}/gs) ?? []) {
        c.enqueue(
          enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: ch } }] })}\n\n`),
        );
      }
      c.enqueue(
        enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: finish }] })}\n\n`),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** بثّ ينتهي بلا أي delta.content — مع تفكير داخلي اختياري */
function sseEmpty(model: string, opts: { reasoning?: boolean; finish?: string } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      if (opts.reasoning) {
        for (let i = 0; i < 3; i++) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ model, choices: [{ delta: { reasoning: "تفكير داخلي لا يُعرض" } }] })}\n\n`,
            ),
          );
        }
      }
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ model, choices: [{ delta: {}, finish_reason: opts.finish ?? "length" }] })}\n\n`,
        ),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** بثّ بمسافات وأسطر فقط */
function sseBlank(model: string): Response {
  return sse("   \n\n   \n", model);
}

async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const reqOf = (content: string) => ({
  modelId: YSD_FREE_MODEL_ID,
  messages: [{ role: "user" as const, content }],
});
const joinText = (out: { type: string; text?: string }[]) =>
  out.filter((c) => c.type === "text").map((c) => c.text).join("");

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const GOOD = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

describe("★ الإكمال الفارغ داخل مسار البثّ", () => {
  it("★ رد فارغ → ينتقل للنموذج التالي ولا يُعيد نفس النموذج", async () => {
    fetchMock
      .mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    expect(joinText(out)).toBe(GOOD);
    expect(fetchMock.mock.calls.length).toBe(2);
    const tried = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).model);
    expect(tried.filter((m: string) => m === FREE_MODEL_CHAIN[0]).length).toBe(1); // بلا إعادة
  });

  it("★ مسافات/أسطر فقط تُعامَل كإكمال فارغ", async () => {
    fetchMock
      .mockResolvedValueOnce(sseBlank(FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    expect(joinText(out)).toBe(GOOD);
    expect(joinText(out).trim().length).toBeGreaterThan(0);
  });

  it("★ تفكير داخلي بلا إجابة → فارغ، ولا يظهر التفكير للمستخدم", async () => {
    fetchMock
      .mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[0]!, { reasoning: true }))
      .mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    const text = joinText(out);
    expect(text).toBe(GOOD);
    expect(text).not.toContain("تفكير داخلي"); // التفكير لا يصل المستخدم
  });

  it("★ النموذج الفارغ يدخل تهدئة دقيقتين", async () => {
    fetchMock
      .mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
    expect(cooldownReason(FREE_MODEL_CHAIN[0]!)).toBe("empty_completion");
    expect(COOLDOWN_MS.empty_completion).toBe(2 * 60_000);
    expect(cooldownRemainingMs(FREE_MODEL_CHAIN[0]!)).toBeLessThanOrEqual(2 * 60_000);
    expect(cooldownRemainingMs(FREE_MODEL_CHAIN[0]!)).toBeGreaterThan(60_000);
  });

  it("★ الطلب التالي لا يُرسل إلى النموذج المهدّأ بالفراغ", async () => {
    fetchMock
      .mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    const after = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValueOnce(sse(GOOD, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي فقرة قصيرة.")));
    expect(fetchMock.mock.calls.length).toBe(after + 1); // محاولة واحدة فقط
  });

  it("★ كل النماذج فارغة + سؤال Elden Ring → رسالة عدم التأكد الخاصة، لا رد فارغ", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) {
      fetchMock.mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[i]!, { reasoning: true }));
    }
    const out = await collect(new OpenRouterProvider().streamChat(reqOf(WM_Q)));
    const text = joinText(out);
    expect(text).toContain("عرفت أنك تقصد Elden Ring");
    expect(text).toContain("White Mask");
    expect(text.trim().length).toBeGreaterThan(0); // ليست رسالة فارغة
    expect(out.some((c) => c.type === "error")).toBe(false);
    // لا meta بلا نص: كل meta يتبعها نص
    const types = out.map((c) => c.type);
    expect(types.indexOf("text")).toBeGreaterThan(types.indexOf("meta"));
  });

  it("★ كل النماذج فارغة في محادثة عامة → رسالة عربية واضحة لا رد فارغ", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) {
      fetchMock.mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[i]!));
    }
    const out = await collect(new OpenRouterProvider().streamChat(reqOf("اكتب لي قصيدة قصيرة.")));
    expect(joinText(out)).toBe(NO_COMPLETION_MESSAGE);
    expect(out.some((c) => c.type === "error")).toBe(false);
  });

  it("★ لا يُرسل meta ثم done بلا نص إطلاقًا", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) {
      fetchMock.mockResolvedValueOnce(sseEmpty(FREE_MODEL_CHAIN[i]!));
    }
    const out = await collect(new OpenRouterProvider().streamChat(reqOf("سؤال عام.")));
    const metaIdx = out.findIndex((c) => c.type === "meta");
    if (metaIdx >= 0) {
      const after = out.slice(metaIdx);
      expect(after.some((c) => c.type === "text" && (c.text ?? "").trim().length > 0)).toBe(true);
    }
  });
});
