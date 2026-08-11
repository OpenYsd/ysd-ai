import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { GroqProvider, mapGroqError, GROQ_MIN_ATTEMPT_MS } from "@/lib/ai/groq";
import { GROQ_MODEL_CHAIN } from "@/lib/ai/groq-models";
import { getFallbackProvider, listModelOptions, resolveProviderForModel } from "@/lib/ai/registry";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * Groq — مزوّد احتياطي مستقل بعد فشل سلسلة OpenRouter بالكامل.
 *
 * الاختبارات تُشغّل المحوّل الحقيقي بنقلٍ مُحاكى، وتقرأ المسار الحقيقي لما لا
 * يمكن تشغيله هنا (حدود الميزانية وقائمة السماح).
 */

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const KEY = "gsk-test-not-a-real-key";
const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

let calls: { model: string; body: Record<string, unknown> }[] = [];
let logs: string[] = [];

function sse(text: string, withUsage = true): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(": groq keep-alive\n\n"));
        c.enqueue(
          enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
        );
        if (withUsage) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ x_groq: { usage: { prompt_tokens: 12, completion_tokens: 8 } } })}\n\n`,
            ),
          );
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function stalling(signal?: AbortSignal): Response {
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

const err = (status: number, headers: Record<string, string> = {}) =>
  new Response("{\"error\":{\"message\":\"groq internal detail\"}}", { status, headers });

const transport = (per: (i: number, model: string, signal?: AbortSignal) => Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ model: String(body.model), body });
    return per(calls.length - 1, String(body.model), init.signal ?? undefined);
  });

async function runGroq(extra?: Record<string, unknown>): Promise<{
  text: string;
  chunks: StreamChunk[];
  errorCode: string | null;
}> {
  const chunks: StreamChunk[] = [];
  for await (const c of new GroqProvider().streamChat({
    modelId: "ysd/free",
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
    ...extra,
  })) {
    chunks.push(c);
  }
  return {
    chunks,
    text: chunks.filter((c) => c.type === "text").map((c) => c.text).join(""),
    errorCode: chunks.find((c) => c.type === "error")?.errorCode ?? null,
  };
}

beforeEach(() => {
  process.env.GROQ_API_KEY = KEY;
  process.env.YSD_TEST_GROQ_FIRST_BYTE_MS = "250";
  process.env.YSD_TEST_GROQ_IDLE_MS = "250";
  process.env.YSD_TEST_GROQ_CHAIN_BUDGET_MS = "4000";
  // حدّ بدء المحاولة مصغّر ليتناسب مع الميزانية المصغّرة — القيمة الإنتاجية سليمة
  process.env.YSD_TEST_GROQ_MIN_ATTEMPT_MS = "50";
  calls = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  delete process.env.GROQ_API_KEY;
  for (const k of [
    "YSD_TEST_GROQ_FIRST_BYTE_MS",
    "YSD_TEST_GROQ_IDLE_MS",
    "YSD_TEST_GROQ_CHAIN_BUDGET_MS",
    "YSD_TEST_GROQ_MIN_ATTEMPT_MS",
  ]) {
    delete process.env[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  P · E — الرؤية والتهيئة
// ════════════════════════════════════════════════════════════

describe("P/E — مُهيّأ لكنه مخفيّ", () => {
  it("★ (P) Groq مخفيّ عن قائمة المستخدم", () => {
    const ids = listModelOptions().map((m) => m.id);
    for (const m of GROQ_MODEL_CHAIN) expect(ids).not.toContain(m);
  });

  it("★ (P) لا يمكن توجيه طلب مستخدم إليه مباشرةً", () => {
    for (const m of GROQ_MODEL_CHAIN) {
      const p = resolveProviderForModel(m);
      expect(p?.id).not.toBe("groq");
    }
  });

  it("★ (P) ومع ذلك يستدعيه المسار احتياطًا", () => {
    const fb = getFallbackProvider();
    expect(fb).not.toBeNull();
    expect(fb!.id).toBe("groq");
  });

  it("★ (E) بلا مفتاح ⇒ الاحتياط معطّل بلا فشل إقلاع", () => {
    delete process.env.GROQ_API_KEY;
    expect(new GroqProvider().isConfigured()).toBe(false);
    expect(getFallbackProvider()).toBeNull();
  });

  it("★ المفتاح ليس NEXT_PUBLIC ولا يُقرأ من العميل", () => {
    const src = readFileSync("lib/ai/groq.ts", "utf8");
    expect(src).not.toContain("NEXT_PUBLIC");
    expect(src).toContain("process.env.GROQ_API_KEY");
  });
});

// ════════════════════════════════════════════════════════════
//  B · C · D · F · G — سلوك السلسلة
// ════════════════════════════════════════════════════════════

describe("B–G — سلسلة Groq", () => {
  it("★ (B) النموذج الأول ينجح ⇒ نص + usage + done", async () => {
    vi.stubGlobal("fetch", transport(() => sse(ARABIC)));
    const r = await runGroq();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(GROQ_MODEL_CHAIN[0]);
    expect(r.text).toBe(ARABIC);
    expect(r.chunks.some((c) => c.type === "usage")).toBe(true);
    expect(r.chunks.at(-1)!.type).toBe("done");
    expect(r.chunks.find((c) => c.type === "meta")?.model).toBe(GROQ_MODEL_CHAIN[0]);
  });

  it("★ (C) 429 على الأول ⇒ الثاني ينجح، وretry-after بلا نوم", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i) => (i === 0 ? err(429, { "retry-after": "30" }) : sse(ARABIC))),
    );
    const t0 = Date.now();
    const r = await runGroq();
    const elapsed = Date.now() - t0;

    expect(calls.map((c) => c.model)).toEqual([...GROQ_MODEL_CHAIN]);
    expect(r.text).toBe(ARABIC);
    // ★ (O) لم ننم 30 ثانية — احترام Retry-After بالإبلاغ لا بالتعطيل
    expect(elapsed).toBeLessThan(3000);
    expect(logs.join("\n")).toContain("retry_after_ms=30000");
  });

  it("★ (D) الجميع يفشل ⇒ خطأ مصنّف بلا نصّ المزوّد", async () => {
    vi.stubGlobal("fetch", transport(() => err(503)));
    const r = await runGroq();

    expect(calls).toHaveLength(2);
    expect(r.errorCode).toBe("provider_unavailable");
    const msg = r.chunks.find((c) => c.type === "error")?.error ?? "";
    expect(msg).toMatch(/[؀-ۿ]/);
    expect(msg).not.toContain("groq internal detail");
  });

  it("★ (F) المهلة محدودة ولا تتجاوز الميزانية", async () => {
    process.env.YSD_TEST_GROQ_CHAIN_BUDGET_MS = "600";
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const t0 = Date.now();
    await runGroq();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("★ (G) إلغاء المستخدم ⇒ توقّف فوري بلا محاولة تالية", async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => {
        setTimeout(() => ac.abort(), 40);
        return stalling(signal);
      }),
    );
    const r = await runGroq({ signal: ac.signal });

    expect(calls).toHaveLength(1); // لا نموذج ثانٍ بعد الإلغاء
    expect(r.errorCode).toBeNull(); // ولا رسالة خطأ: الإلغاء اختياره
  });

  it("★ ميزانية غير كافية ⇒ لا محاولة أصلًا", async () => {
    vi.stubGlobal("fetch", transport(() => sse(ARABIC)));
    await runGroq({ budgetMs: 10 }); // دون حدّ بدء المحاولة
    expect(calls).toHaveLength(0);
    // والقيمة الإنتاجية للحدّ لم تُمسّ
    expect(GROQ_MIN_ATTEMPT_MS).toBe(5_000);
  });
});

// ════════════════════════════════════════════════════════════
//  H — Evidence
// ════════════════════════════════════════════════════════════

describe("H — الموجّه يصل Groq حرفيًا", () => {
  it("★ (H) systemPrompt يُمرَّر بايتًا ببايت", async () => {
    const prompt = "تعليمات Evidence <<<BEGIN_YSD_EVIDENCE_V1>>> مع مقاطع المصدر";
    vi.stubGlobal("fetch", transport(() => sse(ARABIC)));
    await runGroq({ systemPrompt: prompt });

    const msgs = calls[0]!.body.messages as { role: string; content: string }[];
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe(prompt); // حرفيًا لا معدَّلًا
    expect(msgs[1]!.role).toBe("user");
  });

  it("★ البثّ مُفعَّل والاستهلاك مطلوب صراحةً", async () => {
    vi.stubGlobal("fetch", transport(() => sse(ARABIC)));
    await runGroq();
    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body.stream_options).toEqual({ include_usage: true });
  });
});

// ════════════════════════════════════════════════════════════
//  M — الأسرار
// ════════════════════════════════════════════════════════════

describe("M — المفتاح لا يظهر قط", () => {
  it("★ (M) لا في السجل ولا في الإطارات ولا في رسالة الخطأ", async () => {
    vi.stubGlobal("fetch", transport(() => err(401)));
    const r = await runGroq();

    const everything = JSON.stringify(r.chunks) + "\n" + logs.join("\n");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("Bearer");
    expect(everything).not.toContain("groq internal detail");
    expect(everything).not.toContain("عاصمة"); // ولا محتوى المستخدم
  });

  it("★ (N) السجل يميّز المزوّد بلا محتوى", async () => {
    vi.stubGlobal("fetch", transport(() => err(503)));
    await runGroq();
    const line = logs.find((l) => l.includes("[groq] attempt failed")) ?? "";
    expect(line).toContain("attempt_index=");
    expect(line).toContain("kind=");
    expect(line).toContain("headers_received=");
    expect(line).not.toContain(ARABIC);
  });
});

// ════════════════════════════════════════════════════════════
//  تصنيف الأخطاء
// ════════════════════════════════════════════════════════════

describe("تصنيف أخطاء Groq", () => {
  it("★ الحالات تُترجم إلى التصنيف الداخلي", () => {
    expect(mapGroqError(401, null).kind).toBe("auth");
    expect(mapGroqError(402, null).kind).toBe("insufficient_credit");
    expect(mapGroqError(429, null).kind).toBe("rate_limit");
    expect(mapGroqError(500, null).kind).toBe("overloaded");
    expect(mapGroqError(503, null).kind).toBe("overloaded");
    expect(mapGroqError(404, null).kind).toBe("no_free_model");
    expect(mapGroqError(null, null).kind).toBe("network");
    // ★ (S) خطأ الطلب لا المزوّد — لا يستحق مزوّدًا آخر
    expect(mapGroqError(400, null).kind).toBe("api_error");
    expect(mapGroqError(413, null).kind).toBe("api_error");
  });

  it("★ Retry-After يُقرأ ثوانيَ وتاريخًا", () => {
    expect(mapGroqError(429, "30").retryAfterMs).toBe(30_000);
    expect(mapGroqError(429, "غير صالح").retryAfterMs).toBeNull();
  });

  it("★ خطأ حساب ⇒ لا يُجرَّب النموذج الثاني", async () => {
    vi.stubGlobal("fetch", transport(() => err(401)));
    await runGroq();
    expect(calls).toHaveLength(1);
  });

  it("★ (S) خطأ طلب ⇒ لا يُجرَّب النموذج الثاني", async () => {
    vi.stubGlobal("fetch", transport(() => err(400)));
    await runGroq();
    expect(calls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════
//  A · J · K · L · Q · R · S · T — عقد المسار
// ════════════════════════════════════════════════════════════

describe("عقد المسار: احتياط المزوّدين", () => {
  it("★ (A) الاحتياط مشروط بغياب أي نص", () => {
    expect(ROUTE).toContain("if (gotText || clientAborted || shortCircuit || req.signal.aborted) break;");
  });

  it("★ (R) خطأ حساب OpenRouter ينتقل إلى Groq", () => {
    // auth وinsufficient_credit كلاهما provider_unavailable — داخل القائمة
    expect(ROUTE).toContain('"provider_unavailable"');
    expect(ROUTE).toContain("PROVIDER_FALLBACK_CODES");
  });

  it("★ (S) قائمة سماح لا منع — فأي رمز جديد لا ينتقل", () => {
    const block = ROUTE.slice(
      ROUTE.indexOf("const PROVIDER_FALLBACK_CODES"),
      ROUTE.indexOf("const PROVIDER_FALLBACK_CODES") + 400,
    );
    expect(block).toContain("provider_unavailable");
    expect(block).toContain("timeout");
    expect(block).toContain("rate_limit");
    expect(block).toContain("network_error");
    expect(block).not.toContain("unknown");
    expect(block).not.toContain("quality_guard");
  });

  it("★ (Q) سقف مرحلة المزوّدين 65 ثانية والحدود الأربعة سليمة", () => {
    expect(ROUTE).toContain("const PROVIDER_FALLBACK_BUDGET_MS = 65_000;");
    expect(ROUTE).toContain("const TOTAL_REQUEST_BUDGET_MS = 110_000;");
    // الميزانية أضيق الثلاثة
    expect(ROUTE).toContain("PROVIDER_FALLBACK_BUDGET_MS - phaseElapsed");
    expect(ROUTE).toContain("SAVE_RESERVE_MS");
  });

  it("★ (T) تصفير الحالة دالة واحدة تغطي كل ما يتسرّب", () => {
    const fn = ROUTE.slice(
      ROUTE.indexOf("const resetAttemptState = () => {"),
      ROUTE.indexOf("for (let pi = 0; pi < sequence.length; pi++)"),
    );
    for (const field of [
      "assistantText",
      "evidenceStream",
      "pendingUsage",
      "actualModelId",
      "lastErrorCode",
      "providerFirstByteMs",
      "usageFrameCount",
      "completionStatus",
      "attemptCount",
    ]) {
      expect(fn).toContain(field);
    }
  });

  it("★ (J/K/L) المحاسبة مرة واحدة خارج حلقة المزوّدين", () => {
    const slotIdx = ROUTE.indexOf("await acquireSlot(");
    const budgetIdx = ROUTE.indexOf("await reserveChatBudget(");
    const loopIdx = ROUTE.indexOf("for (let pi = 0; pi < sequence.length; pi++)");
    expect(slotIdx).toBeGreaterThan(0);
    expect(slotIdx).toBeLessThan(loopIdx); // الفتحة قبل الحلقة ⇒ واحدة للطلب
    expect(budgetIdx).toBeLessThan(loopIdx);
    expect((ROUTE.match(/await acquireSlot\(/g) ?? []).length).toBe(1);
    expect((ROUTE.match(/await reserveChatBudget\(/g) ?? []).length).toBe(1);
  });

  it("★ (J) استهلاك محاولة فاشلة لا يُحاسَب عليه", () => {
    const fn = ROUTE.slice(
      ROUTE.indexOf("const resetAttemptState = () => {"),
      ROUTE.indexOf("for (let pi = 0; pi < sequence.length; pi++)"),
    );
    expect(fn).toContain("pendingUsage = null;");
  });

  it("★ الخطأ يُحتجز حتى يُحسم ألّا مزوّد بعده", () => {
    expect(ROUTE).toContain("pendingError = { error: chunk.error, code: lastErrorCode };");
    expect(ROUTE).toContain("if (pendingError) {");
  });

  it("★ (N) قياسات المزوّد تُسجَّل وتُحفظ", () => {
    expect(ROUTE).toContain("selected_provider=${selectedProvider}");
    expect(ROUTE).toContain("provider_fallback_count=");
    expect(ROUTE).toContain("meta.provider = selectedProvider;");
  });
});

// ════════════════════════════════════════════════════════════
//  انحدار: التفكير — مقيسٌ على بثّ Groq الحقيقي
// ════════════════════════════════════════════════════════════

/**
 * أول تحقّق حيّ (2026-08-11) كشف أن نماذج `gpt-oss` نماذج تفكير: وصلت 24
 * إطارًا بصفر بايت محتوى فصُنّف الردّ `empty_completion` وهو ليس كذلك.
 * والقياس حسم السبب: الجواب احتاج 26 رمز إكمال والسقف كان 24.
 *
 * هذه الاختبارات تحرس المعاملات التي أصلحته، وتحرس ألّا يتسرّب التفكير.
 */
describe("انحدار: معاملات التفكير", () => {
  const REASONING = "خطوة تفكير داخلية لا يجوز أن تصل المستخدم إطلاقًا";

  /** إطارات تفكير أولًا ثم محتوى — كما يبثّ نموذج تفكير فعلًا */
  function reasoningThenContent(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          for (let i = 0; i < 3; i++) {
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning: REASONING } }] })}\n\n`,
              ),
            );
          }
          c.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "YSD" } }] })}\n\n`),
          );
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: " GROQ OK" } }] })}\n\n`,
            ),
          );
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  it("★ الطلب يُطفئ التفكير ويستعمل سقف الإكمال", async () => {
    vi.stubGlobal("fetch", transport(() => sse(ARABIC)));
    await runGroq({ maxTokens: 128 });

    const body = calls[0]!.body;
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_effort).toBe("low");
    // ★ سقف **الإكمال** لا سقف الرموز الكلي — الأول لا يخلط التفكير بالجواب
    expect(body.max_completion_tokens).toBe(128);
    expect(body.max_tokens).toBeUndefined();
  });

  it("★ إطارات تفكير ثم محتوى ⇒ المحتوى يصل ولا empty_completion", async () => {
    vi.stubGlobal("fetch", transport(() => reasoningThenContent()));
    const r = await runGroq();

    expect(calls).toHaveLength(1); // نجح من أول نموذج
    expect(r.text).toBe("YSD GROQ OK");
    expect(r.errorCode).toBeNull();
    expect(r.chunks.at(-1)!.type).toBe("done");
  });

  it("★ التفكير لا يتسرّب: لا في البثّ ولا في السجل", async () => {
    vi.stubGlobal("fetch", transport(() => reasoningThenContent()));
    const r = await runGroq();

    const everything = JSON.stringify(r.chunks) + "\n" + logs.join("\n");
    expect(everything).not.toContain(REASONING);
    expect(everything).not.toContain("reasoning:");
    // ولا يدخل عقد البثّ حقلًا
    for (const c of r.chunks) expect(Object.keys(c)).not.toContain("reasoning");
  });

  it("★ تفكير بلا محتوى ⇒ empty_completion لكنه **قابل للتمييز**", async () => {
    vi.stubGlobal(
      "fetch",
      transport(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                const enc = new TextEncoder();
                c.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: REASONING } }] })}\n\n`,
                  ),
                );
                c.enqueue(enc.encode("data: [DONE]\n\n"));
                c.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    await runGroq();

    const line = logs.find((l) => l.includes("[groq] attempt failed")) ?? "";
    // ★ الفرق الذي أضاع أول تحقّق حيّ: «فكّر ولم يُجب» لا «لم يُرجع شيئًا»
    expect(line).toContain("kind=empty_completion");
    expect(line).toContain("reasoning_present=true");
    expect(line).toContain("content_byte_count=0");
    expect(line).not.toContain(REASONING);
  });
});
