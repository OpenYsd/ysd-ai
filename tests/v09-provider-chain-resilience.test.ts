import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import {
  _resetCooldowns,
  cooldownRemainingMs,
  isCoolingDown,
  probeGateRemainingMs,
} from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import type { ChatRequest, StreamChunk } from "@/lib/ai/types";

/**
 * صمود سلسلة المزوّد (v0.9.0) — ما لم تغطّه مجموعة التشخيص.
 *
 * مجموعة `v09-provider-unavailable-diagnosis` تحرس الحالات المرصودة حيًّا.
 * وهذه تحرس ما بقي من الثوابت: اختيار السبر، أخطاء الحساب العالمية، وصدق
 * العدّاد حين لا يقع نداءٌ أصلًا.
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

/** ردٌّ يفتح القناة ثم لا يرسل شيئًا — حتى يقطعه AbortSignal فعلًا */
function stalling(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* أُغلق سلفًا */
          }
        });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const err = (status: number, body = "") => new Response(body, { status });

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

const transport = (per: (i: number, model: string, signal?: AbortSignal) => Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    calls.push(model);
    return per(calls.length - 1, model, init.signal ?? undefined);
  });

async function run(extra?: Partial<ChatRequest>): Promise<{
  text: string;
  errorCode: string | null;
  attemptCount: number | null;
  outcome: string | null;
  providerCalls: number | null;
}> {
  const out: StreamChunk[] = [];
  for await (const c of new OpenRouterProvider().streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
    ...extra,
  })) {
    out.push(c);
  }
  const last = <K extends keyof StreamChunk>(k: K) =>
    out.filter((c) => c[k] !== undefined).pop()?.[k] ?? null;
  return {
    text: out.filter((c) => c.type === "text").map((c) => c.text).join(""),
    errorCode: out.find((c) => c.type === "error")?.errorCode ?? null,
    attemptCount: last("attemptCount") as number | null,
    outcome: last("chainOutcome") as string | null,
    providerCalls: last("providerCalls") as number | null,
  };
}

/** كما يحسبه المسار حرفيًا */
const fallbackCountOf = (attemptCount: number | null) => Math.max(0, (attemptCount ?? 0) - 1);

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = "200";
  process.env.YSD_TEST_IDLE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "3000";
  /**
   * البوابة مفتوحة افتراضيًا هنا: أقسام ①–④ تقيس **الاختيار والعدّاد**، والتقنين
   * يخصّها بشيء. قسم ⑤ وحده يغلقها بنافذة مصغّرة ويقيسها مباشرة.
   */
  process.env.YSD_TEST_PROBE_GATE_MS = "0";
  calls = [];
});
afterEach(() => {
  delete process.env.YSD_TEST_FIRST_BYTE_MS;
  delete process.env.YSD_TEST_IDLE_MS;
  delete process.env.YSD_TEST_CHAIN_BUDGET_MS;
  delete process.env.YSD_TEST_PROBE_GATE_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════
//  ① المهلة لا تُنهي السلسلة
// ════════════════════════════════════════════════════════════

describe("① مهلة نموذج ⇒ احتياط ناجح", () => {
  it("★ (C) A يتلكّأ حتى المهلة ⇒ B يجيب، والعدّاد يقول 2", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, signal) => (i === 0 ? stalling(signal) : sse(ARABIC, model))),
    );
    const res = await run();

    expect(res.text).toContain(ARABIC);
    expect(res.outcome).toBe("success");
    // ★ المهلة محاولةٌ جرت — لا اختفاء لها من العدّاد
    expect(res.attemptCount).toBe(2);
    expect(fallbackCountOf(res.attemptCount)).toBe(1);
    // ★ والمتلكّئ يُبعَد دقيقتين فلا يُجرَّب في كل طلب
    expect(isCoolingDown(FREE_MODEL_CHAIN[0]!)).toBe(true);
    expect(cooldownRemainingMs(FREE_MODEL_CHAIN[0]!)).toBeLessThanOrEqual(2 * 60_000);
  });
});

// ════════════════════════════════════════════════════════════
//  ② السبر: أقرب انتهاءً — لا أول السلسلة
// ════════════════════════════════════════════════════════════

describe("② اختيار السبر حتمي", () => {
  /**
   * ★ الاختيار **بالانتهاء لا بالترتيب** — والفرق مقصود.
   *
   * نُهدّئ الأول ست ساعات (404) والبقية دقيقتين (503). فلو كان الاختيار
   * بترتيب السلسلة لسُبر الأول — وهو أبعد المرشّحين تعافيًا. المطلوب الثاني:
   * أقلّها انتظارًا. وتَكراره يعطي نفس النتيجة، فلا عشوائية تُربك التشخيص.
   */
  it("★ يُسبر الأقرب انتهاءً لا الأول في السلسلة", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i) => (i === 0 ? err(404, "No endpoints found") : err(503))),
    );
    await run();
    for (const m of FREE_MODEL_CHAIN) expect(isCoolingDown(m)).toBe(true);
    // الأول ست ساعات، والباقي دقيقتان ⇒ الأقرب انتهاءً هو الثاني
    expect(cooldownRemainingMs(FREE_MODEL_CHAIN[0]!)).toBeGreaterThan(60 * 60_000);

    calls = [];
    vi.stubGlobal("fetch", transport(() => err(503)));
    await run();
    expect(calls).toEqual([FREE_MODEL_CHAIN[1]!]);

    /**
     * ★ والسبر الفاشل **يُدوِّر** — لا يعيد طرق الباب نفسه.
     *
     * فشل السبر يُعيد تهدئة مَن سُبر، فيصير أبعدهم انتهاءً، ويأخذ التالي دوره.
     * أي أن نموذجًا معطوبًا لا يبتلع كل السبر: تُجرَّب السلسلة بالتناوب.
     */
    calls = [];
    await run();
    expect(calls).toEqual([FREE_MODEL_CHAIN[2]!]);

    /**
     * ★ الحتميّة تُقاس على **نفس الحالة**: أعِد بناءها بالضبط ⇒ نفس المرشّح.
     */
    const pickFrom = async (): Promise<string> => {
      _resetCooldowns();
      calls = [];
      vi.stubGlobal(
        "fetch",
        transport((i) => (i === 0 ? err(404, "No endpoints found") : err(503))),
      );
      await run();
      calls = [];
      vi.stubGlobal("fetch", transport(() => err(503)));
      await run();
      return calls[0]!;
    };
    expect(await pickFrom()).toBe(await pickFrom());
  });

  it("★ السبر لا يفتح الباب: نداء واحد لا سلسلة كاملة", async () => {
    vi.stubGlobal("fetch", transport(() => err(503)));
    await run();
    calls = [];
    await run();
    expect(calls.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ③ أخطاء الحساب العالمية
// ════════════════════════════════════════════════════════════

describe("③ خطأ حساب ⇒ لا احتياط بلا طائل", () => {
  /**
   * ★ لماذا 402 عالمي؟
   *
   * الرصيد رصيد المفتاح لا رصيد النموذج: نداء OpenRouter موقّع بمفتاح واحد،
   * فإن رُفض لعدم الكفاية رُفض لكل نموذج. تجريب البقية أربعة نداءات فاشلة
   * وتأخيرٌ للمستخدم بلا أي احتمال نجاح.
   */
  it("★ 402 رصيد غير كافٍ ⇒ توقّف بعد نداء واحد", async () => {
    vi.stubGlobal("fetch", transport(() => err(402, "insufficient credit")));
    const res = await run();

    expect(calls.length).toBe(1);
    expect(res.outcome).toBe("insufficient_credit");
    expect(fallbackCountOf(res.attemptCount)).toBe(0);
    // ★ ولا يُهدَّأ نموذج: العلّة في الحساب لا فيه
    for (const m of FREE_MODEL_CHAIN) expect(isCoolingDown(m)).toBe(false);
  });

  /**
   * ★ و403 **ليس** منها.
   *
   * 401 حكمٌ على المفتاح، أما 403 فتستعمله OpenRouter للحجب والإشراف أيضًا،
   * وذلك قد يخصّ نموذجًا بعينه. فإلحاقه بأخطاء الحساب كان يجعل حجب نموذج
   * واحد يوقف السلسلة كلها.
   */
  it("★ 403 على نموذج ⇒ يُجرَّب التالي وينجح", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model) => (i === 0 ? err(403, "moderation") : sse(ARABIC, model))),
    );
    const res = await run();

    expect(res.text).toContain(ARABIC);
    expect(res.outcome).toBe("success");
    expect(fallbackCountOf(res.attemptCount)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ④ صدق العدّاد حين لا يقع نداء
// ════════════════════════════════════════════════════════════

describe("④ صفر نداءات ⇒ صفر محاولات", () => {
  /**
   * ★ الصفر يجب أن يكون **مقيسًا** لا افتراضيًا.
   *
   * الاختصار المحمي يردّ بلا أي نداء مزوّد. فلو غاب الحدث الختامي هنا لَبدا
   * `fallback_count = 0` كما يبدو في الفشل الطرفي تمامًا — وهو الالتباس الذي
   * أضاع تشخيص الحادثة. الآن يصل `attemptCount = 0` صراحةً.
   */
  it("★ اختصار بلا نداء مزوّد ⇒ attemptCount = 0", async () => {
    const fetchMock = transport(() => sse(ARABIC, "unused"));
    vi.stubGlobal("fetch", fetchMock);

    // سؤال متخصص بلا مصدر ⇒ الوضع المحمي يردّ بلا نداء (v0.6.5 RC8)
    const res = await run({
      messages: [
        {
          role: "user",
          content:
            "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟",
        },
      ],
    });

    // ★ الاختصار وقع فعلًا — لا فرع صامت يمرّ بلا فحص
    expect(res.outcome).toBe("short_circuit");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.attemptCount).toBe(0);
    expect(res.providerCalls).toBe(0);
    expect(fallbackCountOf(res.attemptCount)).toBe(0);
  });

  it("★ الحدث الختامي مضمون في كل نهاية — ولا يلي `done`", async () => {
    for (const scenario of [
      () => transport((_i, model) => sse(ARABIC, model)), // نجاح
      () => transport(() => err(503)), // استنفاد
      () => transport(() => err(401)), // خطأ حساب
    ]) {
      _resetCooldowns();
      calls = [];
      vi.stubGlobal("fetch", scenario());

      const out: StreamChunk[] = [];
      for await (const c of new OpenRouterProvider().streamChat({
        modelId: YSD_FREE_MODEL_ID,
        messages: [{ role: "user", content: "سؤال" }],
      })) {
        out.push(c);
      }

      // ★ عدّاد حقيقي في كل نهاية
      const terminal = out.filter((c) => typeof c.attemptCount === "number").pop();
      expect(terminal).toBeDefined();
      expect(terminal!.attemptCount).toBe(calls.length);
      expect(typeof terminal!.chainOutcome).toBe("string");

      /**
       * ★ و`done` يبقى الخاتمة.
       *
       * كل قارئ يعتبر `done` النهاية، فوضع إطارٍ بعده يكسره. الحدث الختامي
       * يُدرَج قبله لا بعده.
       */
      const doneAt = out.findIndex((c) => c.type === "done");
      if (doneAt !== -1) expect(doneAt).toBe(out.length - 1);
    }
  });
});

// ════════════════════════════════════════════════════════════
//  ⑤ بوابة السبر — معدّل السبر لا يحدده عدد المستخدمين
// ════════════════════════════════════════════════════════════

describe("⑤ بوابة السبر", () => {
  /** يُهدّئ السلسلة كلها بأربعة إخفاقات، ثم يصفّر العدّاد */
  async function coolEverything(): Promise<void> {
    vi.stubGlobal("fetch", transport(() => err(503)));
    await run();
    calls = [];
  }

  beforeEach(() => {
    // نافذة مصغّرة قابلة للحقن — القيمة الإنتاجية (30 ثانية) لم تُمسّ
    process.env.YSD_TEST_PROBE_GATE_MS = "400";
  });
  afterEach(() => {
    delete process.env.YSD_TEST_PROBE_GATE_MS;
  });

  /**
   * ★ (A) الحمل لا يصنع السبر.
   *
   * «سبرٌ واحد لكل طلب» يجعل معدّل السبر تابعًا لحركة المستخدمين: مئة طلب
   * متزامن = مئة نداء على مزوّد أعلن للتو أنه غير قادر. البوابة تفصل الأمرين.
   */
  it("★ (A) مئة طلب متزامن والجميع مهدّأ ⇒ نداء واحد لا مئة", async () => {
    await coolEverything();
    vi.stubGlobal("fetch", transport(() => err(503)));

    const results = await Promise.all(Array.from({ length: 100 }, () => run()));

    // eslint-disable-next-line no-console
    console.log(`[قياس] طلبات=100 provider_calls=${calls.length}`);
    expect(calls.length).toBe(1); // (B) سبر واحد داخل النافذة
    expect(results).toHaveLength(100);
    // (C) البقية تفشل سريعًا بلا نداء — وبالعقد العام نفسه
    const gated = results.filter((r) => r.outcome === "all_models_cooling");
    expect(gated.length).toBe(99);
    for (const r of gated) {
      expect(r.errorCode).toBe("provider_unavailable");
      expect(r.attemptCount).toBe(0);
    }
  });

  it("★ (C) الطلبات اللاحقة داخل النافذة لا تضرب المزوّد", async () => {
    await coolEverything();
    vi.stubGlobal("fetch", transport(() => err(503)));

    await run(); // يستهلك السبر
    expect(calls.length).toBe(1);
    for (let i = 0; i < 5; i++) await run();
    expect(calls.length).toBe(1); // لا شيء إضافي
  });

  it("★ (D) بعد انقضاء النافذة يُسمح بسبر جديد", async () => {
    await coolEverything();
    vi.stubGlobal("fetch", transport(() => err(503)));

    await run();
    expect(calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 450)); // > نافذة الاختبار
    await run();
    expect(calls.length).toBe(2);
  });

  /**
   * ★ (E) السبر الناجح يُعيد الخدمة — لا يُبقيها في وضع السبر.
   *
   * النموذج أثبت عمله للتوّ، فإبقاء تهدئته يعني الاستمرار في تقنين الخدمة
   * بلا سبب. تُرفع تهدئته وتُفتح البوابة، فالطلب التالي يمرّ طبيعيًا.
   */
  it("★ (E) سبر ناجح ⇒ رفع التهدئة وعودة الخدمة", async () => {
    await coolEverything();
    vi.stubGlobal("fetch", transport((_i, model) => sse(ARABIC, model)));

    const first = await run();
    expect(first.text).toContain(ARABIC);
    expect(first.outcome).toBe("success");
    const probed = calls[0]!;
    expect(isCoolingDown(probed)).toBe(false); // رُفعت

    // الطلب التالي طبيعي: بلا بوابة وبلا انتظار
    calls = [];
    const second = await run();
    expect(second.text).toContain(ARABIC);
    expect(calls.length).toBe(1);
  });

  it("★ (F) سبر فاشل ⇒ تهدئة تعود وبوابة تُغلق", async () => {
    await coolEverything();
    vi.stubGlobal("fetch", transport(() => err(503)));

    await run();
    const probed = calls[0]!;
    expect(isCoolingDown(probed)).toBe(true);
    expect(cooldownRemainingMs(probed)).toBeGreaterThan(0);
    expect(probeGateRemainingMs()).toBeGreaterThan(0);

    calls = [];
    await run();
    expect(calls.length).toBe(0); // مغلقة فعلًا
  });

  /**
   * ★ (G) التدوير يبقى صحيحًا عبر النوافذ.
   *
   * كل سبر فاشل يُعيد تهدئة مَن سُبر فيصير أبعدهم انتهاءً، فيأخذ التالي دوره
   * في النافذة التالية. أي أن نموذجًا معطوبًا لا يبتلع كل السبر.
   */
  it("★ (G) التدوير بين النماذج عبر نوافذ متتالية", async () => {
    /**
     * تهدئة أولية **متباعدة** عمدًا.
     *
     * التهدئات الأربع تقع عادةً داخل ميلي ثانية واحدة، فتتساوى مواعيد
     * انتهائها ويحسم الترتيبَ تعادلٌ لا سياسة — وهو ما يجعل الاختبار يقيس
     * دقّة الساعة بدل قياس التدوير. الفواصل هنا تجعل «الأقرب انتهاءً»
     * سؤالًا له جواب واحد لا لبس فيه.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push((JSON.parse(String(init.body)) as { model: string }).model);
        await new Promise((r) => setTimeout(r, 12));
        return err(503);
      }),
    );
    await run();
    calls = [];

    const probes: string[] = [];
    for (let i = 0; i < 3; i++) {
      calls = [];
      await run();
      if (calls[0]) probes.push(calls[0]);
      await new Promise((r) => setTimeout(r, 450));
    }

    // ★ ثلاثة سبور ⇒ ثلاثة نماذج مختلفة، بترتيب الاستحقاق
    expect(probes).toEqual([FREE_MODEL_CHAIN[0]!, FREE_MODEL_CHAIN[1]!, FREE_MODEL_CHAIN[2]!]);
  });

  /**
   * ★ (H) لا سباق داخل العملية الواحدة.
   *
   * الحجز متزامن بالكامل: لا `await` بين الفحص والضبط، وحلقة أحداث جافاسكربت
   * لا تُقاطَع بينهما. فمهما تزامن الطلبان لا يفوزان معًا.
   */
  it("★ (H) طلبان متزامنان تمامًا ⇒ سبر واحد", async () => {
    await coolEverything();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        calls.push((JSON.parse(String(init.body)) as { model: string }).model);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return err(503);
      }),
    );

    await Promise.all([run(), run()]);
    expect(calls.length).toBe(1);
    expect(maxInFlight).toBe(1);
  });
});
