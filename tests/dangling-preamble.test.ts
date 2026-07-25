/**
 * الرد المقطوع (v0.6.6) — لا يُعرض تمهيد أو بداية قائمة بلا خطوة كاملة بعدها.
 *
 * رُصد حيًّا: «اتبع هذه الخطوات بدقة:» ثم «1.» ثم عبارة الجودة. السبب أن مقسّم
 * الجمل كان يعدّ النقطة في «1.» نهايةَ جملة، فيُبثّ المُعلّم وحده.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endsWithDanglingPreamble,
  takeCompleteUnits,
} from "../lib/ai/language-guard";
import { OpenRouterProvider } from "../lib/ai/openrouter";
import { _resetCooldowns } from "../lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

describe("★ كشف التمهيد المعلّق", () => {
  it("عنوان ينتهي بنقطتين معلّق", () => {
    expect(endsWithDanglingPreamble("اتبع هذه الخطوات بدقة:")).toBe(true);
    expect(endsWithDanglingPreamble("اتبع هذه الخطوات بدقة:\n")).toBe(true);
  });

  it("سطر فيه مُعلّم قائمة وحده معلّق", () => {
    expect(endsWithDanglingPreamble("اتبع الخطوات:\n1.")).toBe(true);
    expect(endsWithDanglingPreamble("مقدمة.\n2)")).toBe(true);
    expect(endsWithDanglingPreamble("مقدمة.\n-")).toBe(true);
  });

  it("نص فيه خطوة كاملة ليس معلّقًا", () => {
    expect(endsWithDanglingPreamble("اتبع الخطوات:\n1. افتح الباب.")).toBe(false);
    expect(endsWithDanglingPreamble("هذه إجابة كاملة.")).toBe(false);
  });
});

describe("★ مقسّم الوحدات لا يقطع عند مُعلّم القائمة", () => {
  it("★ «1.» في أول السطر ليست نهاية جملة", () => {
    const buf = "اتبع هذه الخطوات بدقة:\n1.";
    expect(takeCompleteUnits(buf).ready).toBe(""); // يُحتجز كله
    expect(takeCompleteUnits(buf).rest).toBe(buf);
  });

  it("★ الوحدة تُسلَّم فقط بعد وصول خطوة كاملة", () => {
    const buf = "اتبع هذه الخطوات بدقة:\n1. افتح الباب الأول.\n2.";
    const r = takeCompleteUnits(buf);
    expect(r.ready).toContain("1. افتح الباب الأول.");
    expect(r.ready).not.toMatch(/2\.\s*$/); // «2.» المعلّقة لم تُسلَّم
    expect(r.ready + r.rest).toBe(buf); // بلا فقد حرف
  });

  it("الرقم العشري ليس نهاية جملة", () => {
    const buf = "القيمة تساوي 3.5 تقريبًا";
    expect(takeCompleteUnits(buf).ready).toBe("");
  });

  it("الجملة العادية تُسلَّم كما هي", () => {
    const buf = "هذه جملة أولى. وهذه بداية الثانية";
    const r = takeCompleteUnits(buf);
    expect(r.ready).toBe("هذه جملة أولى. ");
    expect(r.rest).toBe("وهذه بداية الثانية");
  });
});

// ── تكامل عبر البثّ ────────────────────────────────────────────────────────
function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,15}/gs) ?? []) {
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

describe("★ لا تظهر قائمة تحتوي رقم 1 فقط", () => {
  it("★ رد ينتهي عند «1.» → لا يُعرض، ويُجرَّب نموذج آخر", async () => {
    const truncated = "اتبع هذه الخطوات بدقة:\n1.";
    const good = "هذه إجابة عربية كاملة وواضحة عن سؤال المستخدم بلا أي نقص إطلاقًا.";
    fetchMock
      .mockResolvedValueOnce(sse(truncated, FREE_MODEL_CHAIN[0]!))
      .mockResolvedValueOnce(sse(good, FREE_MODEL_CHAIN[1]!));
    const out = await collect(new OpenRouterProvider().streamChat(ask("اشرح لي الأمر.")));
    const text = joinText(out);
    expect(text).toBe(good);
    expect(text).not.toContain("اتبع هذه الخطوات بدقة:"); // التمهيد لم يظهر
    expect(text).not.toMatch(/^\s*1\.\s*$/m); // ولا «1.» وحدها
    expect(fetchMock.mock.calls.length).toBe(2); // انتقل فعلًا
  });

  it("★ التمهيد الناقص لا يُخلط بعبارة الجودة", async () => {
    const truncated = "اتبع هذه الخطوات بدقة:\n1.";
    // جسم الرد يُقرأ مرة واحدة، فلكل نموذج في السلسلة استجابة جديدة
    fetchMock.mockImplementation(() => Promise.resolve(sse(truncated, FREE_MODEL_CHAIN[0]!)));
    const out = await collect(new OpenRouterProvider().streamChat(ask("اشرح لي الأمر.")));
    const text = joinText(out);
    // لا يظهر «تمهيد + توقفت هنا» — إما رد كامل أو رسالة واضحة
    expect(text).not.toMatch(/الخطوات بدقة:[\s\S]*توقفت هنا/);
    expect(text).not.toMatch(/1\.[\s\S]*توقفت هنا/);
  });

  it("قائمة كاملة تُعرض كما هي بلا نقص", async () => {
    const full = "اتبع الخطوات:\n1. افتح الباب الأول.\n2. ادخل الغرفة بهدوء.\n3. أغلق الباب.";
    fetchMock.mockResolvedValueOnce(sse(full, FREE_MODEL_CHAIN[0]!));
    const out = await collect(new OpenRouterProvider().streamChat(ask("اشرح لي الأمر.")));
    expect(joinText(out)).toBe(full);
  });
});
