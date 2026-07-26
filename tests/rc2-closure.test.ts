/**
 * v0.6.6 RC2 — إغلاق: نهاية الرد اللائقة + إنفاذ سؤال التوضيح.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endsWithCompleteSentence,
  isUsefulReply,
  shouldAppendTruncatedNotice,
  takeCompleteUnits,
} from "../lib/ai/language-guard";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { detectEntities } from "../lib/ai/entity-aliases";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

/** النص الفعلي الذي ظهر حيًّا على RC1 (بلا عبارة الجودة) */
const JJK_LIVE =
  "جوجيتسو كايسن هو أحد الأنميات التي لاقت إعجابًا كبيرًا في السنوات الأخيرة، وأرى أنه يتميز بعدة نقاط قوية:\n\n" +
  "- **الرسوم المتحركة**: الاستوديو MAPPA قدم جودة رسم عالية، خاصة في مشاهد القتال التي تتميز بالحركة السلسة والتفاصيل البصرية المذهلة.\n" +
  "- **القصة والعالم**: يدمج العناصر الخارقة للطبيعة مع عالم السحر واللعنة بطريقة مبتكرة، ويقدم توازنًا جيدًا بين الأكشن والتطور الدرامي للشخصيات.\n" +
  "- **الشخصيات**: الشخصيات الرئيسية مثل إيتادوري يوجي، ميجومي فوشيغورو، ونوبارا كوجيكي لها دوافع واضحة وتطور ملحوظ عبر الحلقات، بينما الشرير الرئيسي (سوكونا) يضيف طبقة من الغموض والتهديد.";

describe("★ RC2 — متى تُضاف عبارة الجودة", () => {
  it("★ نص Jujutsu Kaisen الحي: مفيد وينتهي بجملة مكتملة → بلا عبارة", () => {
    expect(isUsefulReply(JJK_LIVE)).toBe(true);
    expect(endsWithCompleteSentence(JJK_LIVE)).toBe(true);
    expect(shouldAppendTruncatedNotice(JJK_LIVE)).toBe(false);
  });

  it("نص مبتور في منتصف جملة → تُضاف العبارة", () => {
    const cut = "هذه فقرة طويلة نسبيًا فيها كلمات كثيرة جدًا لكنها تنتهي فجأة عند هذه الكلمة و";
    expect(isUsefulReply(cut)).toBe(true);
    expect(endsWithCompleteSentence(cut)).toBe(false);
    expect(shouldAppendTruncatedNotice(cut)).toBe(true);
  });

  it("نص قصير جدًا (بادئة) → تُضاف العبارة", () => {
    expect(shouldAppendTruncatedNotice("وقف الفارس.")).toBe(true);
  });

  it("نص ينتهي بتمهيد معلّق → تُضاف العبارة", () => {
    const dangling =
      "سأشرح لك الأمر بالتفصيل الكامل مع كل الخطوات اللازمة لإتمام العملية كما يلي:";
    expect(endsWithCompleteSentence(dangling)).toBe(false);
    expect(shouldAppendTruncatedNotice(dangling)).toBe(true);
  });
});

// ── تكامل ──────────────────────────────────────────────────────────────────
function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,25}/gs) ?? []) {
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

const ask = (content: string) => ({
  modelId: YSD_FREE_MODEL_ID,
  messages: [{ role: "user" as const, content }],
});

describe("★ RC2 — رد Jujutsu Kaisen الحي عبر البثّ", () => {
  it("★ لا عبارة جودة · لا رقم منفرد · لا خلط · ينتهي بجملة مكتملة", async () => {
    // تسريب بعد النص النظيف، ثم تعذّر المتابعة → كان يُلحق عبارة الجودة
    fetchMock
      .mockResolvedValueOnce(sse(`${JJK_LIVE}\n\nثم أضاف bajo تعليقًا دخيلًا.`, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(JJK_LIVE, FREE_MODEL_CHAIN[1]!)); // تكرار → تُرفض المتابعة
    const out = await collect(
      new OpenRouterProvider().streamChat(ask("ايش رايك في انمي جوجيتسو كايسن؟")),
    );
    const text = joinText(out);

    expect(text).not.toContain("توقفت هنا للحفاظ على جودة الرد"); // ★ بلا عبارة
    expect(text).not.toMatch(/^\s*\d+[.)]\s*$/m); // ★ بلا رقم قائمة منفرد
    expect(text).not.toMatch(/جوجو|JoJo|بيزار|Bizarre/i); // ★ بلا خلط
    expect(text).toMatch(/جوجيتسو كايسن/); // العمل الصحيح
    expect(endsWithCompleteSentence(text)).toBe(true); // ★ جملة مكتملة
    expect(text).not.toMatch(/bajo/i); // التسريب لم يصل
  });
});

describe("★ RC2 — إنفاذ سؤال التوضيح بلا نداء مزوّد", () => {
  it("★ «جوجو» الملتبسة → صفر طلبات توليد وسؤال توضيح", async () => {
    const out = await collect(
      new OpenRouterProvider().streamChat(ask("عطني معلومات عن جوجو")),
    );
    expect(fetchMock.mock.calls.length).toBe(0); // ★ لا نداء مزوّد إطلاقًا
    const text = joinText(out);
    expect(text).toMatch(/تقصد/);
    expect(text).toMatch(/JoJo's Bizarre Adventure/);
    expect(text).toMatch(/أنمي/); // نوع الكيان مذكور
  });

  it("★ الاسم الواضح لا يُسأل عنه — يذهب للمزوّد طبيعيًا", async () => {
    const answer = "جوجيتسو كايسن من أنميات الأكشن الحديثة التي حققت نجاحًا واسعًا عند المشاهدين.";
    fetchMock.mockResolvedValueOnce(sse(answer, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(ask("عن جوجيتسو كايسن")));
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(joinText(out)).toBe(answer);
  });

  it("★ JoJo وJujutsu Kaisen ليسا كيانًا واحدًا تحت أي نقحرة", () => {
    // كيانان منفصلان في السجل بأنواع ومعرّفات مستقلة — لا يندمجان أبدًا
    const both = detectEntities("قارن جوجو بجوجيتسو كايسن").map((e) => e.canonical);
    expect(both).toContain("JoJo's Bizarre Adventure");
    expect(both).toContain("Jujutsu Kaisen");
    expect(new Set(both).size).toBe(2); // اثنان لا واحد

    // ولا تتسرّب صور أحدهما إلى الآخر
    expect(detectEntities("جوجيتسو كايسن").map((e) => e.canonical)).toEqual(["Jujutsu Kaisen"]);
    expect(detectEntities("مغامرة جوجو الغريبة").map((e) => e.canonical)).toEqual([
      "JoJo's Bizarre Adventure",
    ]);
  });

  it("★ السوابق العربية الملتصقة لا تُفقد الكشف (بجوجيتسو / والدن رينق)", () => {
    expect(detectEntities("بجوجيتسو كايسن").map((e) => e.canonical)).toContain("Jujutsu Kaisen");
    expect(detectEntities("والدن رينق").map((e) => e.canonical)).toContain("Elden Ring");
    expect(detectEntities("لماينكرافت").map((e) => e.canonical)).toContain("Minecraft");
  });

  it("سؤال بلا كيانات لا يتأثر", async () => {
    const a = "البحر أوسع من النهر وأكثر ملوحة منه، وهو جزء من المسطحات المائية الكبرى.";
    fetchMock.mockResolvedValueOnce(sse(a, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(ask("ما الفرق بين البحر والنهر؟")));
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(joinText(out)).toBe(a);
  });
});

describe("★ RC2 — لا مُعلّم قائمة منفرد في البثّ", () => {
  it("«1.» وحدها تُحتجز حتى تصل الخطوة", () => {
    expect(takeCompleteUnits("اتبع الخطوات:\n1.").ready).toBe("");
    expect(takeCompleteUnits("مقدمة كاملة هنا.\n-").ready).toBe("مقدمة كاملة هنا.\n");
  });
});
