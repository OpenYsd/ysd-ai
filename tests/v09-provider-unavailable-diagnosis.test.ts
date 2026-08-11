import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider, mapOpenRouterError } from "@/lib/ai/openrouter";
import { _resetCooldowns, cooldownRemainingMs, isCoolingDown } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { codeFromProviderKind } from "@/lib/ai/error-codes";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * تشخيص **فقط** — لا إصلاح ولا تعديل على شيفرة الإنتاج.
 *
 * الحادثة بعد 8a2eae2:
 *   error_code = provider_unavailable · rag_ms = 478
 *   provider_first_byte_ms = -1 · total_response_ms = 23364 · fallback_count = 0
 *
 * و`fallback_count` صار عدّادًا فعليًا، فـ0 تعني **محاولة واحدة على الأكثر**.
 * والسؤال: لماذا لم تُجرَّب بقية السلسلة؟
 */

let calls: string[] = [];

function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(
        enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const err = (status: number, body = "") => new Response(body, { status });

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

const transport = (per: (i: number, model: string) => Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    calls.push(model);
    return per(calls.length - 1, model);
  });

async function run(): Promise<{
  text: string;
  errorCode: string | null;
  attemptCount: number | null;
  outcome: string | null;
}> {
  const provider = new OpenRouterProvider();
  const out: StreamChunk[] = [];
  for await (const c of provider.streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
  })) {
    out.push(c);
  }
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    errorCode: out.find((c) => c.type === "error")?.errorCode ?? null,
    // ★ الحدث الختامي مضمون — آخر إطار meta يحمل العدّاد والنتيجة
    attemptCount: out.filter((c) => typeof c.attemptCount === "number").pop()?.attemptCount ?? null,
    outcome: out.filter((c) => typeof c.chainOutcome === "string").pop()?.chainOutcome ?? null,
  };
}

/** كما يحسبه المسار */
const fallbackCountOf = (attemptCount: number | null) => Math.max(0, (attemptCount ?? 0) - 1);

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = "200";
  process.env.YSD_TEST_IDLE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "3000";
  calls = [];
});
afterEach(() => {
  delete process.env.YSD_TEST_FIRST_BYTE_MS;
  delete process.env.YSD_TEST_IDLE_MS;
  delete process.env.YSD_TEST_CHAIN_BUDGET_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  ① دلالات كل حالة provider_unavailable
// ════════════════════════════════════════════════════════════

describe("① ما الذي يُنتج provider_unavailable؟", () => {
  it("الأنواع الأربعة تُترجم إلى provider_unavailable", () => {
    for (const kind of ["no_free_model", "overloaded", "insufficient_credit", "auth"]) {
      expect(codeFromProviderKind(kind)).toBe("provider_unavailable");
    }
    // وما عداها لا
    expect(codeFromProviderKind("rate_limit")).toBe("rate_limit");
    expect(codeFromProviderKind("timeout")).toBe("timeout");
    expect(codeFromProviderKind("network")).toBe("network_error");
    expect(codeFromProviderKind("api_error")).toBe("unknown");
  });

  it("تصنيف حالات HTTP الفعلية", () => {
    expect(mapOpenRouterError(401, "").kind).toBe("auth");
    // 403 فُصل عن auth: قد يكون حجبًا خاصًّا بنموذج فيبقى قابلًا للإعادة
    expect(mapOpenRouterError(403, "").kind).toBe("forbidden");
    expect(mapOpenRouterError(402, "").kind).toBe("insufficient_credit");
    expect(mapOpenRouterError(429, "").kind).toBe("rate_limit");
    expect(mapOpenRouterError(404, "").kind).toBe("no_free_model");
    expect(mapOpenRouterError(503, "").kind).toBe("overloaded");
    expect(mapOpenRouterError(500, "").kind).toBe("overloaded");
    // نصّ الجسم يُصنَّف حتى مع 200
    expect(mapOpenRouterError(200, "No endpoints found").kind).toBe("no_free_model");
    expect(mapOpenRouterError(200, "This model is unavailable for free").kind).toBe("no_free_model");
    // وما لا يُعرف
    expect(mapOpenRouterError(418, "teapot").kind).toBe("api_error");
  });
});

// ════════════════════════════════════════════════════════════
//  ② هل يُجرَّب النموذج التالي؟
// ════════════════════════════════════════════════════════════

describe("② سلوك السلسلة عند كل حالة", () => {
  it("★ (A) نموذج يردّ 503 ⇒ يُجرَّب التالي وينجح", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model) => (i === 0 ? err(503) : sse(ARABIC, model))),
    );
    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
    // ★ الحدث الختامي يحمل العدّاد الحقيقي مهما كان مسار النجاح
    expect(res.attemptCount).toBe(2);
    expect(fallbackCountOf(res.attemptCount)).toBe(1);
    expect(res.outcome).toBe("success");
  });

  it("★ (B) نموذج بلا endpoints (404) ⇒ يُجرَّب التالي وينجح", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model) => (i === 0 ? err(404, "No endpoints found") : sse(ARABIC, model))),
    );
    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toContain(ARABIC);
  });

  it("★ (C) عطل حساب شامل (401) ⇒ يتوقّف فورًا بعد نداء واحد", async () => {
    vi.stubGlobal("fetch", transport(() => err(401, "invalid key")));
    const res = await run();
    expect(res.errorCode).toBe("provider_unavailable");
    // ★ خطأ حساب عالمي ⇒ توقّف فوري بعد نداء واحد
    expect(calls.length).toBe(1);
    expect(res.outcome).toBe("account_auth");
    expect(fallbackCountOf(res.attemptCount)).toBe(0);
  });

  it("★ (D) كل النماذج 503 ⇒ provider_unavailable بعد استنفاد السلسلة", async () => {
    vi.stubGlobal("fetch", transport(() => err(503)));
    const res = await run();
    expect(res.errorCode).toBe("provider_unavailable");
    expect(calls.length).toBe(FREE_MODEL_CHAIN.length);
    expect(res.outcome).toBe("chain_exhausted");
    // ★ fallback_count صادق في الفشل الطرفي أيضًا
    expect(fallbackCountOf(res.attemptCount)).toBe(FREE_MODEL_CHAIN.length - 1);
  });
});

// ════════════════════════════════════════════════════════════
//  ③ التهدئة — لماذا تنكمش السلسلة
// ════════════════════════════════════════════════════════════

describe("③ أثر التهدئة على السلسلة", () => {
  /**
   * ★ المُضخِّم: 404 واحد يُبعد النموذج **ست ساعات**.
   * فطلبٌ لاحق يجد سلسلةً منكمشة، وقد لا يبقى فيها إلا نموذج واحد.
   */
  it("★ 404 يُهدّئ النموذج ست ساعات", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model) => (i === 0 ? err(404, "No endpoints") : sse(ARABIC, model))),
    );
    await run();

    const first = FREE_MODEL_CHAIN[0]!;
    expect(isCoolingDown(first)).toBe(true);
    const remaining = cooldownRemainingMs(first);
    expect(remaining).toBeGreaterThan(5.9 * 60 * 60_000);
  });

  it("★ 503 يُهدّئ دقيقتين فقط", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model) => (i === 0 ? err(503) : sse(ARABIC, model))),
    );
    await run();
    const first = FREE_MODEL_CHAIN[0]!;
    expect(isCoolingDown(first)).toBe(true);
    expect(cooldownRemainingMs(first)).toBeLessThanOrEqual(2 * 60_000);
  });

  it("★ 401 لا يُهدّئ (خطأ حساب لا نموذج)", async () => {
    vi.stubGlobal("fetch", transport(() => err(401)));
    await run();
    for (const m of FREE_MODEL_CHAIN) expect(isCoolingDown(m)).toBe(false);
    expect(calls.length).toBe(1); // ولا يستهلك السلسلة
  });

  /**
    * ★ الشكل المرصود حيًّا — بعد الإصلاح.
    *
    * كان: الجميع مهدّأ ⇒ صفر نداءات ⇒ `provider_unavailable` فوري لا يكسره
    * إلا انقضاء التهدئة. صار: سبرٌ واحد، و`attemptCount = 1` يصل المسار فعلًا
    * فيقول إن محاولةً جرت — وهو ما لم يكن `fallback_count` وحده يقوله.
    */
  it("★ 404 على الكل ⇒ سبرٌ واحد لا انهيار، وprovider_unavailable", async () => {
    // هدّئ الثلاثة الأولى بـ404 عبر طلبات سابقة
    vi.stubGlobal("fetch", transport(() => err(404, "No endpoints")));
    await run();
    calls = [];

    // الآن الرابع وحده متاح — ويفشل بـ503
    vi.stubGlobal("fetch", transport(() => err(503)));
    const res = await run();

    /**
     * ★ السياسة الجديدة: لا تنهار السلسلة إلى صفر. يُسبَر نموذج واحد —
     * الأقرب انتهاءً — فيبقى للخدمة طريق ولو كان الجميع مهدّأً.
     */
    expect(calls.length).toBe(1);
    /**
     * ★ `fallback_count = 0` هنا **صادق** لا صامت.
     *
     * كان صفرًا لأن مسار الفشل لا يُصدر `meta` أصلًا — فيستوي عنده أن تجري
     * محاولة واحدة أو أربع. الآن الحدث الختامي مضمون، والصفر يعني حرفيًا:
     * محاولة واحدة بلا احتياط. و`outcome` يفصل السبب.
     */
    expect(fallbackCountOf(res.attemptCount)).toBe(0);
    expect(res.attemptCount).toBe(1);
    expect(res.outcome).toBe("cooled_probe_failed");
    expect(res.errorCode).toBe("provider_unavailable");
  });

  /**
   * ★ معدّل السبر يحدده **الوقت** لا عدد الطلبات.
   *
   * «سبرٌ واحد لكل طلب» كان يترك المعدّل بيد الحمل: مئة طلب = مئة نداء على
   * مزوّد أعلن للتو عجزه. البوابة تفصلهما — نافذة واحدة، سبر واحد، ومَن جاء
   * داخلها يفشل سريعًا بلا نداء.
   */
  it("★ الطلبات المتكرّرة لا تطرق المزوّد: سبر واحد لكل نافذة", async () => {
    vi.stubGlobal("fetch", transport(() => err(404, "No endpoints")));
    await run();
    calls = [];

    // ثلاثة طلبات متتالية داخل نافذة واحدة والجميع مهدّأ
    for (let i = 0; i < 3; i++) await run();

    // ★ نداء واحد لا ثلاثة — ولا حلقة
    expect(calls.length).toBe(1);
  });

});

// ════════════════════════════════════════════════════════════
//  ④ انحدار تهدئة المهلة (أُدخل في ccab717)
// ════════════════════════════════════════════════════════════

describe("④ تهدئة المهلة — انحدار أُصلح", () => {
  /**
   * ★ حارس انحدار.
   *
   * قبل ccab717 كانت المهلة تُصنَّف `network` ⇒ تهدئة دقيقتين. وبعده صار لها
   * نوعها `timeout`، وسقط من جدول التهدئة سهوًا ⇒ نموذج يتلكّأ يُجرَّب في كل
   * طلب. أُعيد الآن، وهذا الاختبار يمنع سقوطه ثانية.
   */
  it("★ مهلة أول بايت تُنتج تهدئة عابرة", async () => {
    const stalling = (signal?: AbortSignal) =>
      new Response(
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        calls.push(model);
        return calls.length === 1
          ? stalling(init.signal ?? undefined)
          : sse(ARABIC, model);
      }),
    );

    await run();

    const first = FREE_MODEL_CHAIN[0]!;
    // eslint-disable-next-line no-console
    console.log(`[قياس] تهدئة بعد مهلة: ${isCoolingDown(first) ? "نعم" : "لا"}`);
    // ★ المهلة عادت إلى منظومة التهدئة: دقيقتان كعطل مزوّد عابر
    expect(isCoolingDown(first)).toBe(true);
    expect(cooldownRemainingMs(first)).toBeLessThanOrEqual(2 * 60_000);
  });
});
