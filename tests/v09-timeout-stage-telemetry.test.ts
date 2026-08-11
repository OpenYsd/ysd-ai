import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import type { ChatRequest } from "@/lib/ai/types";

/**
 * مراحل المهلة الثلاث — مقيسة على سطر السجل الحقيقي.
 *
 * الحادثة الحيّة سجّلت `timeout_stage=none` و`headers_received=false` لمحاولتين
 * انتهتا بمهلة. وكلاهما كان خطأً في القياس لا في الواقع: مسار قراءة البثّ كان
 * يعود بلا قياسات، فتُطبع القيم الافتراضية — أي أن السجل نفى وصول الترويسات
 * بينما وصلت. وهو الفرق الذي يفصل «المزوّد لم يردّ» عن «ردّ ثم لم يُنتج».
 */

let calls: string[] = [];
/** أسطر `attempt failed` كما تُطبع فعلًا */
let logged: string[] = [];

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

/** لا يستجيب أبدًا — حتى يقطعه AbortSignal (المهلة قبل الاستجابة) */
function neverResponds(signal?: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

/** ترويسات تصل ثم جسمٌ صامت (المهلة بانتظار محتوى) */
function headersThenSilence(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* أُغلق */
          }
        });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** محتوى يبدأ ثم يسكن البثّ (مهلة الخمول) */
function contentThenSilence(model: string, signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ model, choices: [{ delta: { content: ARABIC } }] })}\n\n`,
          ),
        );
        // ولا شيء بعدها — حتى تنقضي مهلة الخمول
        signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* أُغلق */
          }
        });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function run(extra?: Partial<ChatRequest>): Promise<void> {
  for await (const _ of new OpenRouterProvider().streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
    ...extra,
  })) {
    /* نستهلك البثّ كاملًا */
  }
}

/**
 * سؤال متخصص + مصدر موثوق ⇒ **الوضع المحمي**.
 *
 * لماذا هنا: مهلة الخمول بعد نصٍّ **معروض** تُنهي الردّ ناقصًا للمستخدم بدل
 * أن تُحسب فشل محاولة — فلا يُطبع سطر فشل أصلًا. وفي الوضع المحمي يُخزَّن
 * المحتوى ولا يُعرض حتى يكتمل، فالمهلة تبقى فشلًا مسجَّلًا. وهو المسار الوحيد
 * الذي يُظهر `stream_idle` في السجل.
 */
const PROTECTED = {
  messages: [
    {
      role: "user" as const,
      content:
        "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟",
    },
  ],
  grounding: { source: "rag" as const, sourceId: "f-1" },
};

/** يقرأ حقلًا من أول سطر فشل يخصّ النموذج المطلوب */
function fieldFor(model: string, field: string): string | null {
  const line = logged.find((l) => l.includes(`model=${model} `));
  if (!line) return null;
  const m = new RegExp(`${field}=([^\\s]+)`).exec(line);
  return m?.[1] ?? null;
}

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = "250";
  process.env.YSD_TEST_IDLE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "6000";
  process.env.YSD_TEST_PROBE_GATE_MS = "0";
  calls = [];
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("attempt failed: model=")) logged.push(line);
  });
});
afterEach(() => {
  for (const k of [
    "YSD_TEST_FIRST_BYTE_MS",
    "YSD_TEST_IDLE_MS",
    "YSD_TEST_CHAIN_BUDGET_MS",
    "YSD_TEST_PROBE_GATE_MS",
  ]) {
    delete process.env[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("★ مراحل المهلة الثلاث", () => {
  /**
   * ★ (١) `before_response` — انقضت المهلة ولم تصل استجابة أصلًا.
   *
   * المؤقّت يُسلَّح **قبل** `fetch`، فانقضاؤه هنا يعني أننا لم نتلقَّ ترويسات.
   */
  it("★ لا استجابة حتى المهلة ⇒ before_response · headers_received=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        calls.push(model);
        if (calls.length === 1) return neverResponds(init.signal ?? undefined);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ model, choices: [{ delta: { content: ARABIC } }] })}\n\n`,
                ),
              );
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    await run();

    const first = FREE_MODEL_CHAIN[0]!;
    expect(fieldFor(first, "kind")).toBe("timeout");
    expect(fieldFor(first, "timeout_stage")).toBe("before_response");
    expect(fieldFor(first, "headers_received")).toBe("false");
    expect(fieldFor(first, "sse_frame_count")).toBe("0");
    expect(fieldFor(first, "content_byte_count")).toBe("0");
  });

  /**
   * ★ (٢) `first_content` — الترويسات وصلت والجسم صامت.
   *
   * هذه هي الحالة المرصودة حيًّا. كانت تُسجَّل `none`/`false` فتُقرأ خطأً على
   * أن المزوّد لم يستجب أصلًا.
   */
  it("★ ترويسات ثم صمت ⇒ first_content · headers_received=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        calls.push(model);
        if (calls.length === 1) return headersThenSilence(init.signal ?? undefined);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ model, choices: [{ delta: { content: ARABIC } }] })}\n\n`,
                ),
              );
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    await run();

    const first = FREE_MODEL_CHAIN[0]!;
    expect(fieldFor(first, "kind")).toBe("timeout");
    // ★ الإصلاح: المرحلة صادقة والترويسات معترف بوصولها
    expect(fieldFor(first, "timeout_stage")).toBe("first_content");
    expect(fieldFor(first, "headers_received")).toBe("true");
    expect(fieldFor(first, "content_byte_count")).toBe("0");
  });

  /**
   * ★ (٣) `stream_idle` — المحتوى بدأ ثم سكن البثّ.
   *
   * يُميَّز عن سابقه لأن المستخدم رأى نصًّا فعلًا، والعطل في الاستمرار لا في
   * البدء. و`content_byte_count` يشهد بذلك رقمًا لا نصًّا.
   */
  it("★ محتوى ثم سكون ⇒ stream_idle · عدّاد محتوى موجب", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        calls.push(model);
        return contentThenSilence(model, init.signal ?? undefined);
      }),
    );
    await run(PROTECTED);

    const first = FREE_MODEL_CHAIN[0]!;
    expect(fieldFor(first, "timeout_stage")).toBe("stream_idle");
    expect(fieldFor(first, "headers_received")).toBe("true");
    expect(Number(fieldFor(first, "sse_frame_count"))).toBeGreaterThan(0);
    expect(Number(fieldFor(first, "content_byte_count"))).toBeGreaterThan(0);
  });

  /**
   * ★ (٤) `none` تعني «لا مهلة» — لا «لا نعرف».
   *
   * فشلٌ فوري بحالة HTTP ليس مهلةً، فالمرحلة `none` صادقة هنا، والترويسات
   * وصلت فعلًا. وبهذا تصير `none` قابلةً للتفسير بعد أن كانت تلتبس بالمجهول.
   */
  it("★ فشل HTTP فوري ⇒ none مع headers_received=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push((JSON.parse(String(init.body)) as { model: string }).model);
        return new Response("", { status: 503 });
      }),
    );
    await run();

    const first = FREE_MODEL_CHAIN[0]!;
    expect(fieldFor(first, "status")).toBe("503");
    expect(fieldFor(first, "timeout_stage")).toBe("none");
    expect(fieldFor(first, "headers_received")).toBe("true");
  });

  it("★ لا محتوى ولا أسرار في السطر", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push((JSON.parse(String(init.body)) as { model: string }).model);
        return new Response("", { status: 503 });
      }),
    );
    await run();

    const all = logged.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const forbidden of ["عاصمة", "test-key", "Bearer", "Authorization", ARABIC]) {
      expect(all).not.toContain(forbidden);
    }
  });
});

// ════════════════════════════════════════════════════════════
//  حارس: النموذج المُخرَج بدليل توليد حيّ
// ════════════════════════════════════════════════════════════

describe("★ السلسلة بعد إخراج gpt-oss-120b:free", () => {
  /**
   * ★ الدليل هنا **طلب توليد حقيقي** لا فهرس.
   *
   * سجلّ Railway: status=404 · kind=no_free_model · headers_received=true.
   * أي أن المزوّد نفسه ردّ على مفتاحنا بأن لا نقطة نهاية — وهو ما لا يقوله
   * فهرسٌ عام قد يختلف عن الواقع (وقد أخطأتُ به مرة).
   */
  it("★ غائب عن السلسلة", () => {
    expect(FREE_MODEL_CHAIN).not.toContain("openai/gpt-oss-120b:free");
  });

  it("★ السلسلة ثلاثة بترتيبها", () => {
    expect([...FREE_MODEL_CHAIN]).toEqual([
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "openai/gpt-oss-20b:free",
    ]);
  });

  it("★ بلا تكرار وكلها مجانية", () => {
    expect(new Set(FREE_MODEL_CHAIN).size).toBe(FREE_MODEL_CHAIN.length);
    for (const m of FREE_MODEL_CHAIN) expect(m.endsWith(":free")).toBe(true);
  });
});
