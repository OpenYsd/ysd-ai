/**
 * تكامل سلسلة الاحتياط + التهدئة + حارس اللغة — بمحاكاة fetch.
 * لا يُرسل أي طلب توليد حقيقي ولا يستهلك حصة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns, isCoolingDown } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

/** يبني ردًا يشبه بث SSE من OpenRouter */
function sseResponse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,20}/gs) ?? []) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: ch } }] })}\n\n`));
      }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ model, usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const errResponse = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";
const MIXED = "هذه إجابة مختلطة чрезвычайно بالروسية 这是中文 وهو خلط مرفوض تمامًا في المنصة.";

const req = (modelId: string) => ({
  modelId,
  messages: [{ role: "user" as const, content: "ما هي عاصمة السعودية؟" }],
});

async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("التهدئة داخل مسار البث", () => {
  it("429 يُهدّئ النموذج ثم ينتقل للتالي — والناجح يبثّ", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));

    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(out.some((c) => c.type === "text")).toBe(true);
    expect(out.some((c) => c.type === "error")).toBe(false);
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true); // الأول مهدّأ
    expect(isCoolingDown(FREE_MODEL_CHAIN[1]!)).toBe(false); // الناجح سليم
  });

  it("★ الطلب التالي لا يُرسل إلى النموذج المهدّأ إطلاقًا", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const firstRoundCalls = fetchMock.mock.calls.length;

    // طلب ثانٍ: يجب أن يبدأ من النموذج الثاني مباشرة (استدعاء واحد)
    fetchMock.mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));

    expect(fetchMock.mock.calls.length).toBe(firstRoundCalls + 1);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).model);
    // النموذج المهدّأ أُرسل مرة واحدة فقط (في الجولة الأولى)
    expect(bodies.filter((m: string) => m === FREE_MODEL_CHAIN[0]).length).toBe(1);
  });

  it("Retry-After يُحترم في التهدئة", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rate limited", { "retry-after": "30" }))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("404 no_free_model يُهدّئ 6 ساعات وينتقل", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(404, "This model is unavailable for free"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(out.some((c) => c.type === "text")).toBe(true);
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("5xx يُهدّئ وينتقل", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(503, "overloaded"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("timeout/شبكة يُهدّئ وينتقل", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
  });

  it("★ كل السلسلة مهدّأة → رسالة عربية واضحة بلا أي طلب", async () => {
    // أفشل الجميع أولًا
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) fetchMock.mockResolvedValueOnce(errResponse(429, "rl"));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const callsAfterFirst = fetchMock.mock.calls.length;

    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const err = out.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/[؀-ۿ]/); // عربية
    expect(err!.error).toMatch(/مضغوطة|أعد المحاولة/);
    // لم يُرسل ولا طلب واحد في الجولة الثانية
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("auth (401) لا يُهدّئ النموذج — مشكلة إعداد لا عطل نموذج", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) fetchMock.mockResolvedValueOnce(errResponse(401, "bad key"));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(FREE_MODEL_CHAIN.every((m) => !isCoolingDown(m))).toBe(true);
  });
});

describe("حارس اللغة يستمر مع كل fallback", () => {
  it("★ رد مختلط من الأول → الحارس يمنعه ويجرّب التالي", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно|这是中文/); // الخليط لم يصل المستخدم
    expect(text).toMatch(/[؀-ۿ]/);
    expect(fetchMock.mock.calls.length).toBe(2); // انتقل فعلًا
  });

  it("★ الحارس لا يُهدّئ النموذج — جودة رد لا عطل توفّر", async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[1]!));
    await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(false);
  });

  it("★ الحارس يعمل على النموذج الاحتياطي أيضًا — خليط من الجميع يُرفض", async () => {
    for (let i = 0; i < FREE_MODEL_CHAIN.length; i++) {
      fetchMock.mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[i]!));
    }
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно|这是中文/);
    expect(out.some((c) => c.type === "error")).toBe(true);
  });

  it("الحارس يعمل بعد تخطي نموذج مهدّأ", async () => {
    fetchMock
      .mockResolvedValueOnce(errResponse(429, "rl")) // الأول يُهدّأ
      .mockResolvedValueOnce(sseResponse(MIXED, FREE_MODEL_CHAIN[1]!)) // الثاني مختلط
      .mockResolvedValueOnce(sseResponse(ARABIC, FREE_MODEL_CHAIN[2]!)); // الثالث سليم
    const out = await collect(new OpenRouterProvider().streamChat(req(YSD_FREE_MODEL_ID)));
    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).not.toMatch(/чрезвычайно/);
    expect(text).toMatch(/[؀-ۿ]/);
  });
});
