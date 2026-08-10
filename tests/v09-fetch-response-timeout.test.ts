import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * تشخيص: مهلة بلا أول بايت **بعد** رقعة نبضات الإبقاء (المحادثة بعد ccab717).
 *
 *   error_code = timeout · provider_first_byte_ms = -1 · fallback_count = 0
 *   total_response_ms = 100279
 *
 * والسؤال المطروح: هل `fetch` نفسها غير مغطاة بالمهلة؟ لا يُفترض جواب.
 *
 * ── انضباط هذه الاختبارات ──
 *
 * • المحاكي **يحترم `AbortSignal` فعلًا**: الطلب المعلّق يُرفض عند الإجهاض،
 *   والجسم يُخطأ. بغير ذلك يختبر المحاكي نفسه لا الشيفرة.
 * • المهل تُحقن بقيم مصغّرة عبر بوابات الاختبار القائمة — ولا تُمسّ قيم
 *   الإنتاج (20/25/45/110).
 * • كل حالة تقيس **الزمن المنقضي** وتفرض حدًّا أعلى: النجاح ليس «انتهى» بل
 *   «انتهى داخل الحدّ».
 */

/** مهل مصغّرة بنِسَب الإنتاج نفسها (÷100) */
const FIRST_BYTE = 200; // 20 ث
const IDLE = 250; // 25 ث
const CHAIN = 450; // 45 ث

let calls: string[] = [];
/** طلبات معلّقة لم تُحسم — للتأكد أن الإجهاض هو ما أنهاها */
let pendingAborted = 0;

/** `fetch` لا تعود أبدًا حتى الإجهاض — تحاكي تعليق DNS/TLS/الترويسات */
function neverResolves(signal?: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => {
      pendingAborted++;
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

/** ترويسات متأخّرة: تعود Response بعد `delayMs` — أو تُجهض قبلها */
function delayedHeaders(delayMs: number, body: () => Response, signal?: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(body()), delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      pendingAborted++;
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

/** جسم يبثّ ما يُملى عليه، ويحترم الإجهاض */
function streamOf(
  frames: { afterMs: number; line: string }[],
  signal?: AbortSignal,
  keepAliveEveryMs?: number,
): Response {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let ka: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) {
        timers.push(setTimeout(() => {
          try {
            c.enqueue(enc.encode(f.line));
          } catch {
            /* أُغلق */
          }
        }, f.afterMs));
      }
      if (keepAliveEveryMs) {
        ka = setInterval(() => {
          try {
            c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
          } catch {
            /* أُغلق */
          }
        }, keepAliveEveryMs);
      }
      signal?.addEventListener("abort", () => {
        timers.forEach(clearTimeout);
        if (ka) clearInterval(ka);
        try {
          c.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* أُغلق */
        }
      });
    },
    cancel() {
      timers.forEach(clearTimeout);
      if (ka) clearInterval(ka);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const dataFrame = (model: string, content: string) =>
  `data: ${JSON.stringify({ model, choices: [{ delta: { content } }] })}\n\n`;
/** إطار `data:` **بلا محتوى** — كما يرسله المزوّد أول البثّ (role فقط) */
const emptyFrame = (model: string) =>
  `data: ${JSON.stringify({ model, choices: [{ delta: { role: "assistant" } }] })}\n\n`;

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

const goodStream = (model: string, signal?: AbortSignal) =>
  streamOf(
    [
      { afterMs: 5, line: dataFrame(model, ARABIC) },
      { afterMs: 10, line: "data: [DONE]\n\n" },
    ],
    signal,
  );

async function run(signal?: AbortSignal): Promise<{
  text: string;
  errorCode: string | null;
  elapsedMs: number;
  attempts: number;
}> {
  const provider = new OpenRouterProvider();
  const out: StreamChunk[] = [];
  const t0 = Date.now();
  for await (const c of provider.streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
    signal,
  })) {
    out.push(c);
  }
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    errorCode: out.find((c) => c.type === "error")?.errorCode ?? null,
    elapsedMs: Date.now() - t0,
    attempts: calls.length,
  };
}

const transport = (per: (i: number, model: string, signal?: AbortSignal) => Promise<Response> | Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    calls.push(model);
    return per(calls.length - 1, model, init.signal ?? undefined);
  });

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = String(FIRST_BYTE);
  process.env.YSD_TEST_IDLE_MS = String(IDLE);
  process.env.YSD_TEST_CHAIN_BUDGET_MS = String(CHAIN);
  calls = [];
  pendingAborted = 0;
});

afterEach(() => {
  delete process.env.YSD_TEST_FIRST_BYTE_MS;
  delete process.env.YSD_TEST_IDLE_MS;
  delete process.env.YSD_TEST_CHAIN_BUDGET_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  ① أين تبدأ المهلة بالنسبة إلى fetch؟
// ════════════════════════════════════════════════════════════

describe("① تغطية fetch نفسها", () => {
  /**
   * ★ الحالة التي سأل عنها التقرير: `fetch` **لا تعود إطلاقًا**.
   * ليست Response بجسم صامت — بل الوعد نفسه معلّق.
   */
  it("★ fetch معلّقة تُجهَض عند مهلة أول بايت ثم يُجرَّب التالي", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) => (i === 0 ? neverResolves(sig) : goodStream(model, sig))),
    );

    const res = await run();

    // الإجهاض هو ما أنهى الطلب المعلّق — لا انتهاء طبيعي
    expect(pendingAborted).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    // داخل مهلة أول بايت + محاولة ناجحة — لا سقف المسار
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE + 150);
  });

  it("(A) ★ ترويسات متأخّرة فوق المهلة ⇒ إجهاض واحتياط", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) =>
        i === 0
          ? delayedHeaders(FIRST_BYTE * 5, () => goodStream(model), sig)
          : goodStream(model, sig),
      ),
    );

    const res = await run();
    expect(pendingAborted).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE + 150);
  });

  it("(D) ★ fetch ترفض فورًا ⇒ احتياط فوري", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) =>
        i === 0 ? Promise.reject(new TypeError("network")) : goodStream(model, sig),
      ),
    );

    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    // رفض فوري ثم محاولة ناجحة — لا انتظار مهلة أصلًا
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE);
  });
});

// ════════════════════════════════════════════════════════════
//  ② ما الذي يُعدّ «أول بايت مفيد»؟
// ════════════════════════════════════════════════════════════

describe("② الإطار الفارغ ليس محتوى", () => {
  it("(B) ★ Response فورية ثم نبضات فقط ⇒ إجهاض واحتياط", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) =>
        i === 0 ? streamOf([], sig, 20) : goodStream(model, sig),
      ),
    );

    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE + 150);
  });

  /**
   * ★ الحالة المشتبه بها في 100279مل: المزوّد يُرسل إطار `data:` **بلا محتوى**
   * (role فقط) ثم يتلكّأ. الإطار الفارغ ينقل المؤقّت إلى مهلة الخمول (25 ث)،
   * فتصير كل محاولة 25 ث بدل 20 ث — وأربع محاولات = 100 ث.
   */
  it("★ إطار data: فارغ ثم تلكّؤ — كم تستغرق المحاولة؟", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) =>
        i === 0
          ? streamOf([{ afterMs: 10, line: emptyFrame(model) }], sig)
          : goodStream(model, sig),
      ),
    );

    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    // ★ يجب ألّا تتجاوز مهلة أول بايت: الإطار الفارغ ليس محتوى
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE + 150);
  });

  it("(C) ★ أول محتوى قبل المهلة ⇒ لا احتياط", async () => {
    vi.stubGlobal(
      "fetch",
      transport((_i, model, sig) =>
        streamOf(
          [
            { afterMs: 10, line: emptyFrame(model) },
            { afterMs: FIRST_BYTE - 80, line: dataFrame(model, ARABIC) },
            { afterMs: FIRST_BYTE - 60, line: "data: [DONE]\n\n" },
          ],
          sig,
        ),
      ),
    );

    const res = await run();
    expect(calls).toHaveLength(1);
    expect(res.text).toContain(ARABIC);
  });

  it("★ أول محتوى بعد المهلة ⇒ احتياط", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) =>
        i === 0
          ? streamOf([{ afterMs: FIRST_BYTE * 4, line: dataFrame(model, ARABIC) }], sig)
          : goodStream(model, sig),
      ),
    );

    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.elapsedMs).toBeLessThan(FIRST_BYTE + IDLE + 150);
  });

  it("★ بثّ متدفّق أبطأ من مهلة أول بايت لا يُقتل", async () => {
    const parts = ["هذه ", "إجابة ", "عربية ", "سليمة ", "تمامًا."];
    vi.stubGlobal(
      "fetch",
      transport((_i, model, sig) =>
        streamOf(
          [
            ...parts.map((p, k) => ({ afterMs: 20 + k * (IDLE - 80), line: dataFrame(model, p) })),
            { afterMs: 20 + parts.length * (IDLE - 80), line: "data: [DONE]\n\n" },
          ],
          sig,
        ),
      ),
    );

    const res = await run();
    expect(calls).toHaveLength(1);
    expect(res.text).toContain("هذه إجابة عربية سليمة تمامًا.");
  });
});

// ════════════════════════════════════════════════════════════
//  ③ ميزانية السلسلة موعدٌ نهائي حقيقي
// ════════════════════════════════════════════════════════════

describe("③ ميزانية السلسلة", () => {
  it("★ كل النماذج معلّقة ⇒ ينتهي داخل الميزانية لا عند سقف المسار", async () => {
    vi.stubGlobal("fetch", transport((_i, _m, sig) => neverResolves(sig)));

    const res = await run();

    expect(res.errorCode).toBe("timeout");
    expect(res.text).toBe("");
    // ★ الحدّ الحاسم: لا 4 × مهلة، بل ميزانية السلسلة + هامش محاولة واحدة
    expect(res.elapsedMs).toBeLessThan(CHAIN + FIRST_BYTE);
    expect(calls.length).toBeLessThanOrEqual(FREE_MODEL_CHAIN.length);
  });

  it("★ محاولة جارية تتجاوز الميزانية تُجهَض فعلًا لا تُفحص بعد رجوعها", async () => {
    // مهلة أول بايت أطول من الميزانية: بلا موعد نهائي حقيقي ستعيش المحاولة أطول
    process.env.YSD_TEST_FIRST_BYTE_MS = String(CHAIN * 3);
    vi.stubGlobal("fetch", transport((_i, _m, sig) => neverResolves(sig)));

    const res = await run();

    expect(res.elapsedMs).toBeLessThan(CHAIN * 2);
    expect(pendingAborted).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ④ الإجهاض من المستخدم يبقى مميَّزًا
// ════════════════════════════════════════════════════════════

describe("④ إجهاض المستخدم", () => {
  it("★ إجهاض المستخدم ⇒ صفر احتياط", async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, sig) => {
        setTimeout(() => ac.abort(), 30);
        return neverResolves(sig);
      }),
    );

    await run(ac.signal);
    expect(calls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ⑤ حساب الحادثة: كم تستغرق سلسلة كاملة من التلكّؤ؟
// ════════════════════════════════════════════════════════════

describe("⑤ حساب 100279مل", () => {
  /**
   * ★ القياس الحاسم: كل النماذج تُرسل إطار `data:` فارغًا ثم تتلكّأ.
   *
   * إن كان الإطار الفارغ يُرقّي المؤقّت إلى مهلة الخمول، صارت كل محاولة
   * `IDLE` بدل `FIRST_BYTE`. والسؤال: كم محاولة تجري، وهل تُحترم الميزانية؟
   */
  it("★ كل النماذج: إطار فارغ ثم تلكّؤ", async () => {
    vi.stubGlobal(
      "fetch",
      transport((_i, model, sig) =>
        streamOf([{ afterMs: 5, line: emptyFrame(model) }], sig),
      ),
    );

    const res = await run();

    // eslint-disable-next-line no-console
    console.log(
      `[قياس] محاولات=${calls.length} زمن=${res.elapsedMs}مل ` +
        `(FIRST_BYTE=${FIRST_BYTE} IDLE=${IDLE} CHAIN=${CHAIN})`,
    );

    expect(res.errorCode).toBe("timeout");
    // ★ الحدّ الحاسم: الميزانية هي السقف لا مجموع المحاولات
    expect(res.elapsedMs).toBeLessThan(CHAIN + IDLE);
  });
});
