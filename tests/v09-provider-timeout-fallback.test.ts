import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  CHAIN_BUDGET_MS,
  FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_TIMEOUT_MS,
} from "@/lib/ai/openrouter";
import { EVIDENCE_MODE_INSTRUCTIONS } from "@/lib/evidence/evidence-prompt";
import {
  EVIDENCE_END,
  EVIDENCE_START,
  extractEvidenceEnvelope,
} from "@/lib/evidence/evidence-envelope";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * العطل الحيّ: مهلة بلا أول بايت وبلا احتياط (المحادثة 47eb4342…).
 *
 *   error_code = timeout · provider_first_byte_ms = -1 · fallback_count = 0
 *   total_response_ms = 109769 ثم 73820 · لا رسالة مساعد · لا مقعد عالق
 *
 * و109769 ≈ سقف الطلب الكلي (110 ث) — أي أن الذي قتل الطلب هو **المسار** لا
 * المزوّد. فمهلة المزوّد (25 ث) لم تفعل شيئًا رغم أنه لم يُرسل نصًّا قط.
 *
 * السبب المُشتبه به هنا يُختبر لا يُفترض: مزوّد يُرسل نبضات إبقاء SSE
 * (`: OPENROUTER PROCESSING`) بلا أي دفعة نصّ. كل نبضة **بايتٌ يصل**، ومهلة
 * الخمول تُعاد تسليحها عند كل بايت — فلا تنقضي أبدًا.
 */

/** بثّ نبضات إبقاء فقط — بلا أي `data:` ذي محتوى، إلى الأبد */
function keepAliveOnly(signal?: AbortSignal, intervalMs = 20): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      timer = setInterval(() => {
        try {
          c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
        } catch {
          /* أُغلق */
        }
      }, intervalMs);
      /**
       * كما يفعل `fetch` الحقيقي: الإجهاض يُخطئ الجسم فتُرفض القراءة.
       * بدون هذا يختبر المحاكي نفسه لا الشيفرة.
       */
      signal?.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          c.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* أُغلق */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** بثّ نصّ سليم */
function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of text.match(/.{1,30}/gs) ?? []) {
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

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

let calls: string[] = [];

async function run(): Promise<{
  text: string;
  models: string[];
  errorCode: string | null;
  elapsedMs: number;
}> {
  const provider = new OpenRouterProvider();
  const out: StreamChunk[] = [];
  const t0 = Date.now();
  for await (const c of provider.streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
  })) {
    out.push(c);
  }
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    models: out.filter((c) => c.type === "meta").map((c) => c.model as string),
    errorCode: out.find((c) => c.type === "error")?.errorCode ?? null,
    elapsedMs: Date.now() - t0,
  };
}

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  // مهل قصيرة كي لا يطول CI — النِّسب محفوظة
  process.env.YSD_TEST_IDLE_MS = "300";
  process.env.YSD_TEST_FIRST_BYTE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "3000";
  calls = [];
});

afterEach(() => {
  delete process.env.YSD_TEST_IDLE_MS;
  delete process.env.YSD_TEST_FIRST_BYTE_MS;
  delete process.env.YSD_TEST_CHAIN_BUDGET_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const transport = (per: (i: number, model: string, signal?: AbortSignal) => Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    calls.push(model);
    return per(calls.length - 1, model, init.signal ?? undefined);
  });

// ════════════════════════════════════════════════════════════

describe("① نبضات الإبقاء لا تُعدّ تقدّمًا", () => {
  /**
   * ★ جوهر العطل: نموذج يُرسل نبضات فقط. قبل الإصلاح كانت `armIdle` تُعاد
   * تسليحها عند كل نبضة فلا تنقضي المهلة أبدًا، فيبقى الطلب معلّقًا حتى يقتله
   * سقف المسار — بلا احتياط وبلا رسالة.
   */
  it("★ نموذج يُرسل نبضات فقط ⇒ يُهجَر ويُجرَّب التالي", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) => (i === 0 ? keepAliveOnly(sig) : sse(ARABIC, model))),
    );

    const res = await run();

    // انتقل فعلًا إلى النموذج الثاني
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(FREE_MODEL_CHAIN[0]);
    expect(calls[1]).toBe(FREE_MODEL_CHAIN[1]);
    // ووصل الرد
    expect(res.text).toBe(ARABIC);
    expect(res.errorCode).toBeNull();
  });

  it("★ لا يُستهلك السقف الكلي: يُهجَر عند مهلة أول بايت لا بعدها", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) => (i === 0 ? keepAliveOnly(sig) : sse(ARABIC, model))),
    );

    const res = await run();

    // مهلة أول بايت 250مل + محاولة ناجحة — لا انتظار ميزانية السلسلة كلها
    expect(res.elapsedMs).toBeLessThan(2_000);
  });

  it("★ نموذج صامت تمامًا (بلا أي بايت) يُهجَر كذلك", async () => {
    const silent = (signal?: AbortSignal) =>
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
      transport((i, model, sig) => (i === 0 ? silent(sig) : sse(ARABIC, model))),
    );

    const res = await run();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.text).toBe(ARABIC);
  });
});

describe("② البثّ الحقيقي لا يُقتل", () => {
  /** بثّ بطيء لكنه متدفّق: كل دفعة نصّ تُعيد تسليح مهلة الخمول */
  it("★ بثّ بطيء متدفّق يكتمل ولا يُهجَر", async () => {
    const slow = (model: string) => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          const enc = new TextEncoder();
          for (const part of ["هذه ", "إجابة ", "عربية ", "سليمة ", "تمامًا."]) {
            await new Promise((r) => setTimeout(r, 150)); // أبطأ من مهلة أول بايت
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ model, choices: [{ delta: { content: part } }] })}\n\n`,
              ),
            );
          }
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    vi.stubGlobal("fetch", transport((_i, model) => slow(model)));

    const res = await run();
    expect(res.text).toBe("هذه إجابة عربية سليمة تمامًا.");
    expect(calls).toHaveLength(1); // بلا احتياط
  });

  /** نبضات ثم نصّ **قبل** انقضاء مهلة أول بايت ⇒ يُكمل */
  it("★ نبضات ثم نصّ سريع ⇒ يُكمل بلا هجر", async () => {
    const mixed = (model: string) => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(": PROCESSING\n\n"));
          await new Promise((r) => setTimeout(r, 80));
          c.enqueue(enc.encode(": PROCESSING\n\n"));
          await new Promise((r) => setTimeout(r, 80));
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ model, choices: [{ delta: { content: ARABIC } }] })}\n\n`,
            ),
          );
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    vi.stubGlobal("fetch", transport((_i, model) => mixed(model)));

    const res = await run();
    expect(res.text).toBe(ARABIC);
    expect(calls).toHaveLength(1);
  });
});

describe("③ حدود الاحتياط", () => {
  it("★ كل النماذج صامتة ⇒ خطأ عام بلا تعليق", async () => {
    vi.stubGlobal("fetch", transport((_i, _m, sig) => keepAliveOnly(sig)));

    const res = await run();
    expect(res.errorCode).toBe("timeout");
    expect(res.text).toBe("");
    // جُرّب أكثر من نموذج ثم توقّف — لا حلقة لا نهائية
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(FREE_MODEL_CHAIN.length);
  });

  it("★ ميزانية السلسلة تمنع محاولة جديدة بعد نفادها", async () => {
    process.env.YSD_TEST_CHAIN_BUDGET_MS = "400";
    vi.stubGlobal("fetch", transport((_i, _m, sig) => keepAliveOnly(sig)));

    const res = await run();
    expect(res.errorCode).toBe("timeout");
    // الميزانية 400مل ومهلة أول بايت 250مل ⇒ محاولتان على الأكثر
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("★ إجهاض العميل لا يُشغّل احتياطًا", async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push((JSON.parse(String(init.body)) as { model: string }).model);
        setTimeout(() => ac.abort(), 30);
        return keepAliveOnly(init.signal ?? undefined);
      }),
    );

    const provider = new OpenRouterProvider();
    const out: StreamChunk[] = [];
    for await (const c of provider.streamChat({
      modelId: YSD_FREE_MODEL_ID,
      messages: [{ role: "user", content: "سؤال" }],
      signal: ac.signal,
    })) {
      out.push(c);
    }

    // نموذج واحد جُرّب — الإجهاض ليس فشل مزوّد
    expect(calls).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ④ الفصل بين المهل الأربع — قراءة القيم الفعلية
// ════════════════════════════════════════════════════════════

describe("④ ميزانية المهل", () => {
  const src = readFileSync(resolvePath("lib/ai/openrouter.ts"), "utf8");
  const route = readFileSync(resolvePath("app/api/chat/route.ts"), "utf8");

  it("★ المهل الأربع معرَّفة ومنفصلة", () => {
    // أول بايت — جديدة
    expect(src).toContain("const FIRST_BYTE_TIMEOUT_MS = 20_000");
    // خمول البثّ — كما كانت
    expect(src).toContain("const PROVIDER_TIMEOUT_MS = 25_000");
    // ميزانية السلسلة — كما كانت
    expect(src).toContain("const CHAIN_BUDGET_MS = 45_000");
    // سقف الطلب الكلي — كما كان
    expect(route).toContain("const TOTAL_REQUEST_BUDGET_MS = 110_000");
  });

  /** 20 + 25 = 45: فشل أول بايت يترك محاولة كاملة داخل الميزانية القائمة */
  it("★ القيم متّسقة: أول بايت + خمول = ميزانية السلسلة", () => {
    expect(FIRST_BYTE_TIMEOUT_MS + PROVIDER_TIMEOUT_MS).toBe(CHAIN_BUDGET_MS);
  });

  /**
   * تشدّد لاحقًا: كان التسليح على «إطار `data:`»، وثبت أن المزوّد يفتتح البثّ
   * بإطار بلا نصّ (`delta.role`)، فكان يُرقّي المؤقّت إلى مهلة الخمول قبل أن
   * يبدأ التوليد. الشرط الآن **محتوى فعلي**.
   */
  it("★ لا نبضة الإبقاء ولا الإطار الفارغ يُعيدان تسليح المؤقّت", () => {
    expect(src).not.toMatch(/if \(done\) break;\s*armIdle\(\);/);
    expect(src).not.toMatch(/markProtocolFrame/);
    expect(src).toMatch(/if \(!text\) continue;[\s\S]{0,160}markFirstContent\(\);/);
  });

  it("★ مهلة أول بايت لا تُعاد تسليحها قبل أول محتوى", () => {
    expect(src).toMatch(/const armIdle = \(\) => \{\s*if \(!sawContent\) return;/);
  });

  /** ★ الميزانية موعد نهائي يُربط بكل محاولة — لا شرط يُفحص بينها وحدها */
  it("★ ميزانية السلسلة إشارة إجهاض حقيقية", () => {
    expect(src).toMatch(/const chainDeadline = new AbortController\(\)/);
    expect(src).toMatch(/chainSignal\?\.addEventListener\("abort", onChainDeadline\)/);
    // ولا تبتر بثًّا بدأ محتواه
    expect(src).toMatch(/const onChainDeadline = \(\) => \{\s*if \(!sawContent\) timeout\.abort\(\);/);
  });

  it("★ ميزانية السلسلة تُفحص قبل كل محاولة تالية", () => {
    expect(src).toMatch(/if \(i > 0 && Date\.now\(\) - chainStartedAt >= chainBudgetMs\(\)\)/);
  });
});

// ════════════════════════════════════════════════════════════
//  ⑤ ما لم يتغيّر — الميزانية والمقعد وEvidence
// ════════════════════════════════════════════════════════════

describe("⑤ المحاسبة والمقعد لم يتغيّرا", () => {
  const route = readFileSync(resolvePath("app/api/chat/route.ts"), "utf8");

  it("★ المقعد يُحرَّر في finally — مسار واحد لكل خروج", () => {
    expect(route).toMatch(/finally \{[\s\S]{0,600}await slot\.release\(\)/);
    expect((route.match(/slot\.release\(\)/g) ?? []).length).toBeGreaterThan(1);
  });

  it("★ الاستهلاك يُكتب صفًّا واحدًا ويُسوّى مرة", () => {
    expect((route.match(/from\("usage_events"\)\s*\.insert/g) ?? []).length).toBe(1);
    expect((route.match(/finalizeChatBudget\(/g) ?? []).length).toBe(1);
  });

  it("★ الحجز يُحرَّر حين لا استهلاك", () => {
    expect(route).toMatch(/\} else \{[\s\S]{0,200}await releaseChatBudget\(requestId\)/);
  });

  it("★ رسالة المستخدم تُحفظ مرة واحدة خلف حارس الازدواج", () => {
    // claimRequestDurable قبل أي إدراج — والاحتياط داخل streamChat لا يمرّ بها
    expect(route).toMatch(/claimRequestDurable\([\s\S]{0,200}\)/);
    expect((route.match(/role: "user", content: message/g) ?? []).length).toBe(1);
  });

  it("★ Evidence وsourceRegistry وsourceVocabulary تُمرَّر مرة واحدة للمزوّد", () => {
    expect((route.match(/sourceVocabulary,/g) ?? []).length).toBe(1);
    expect((route.match(/provider\.streamChat\(/g) ?? []).length).toBe(1);
    expect(route).toMatch(/EVIDENCE_MODE_INSTRUCTIONS/);
  });
});

describe("⑥ الاحتياط الناجح يُبقي مسار الأدلة سليمًا", () => {
  it("★ نبضات ثم احتياط ملتزم ⇒ الغلاف يصل ويُستخرج", async () => {
    const ENVELOPE =
      `${EVIDENCE_START}\n{"quotes":[{"marker":1,"quote":"اقتباس حرفي طويل بما يكفي"}]}\n${EVIDENCE_END}`;
    const withEvidence = `${ARABIC}\n${ENVELOPE}`;

    vi.stubGlobal(
      "fetch",
      transport((i, model, sig) => (i === 0 ? keepAliveOnly(sig) : sse(withEvidence, model))),
    );

    const provider = new OpenRouterProvider();
    const out: StreamChunk[] = [];
    const seenPrompts: string[] = [];
    for await (const c of provider.streamChat({
      modelId: YSD_FREE_MODEL_ID,
      messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
      systemPrompt: `موجّه\n\n${EVIDENCE_MODE_INSTRUCTIONS}`,
    })) {
      out.push(c);
      void seenPrompts;
    }

    const text = out.filter((c) => c.type === "text").map((c) => c.text).join("");
    const env = extractEvidenceEnvelope(text);
    expect(env.status).toBe("valid");
    expect(env.quoteCandidates).toHaveLength(1);
    // وسقط إلى النموذج الثاني فعلًا
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("★ تعليمات Evidence تصل للاحتياط حرفيًا بعد مهلة أول بايت", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(String(init.body));
        const model = (JSON.parse(String(init.body)) as { model: string }).model;
        calls.push(model);
        return bodies.length === 1
          ? keepAliveOnly(init.signal ?? undefined)
          : sse(ARABIC, model);
      }),
    );

    const provider = new OpenRouterProvider();
    for await (const _c of provider.streamChat({
      modelId: YSD_FREE_MODEL_ID,
      messages: [{ role: "user", content: "سؤال" }],
      systemPrompt: `موجّه\n\n${EVIDENCE_MODE_INSTRUCTIONS}`,
    })) {
      void _c;
    }

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const sysOf = (b: string) =>
      (JSON.parse(b) as { messages: { role: string; content: string }[] }).messages.find(
        (m) => m.role === "system",
      )?.content ?? "";
    expect(sysOf(bodies[1]!)).toBe(sysOf(bodies[0]!));
    expect(sysOf(bodies[1]!)).toContain(EVIDENCE_MODE_INSTRUCTIONS);
  });
});
