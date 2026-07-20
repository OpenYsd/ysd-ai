/**
 * حارس الإسناد (v0.6.5 RC7) — منع التفاصيل المتخصصة غير الموثقة.
 * وحدات + تكامل عبر البثّ بمحاكاة fetch. بلا شبكة وبلا استهلاك حصة.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";
import {
  buildUnsourcedMessage,
  detectUserGrounding,
  hasHighRiskDetails,
  violatesGrounding,
} from "../lib/ai/grounding-guard";

const WM_Q = "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟";

/** الرد المختلَق الذي أنتجه النموذج حيًّا على RC6 */
const FABRICATED =
  "الـ White Mask يُحصل عليه في منطقة Siofra River.\n" +
  "1. اذهب إلى Siofra River Bonfire.\n" +
  "2. ابحث عن جدار صغير في المنطقة، يوجد خلفه صندوق مخفي.\n" +
  "3. استخدم شعلة أو سلاح لكسر الجدار.\n" +
  "4. افتح الصندوق، ستجد الـ White Mask داخلها.\n" +
  "5. ارتديه في قائمة الأسلحة/الملابس.";

describe("★ كشف التفاصيل عالية المخاطر", () => {
  it("الرد المختلَق (Siofra River + خمس خطوات) يُكتشف", () => {
    expect(hasHighRiskDetails(FABRICATED, WM_Q)).toBe(true);
  });

  it("اعتراف بلا تفاصيل لا يُكتشف", () => {
    expect(hasHighRiskDetails("لست متأكدًا من التفاصيل، ولا أريد إعطاءك معلومة خاطئة.", WM_Q)).toBe(
      false,
    );
  });

  it("اسم اللعبة الذي ذكره المستخدم نفسه ليس اختلاقًا", () => {
    // «Elden Ring» معروف من طبقة الـaliases عبر «الدن رينق» في السؤال
    expect(hasHighRiskDetails("أعرف لعبة Elden Ring جيدًا.", WM_Q)).toBe(false);
    // لكن اسم موقع لم يرد في السؤال يُعدّ عالي المخاطر
    expect(hasHighRiskDetails("ستجده في Siofra River.", WM_Q)).toBe(true);
  });
});

describe("★ الإسناد يقرّر المرور", () => {
  it("★ تفاصيل بلا مصدر → تُمنع", () => {
    const v = violatesGrounding(FABRICATED, WM_Q, { source: "none" });
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unsourced_specifics");
  });

  it("★ نفس التفاصيل مع قاعدة معرفة موثوقة (source_id) → تمر", () => {
    expect(
      violatesGrounding(FABRICATED, WM_Q, { source: "knowledge_base", sourceId: "kb-elden-001" })
        .violated,
    ).toBe(false);
  });

  it("مصدر RAG أو أداة أو سياق المستخدم → تمر", () => {
    for (const source of ["rag", "tool", "user_context"] as const) {
      expect(violatesGrounding(FABRICATED, WM_Q, { source }).violated).toBe(false);
    }
  });

  it("★ رقم/نسبة متخصصة بلا مصدر → تُمنع", () => {
    const reply = "يزيد الضرر بنسبة 10% عند تراكم النزف.";
    expect(violatesGrounding(reply, WM_Q, { source: "none" }).violated).toBe(true);
    expect(violatesGrounding(reply, WM_Q, { source: "rag" }).violated).toBe(false);
  });

  it("معرفة النموذج الداخلية ليست مصدرًا (none هو الافتراض)", () => {
    expect(violatesGrounding(FABRICATED, WM_Q, { source: "none" }).violated).toBe(true);
  });

  it("إسناد سياق المستخدم ضيّق — ذكر العنصر وحده لا يكفي", () => {
    expect(detectUserGrounding(WM_Q)).toBe(false);
    expect(detectUserGrounding("المصدر: دليل اللعبة الرسمي، والخطوات هي كذا")).toBe(true);
    expect(detectUserGrounding("1. فتحت البوابة\n2. ثم دخلت")).toBe(true);
  });
});

describe("★ الرسالة الآمنة", () => {
  it("تذكر Elden Ring وWhite Mask بلا أي موقع أو خطوة", () => {
    const m = buildUnsourcedMessage(WM_Q);
    expect(m).toBe(
      "عرفت أنك تقصد Elden Ring، لكني غير متأكد من خطوات الحصول على White Mask، ولا أبغى أعطيك معلومة خاطئة.",
    );
    expect(m).not.toMatch(/Siofra|منطقة|اذهب|\d/);
  });
});

// ── تكامل عبر مسار البثّ ───────────────────────────────────────────────────
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

async function collect(gen: AsyncGenerator<{ type: string; text?: string; error?: string }>) {
  const out: { type: string; text?: string; error?: string }[] = [];
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

const SAFE_MSG =
  "عرفت أنك تقصد Elden Ring، لكني غير متأكد من خطوات الحصول على White Mask، ولا أبغى أعطيك معلومة خاطئة.";

describe("★ RC7 داخل مسار البثّ — الوضع المحمي", () => {
  const protectedReq = () => ({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user" as const, content: WM_Q }],
  });

  it("★ رد واثق مختلَق بلا مصدر → لا يظهر، وإعادة توليد واحدة ثم الرسالة الآمنة", async () => {
    fetchMock
      .mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!)); // أصرّ على التفاصيل
    const out = await collect(new OpenRouterProvider().streamChat(protectedReq()));
    const text = joinText(out);
    expect(text).not.toContain("Siofra"); // ولا شظية من التفاصيل
    expect(text).not.toContain("جدار");
    expect(text).toBe(SAFE_MSG);
    expect(fetchMock.mock.calls.length).toBe(2); // إعادة توليد واحدة فقط
  });

  it("★ إعادة التوليد تُنتج اعترافًا نظيفًا → يُعرض بلا تفاصيل", async () => {
    fetchMock
      .mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(
        sse("لست متأكدًا من الطريقة الدقيقة، ولا أريد إعطاءك معلومة خاطئة.", FREE_MODEL_CHAIN[0]!),
      );
    const out = await collect(new OpenRouterProvider().streamChat(protectedReq()));
    const text = joinText(out);
    expect(text).not.toContain("Siofra");
    expect(text).toContain("لست متأكد");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("★ التفاصيل المرفوضة لا تصل المستخدم إطلاقًا (فلا تُحفظ)", async () => {
    fetchMock
      .mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(protectedReq()));
    const text = joinText(out);
    for (const frag of ["Siofra River", "Bonfire", "صندوق مخفي", "1.", "5."]) {
      expect(text).not.toContain(frag);
    }
    expect(text.trim().length).toBeGreaterThan(0); // وليست رسالة فارغة
  });

  it("★ نفس التفاصيل مع إسناد RAG → تمر كما هي", async () => {
    fetchMock.mockResolvedValueOnce(sse(FABRICATED, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat({ ...protectedReq(), grounding: { source: "rag" } }),
    );
    expect(joinText(out)).toBe(FABRICATED);
    expect(fetchMock.mock.calls.length).toBe(1); // بلا إعادة توليد
  });
});

describe("★ RC7 لا يمسّ الأسئلة العامة والإبداعية", () => {
  it("سؤال عام بسيط لا يتأثر", async () => {
    const answer = "عاصمة السعودية هي الرياض، وهي أكبر مدنها.";
    fetchMock.mockResolvedValueOnce(sse(answer, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat({
        modelId: YSD_FREE_MODEL_ID,
        messages: [{ role: "user", content: "ما هي عاصمة السعودية؟" }],
      }),
    );
    expect(joinText(out)).toBe(answer);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("★ قصة خيالية فيها اتجاهات وأرقام لا تتأثر (وضع عام)", async () => {
    const story =
      "وقف الفارس شمال الوادي عند الفجر. رفع سيفه 3 مرات. ثم اندفع نحو التنين بلا خوف.";
    fetchMock.mockResolvedValueOnce(sse(story, FREE_MODEL_CHAIN[0]!));
    const out = await collect(
      new OpenRouterProvider().streamChat({
        modelId: YSD_FREE_MODEL_ID,
        messages: [{ role: "user", content: "اكتب مشهد معركة قصير في رواية خيالية." }],
      }),
    );
    expect(joinText(out)).toBe(story); // لم يُمنع رغم الاتجاهات والأرقام
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
