/**
 * اختصار الوضع المحمي (v0.6.5 RC8) — سؤال متخصص بلا مصدر لا يصل المزوّد أصلًا.
 * كل الاختبارات بمحاكاة fetch: أي طلب توليد سيظهر في fetchMock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";
import { VERIFYING_STATUS_MESSAGE } from "../lib/ai/uncertainty-guard";

const WM_Q = "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟";
const SAFE_WM =
  "عرفت أنك تقصد Elden Ring، لكني غير متأكد من خطوات الحصول على White Mask، ولا أبغى أعطيك معلومة خاطئة.";
const SAFE_GENERIC = "لست متأكدًا من التفاصيل الدقيقة، ولا أبغى أعطيك معلومة خاطئة.";

function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,20}/gs) ?? []) {
        c.enqueue(
          enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: ch } }] })}\n\n`),
        );
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<{ type: string; text?: string }>) {
  const out: { type: string; text?: string }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}
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

const ask = (content: string, grounding?: { source: string; sourceId?: string }) =>
  ({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user" as const, content }],
    ...(grounding ? { grounding: grounding as never } : {}),
  });

describe("★ الاختصار — بلا أي طلب للمزوّد", () => {
  it("★ سؤال White Mask بلا مصدر → صفر طلبات توليد", async () => {
    const out = await collect(new OpenRouterProvider().streamChat(ask(WM_Q)));
    expect(fetchMock.mock.calls.length).toBe(0); // ولا نداء واحد
    expect(joinText(out)).toBe(SAFE_WM);
  });

  it("★ الحالة أولًا ثم الرسالة الآمنة", async () => {
    const out = await collect(new OpenRouterProvider().streamChat(ask(WM_Q)));
    expect(out[0]?.type).toBe("status");
    expect(out[0]?.text).toBe(VERIFYING_STATUS_MESSAGE);
    const textIdx = out.findIndex((c) => c.type === "text");
    expect(textIdx).toBeGreaterThan(0); // النص بعد الحالة
    expect(out[out.length - 1]?.type).toBe("done");
  });

  it("★ alias Elden Ring يظهر في الرسالة", async () => {
    const out = await collect(new OpenRouterProvider().streamChat(ask(WM_Q)));
    expect(joinText(out)).toContain("عرفت أنك تقصد Elden Ring");
    expect(joinText(out)).toContain("White Mask");
  });

  it("★ لا موقع ولا خطوات ولا أرقام في الرسالة", async () => {
    const text = joinText(await collect(new OpenRouterProvider().streamChat(ask(WM_Q))));
    expect(text).not.toMatch(/\d/); // بلا أرقام
    expect(text).not.toMatch(/Siofra|منطقة|اذهب|اتجه|شمال|جنوب/);
    expect(text).not.toMatch(/^\s*\d+[.)]/m); // بلا خطوات مرقّمة
  });

  it("بلا alias معروف → الرسالة العامة", async () => {
    const out = await collect(
      new OpenRouterProvider().streamChat(ask("كيف أحصل على السيف الأسطوري في اللعبة؟")),
    );
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(joinText(out)).toBe(SAFE_GENERIC);
  });

  it("الرسالة الآمنة ليست فارغة (تُحفظ كرسالة مساعد عادية)", async () => {
    const text = joinText(await collect(new OpenRouterProvider().streamChat(ask(WM_Q))));
    expect(text.trim().length).toBeGreaterThan(0);
  });
});

describe("★ لا اختصار عند وجود مصدر موثوق", () => {
  const answer = "حسب المصدر المرفق، القناع موجود في المنطقة المذكورة في الصفحة الثالثة.";

  for (const source of ["rag", "knowledge_base", "tool", "user_context"] as const) {
    it(`★ ${source} → يصل المزوّد ولا يُختصر`, async () => {
      fetchMock.mockResolvedValueOnce(sse(answer, FREE_MODEL_CHAIN[0]!));
      const out = await collect(
        new OpenRouterProvider().streamChat(
          ask(WM_Q, { source, ...(source === "knowledge_base" ? { sourceId: "kb-001" } : {}) }),
        ),
      );
      expect(fetchMock.mock.calls.length).toBe(1); // نداء فعلي حدث
      expect(joinText(out)).toBe(answer); // ومرّ من المصدر
    });
  }
});

describe("★ الوضع العام لا يتأثر بالاختصار", () => {
  it("سؤال عام بسيط يصل المزوّد ويُبثّ", async () => {
    const a = "عاصمة السعودية هي الرياض، وهي أكبر مدنها وأكثرها سكانًا.";
    fetchMock.mockResolvedValueOnce(sse(a, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat(ask("ما هي عاصمة السعودية؟")),
    );
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(joinText(out)).toBe(a);
    expect(out.some((c) => c.type === "status")).toBe(false); // بلا حالة تحقّق
  });

  it("★ كتابة إبداعية طويلة تبقى streaming على دفعات", async () => {
    const story = "وقف الفارس أمام التنين. ".repeat(30);
    fetchMock.mockResolvedValueOnce(sse(story, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat(ask("اكتب مشهد معركة قصير في رواية خيالية.")),
    );
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(out.filter((c) => c.type === "text").length).toBeGreaterThan(1);
    expect(joinText(out)).toBe(story);
  });
});
