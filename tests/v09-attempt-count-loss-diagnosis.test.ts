import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns, markCooldown } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * تشخيص **فقط** — لا إصلاح ولا تعديل على شيفرة الإنتاج.
 *
 * الحادثة بعد 5f34cf5:
 *   error_code = provider_unavailable · provider_first_byte_ms = -1
 *   total_response_ms = 41151 · fallback_count = 0
 *   conversation_lookup=367 · user_message_insert=349 · rag=998  (≈1.7s)
 *
 * أي ≈39.4 ثانية بعد المراحل المقيسة، وFIRST_BYTE_TIMEOUT = 20s.
 * السؤال: محاولتان بمهلة أول بايت؟ وإن كانتا، أين ضاع العدّاد؟
 */

let calls: string[] = [];

/** ردّ يفتح القناة ثم لا يرسل بايتًا — حتى يقطعه AbortSignal فعلًا */
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

const transport = (per: (i: number, model: string, signal?: AbortSignal) => Response) =>
  vi.fn(async (_u: string, init: RequestInit) => {
    const model = (JSON.parse(String(init.body)) as { model: string }).model;
    calls.push(model);
    return per(calls.length - 1, model, init.signal ?? undefined);
  });

interface RunResult {
  chunks: StreamChunk[];
  errorCode: string | null;
  elapsedMs: number;
  /** ما يراه المزوّد فعلًا في الإطار الختامي */
  providerAttemptCount: number | null;
  outcome: string | null;
  /** ★ ما يصل المسار بعد فلتره — لا ما يُصدره المزوّد */
  routeAttemptCount: number;
}

/**
 * ★ محاكاة فلتر المسار **حرفيًا**.
 *
 * app/api/chat/route.ts:747
 *   } else if (chunk.type === "meta" && chunk.model) {
 *       ...
 *       if (typeof chunk.attemptCount === "number") attemptCount = chunk.attemptCount;
 *
 * قراءة العدّاد مشروطة بوجود `model` في الإطار نفسه. فإطارٌ بلا `model`
 * لا يدخل الفرع أصلًا مهما حمل من عدّادات.
 */
function routeSeesAttemptCount(chunks: StreamChunk[]): number {
  let attemptCount = 0; // القيمة الابتدائية في المسار (route.ts:593)
  for (const chunk of chunks) {
    if (chunk.type === "meta" && chunk.model) {
      if (typeof chunk.attemptCount === "number") attemptCount = chunk.attemptCount;
    }
  }
  return attemptCount;
}

async function run(): Promise<RunResult> {
  const t0 = Date.now();
  const chunks: StreamChunk[] = [];
  for await (const c of new OpenRouterProvider().streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
  })) {
    chunks.push(c);
  }
  const last = <K extends keyof StreamChunk>(k: K) =>
    chunks.filter((c) => c[k] !== undefined).pop()?.[k] ?? null;
  return {
    chunks,
    elapsedMs: Date.now() - t0,
    errorCode: chunks.find((c) => c.type === "error")?.errorCode ?? null,
    providerAttemptCount: last("attemptCount") as number | null,
    outcome: last("chainOutcome") as string | null,
    routeAttemptCount: routeSeesAttemptCount(chunks),
  };
}

/** كما يحسبه المسار حرفيًا (route.ts:1191) */
const fallbackOf = (attemptCount: number) => Math.max(0, attemptCount - 1);

/** مهلة أول بايت مصغّرة — النسبة إلى الإنتاج 20s/300ms ≈ 1:67 */
const TEST_FIRST_BYTE_MS = 300;

function report(name: string, r: RunResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `[قياس] ${name} | provider_calls=${calls.length} ` +
      `attemptCount(provider)=${String(r.providerAttemptCount)} ` +
      `attemptCount(route)=${r.routeAttemptCount} ` +
      `fallback_count=${fallbackOf(r.routeAttemptCount)} ` +
      `outcome=${String(r.outcome)} code=${String(r.errorCode)} elapsed=${r.elapsedMs}ms`,
  );
}

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = String(TEST_FIRST_BYTE_MS);
  process.env.YSD_TEST_IDLE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "5000"; // فسيح: لا يقطع محاولتين
  process.env.YSD_TEST_PROBE_GATE_MS = "0";
  calls = [];
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

// ════════════════════════════════════════════════════════════
//  ① إعادة بناء الحادثة حرفيًا
// ════════════════════════════════════════════════════════════

describe("① الحادثة: مهلتان متتاليتان ⇒ provider_unavailable", () => {
  /**
   * ★ لماذا نموذجان لا أربعة؟
   *
   * 39.4 ثانية ÷ 20 = محاولتان بالضبط. ولو بقي مرشّح ثالث لَبدأت محاولته عند
   * 39.4s — أي قبل ميزانية 45s — فتُجهَض عند الميزانية ويصير الإجمالي ≈46.7s
   * لا 41.15s. إذن كان المتاح **اثنين**، والآخران مهدّآن من فشل سابق.
   */
  it("★ نموذجان متاحان، كلاهما يتجاوز مهلة أول بايت", async () => {
    markCooldown(FREE_MODEL_CHAIN[2]!, "no_free_model");
    markCooldown(FREE_MODEL_CHAIN[3]!, "no_free_model");

    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const r = await run();
    report("① مهلتان", r);

    // ★ محاولتان فعليتان — نداءان حقيقيان للمزوّد
    expect(calls.length).toBe(2);
    expect(r.outcome).toBe("chain_exhausted");
    /**
     * ★ فرقٌ يهمّ: مهلتان **خالصتان** تُنتجان `timeout` لا `provider_unavailable`.
     *
     * الرمز يتبع **آخر** خطأ في السلسلة. فالحادثة الحيّة التي حملت
     * `provider_unavailable` لم تنتهِ بمهلة، بل بفشل من نوع آخر (5xx أو 404
     * أو حجب) بعد المهل. أي أن المحاولات **أكثر** من اثنتين، لا اثنتان.
     */
    expect(r.errorCode).toBe("timeout");

    // ★ المزوّد يعدّ صحيحًا: العدّاد الختامي يقول 2
    expect(r.providerAttemptCount).toBe(2);

    /**
     * ★ وهنا يقع الضياع.
     *
     * الإطار الختامي يحمل 2، لكنه بلا `model`، وشرط المسار يشترطه —
     * فلا يُقرأ العدّاد أصلًا ويبقى 0، ومنه `fallback_count = 0`.
     * وهذا يطابق الحادثة الحيّة حرفيًا.
     */
    expect(r.routeAttemptCount).toBe(0); // ← العطل المرصود
    expect(fallbackOf(r.routeAttemptCount)).toBe(0);

    // ★ الإطار الختامي موجود فعلًا — المزوّد أصدره، والمسار أسقطه
    const terminal = r.chunks.filter((c) => typeof c.attemptCount === "number").pop();
    expect(terminal).toBeDefined();
    expect(terminal!.model).toBeUndefined(); // ← سبب السقوط بعينه
    expect(terminal!.attemptCount).toBe(2);

    // ★ الزمن: محاولتان متسلسلتان لا واحدة
    expect(r.elapsedMs).toBeGreaterThanOrEqual(TEST_FIRST_BYTE_MS * 2 * 0.8);
  });

  /**
   * ★ الإطار الختامي يسبق `done` ولا يليه — فالمسار **يراه** لو لم يفلتره.
   *
   * أي أن العلّة ليست في الترتيب (النقطة ٨) بل في شرط `chunk.model`.
   */
  it("★ الترتيب سليم: لا إطار بعد done، والمسار يستهلك حتى النهاية", async () => {
    markCooldown(FREE_MODEL_CHAIN[2]!, "no_free_model");
    markCooldown(FREE_MODEL_CHAIN[3]!, "no_free_model");
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const r = await run();

    const doneAt = r.chunks.findIndex((c) => c.type === "done");
    if (doneAt !== -1) expect(doneAt).toBe(r.chunks.length - 1);

    // الإطار الختامي وصل ضمن الدفق — لا بعد إغلاقه
    const idx = r.chunks.findIndex((c) => typeof c.attemptCount === "number");
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════
//  ② بقية السيناريوهات المطلوبة
// ════════════════════════════════════════════════════════════

describe("② مصفوفة السيناريوهات", () => {
  it("★ A مهلة → B مهلة → ميزانية السلسلة تقطع", async () => {
    process.env.YSD_TEST_CHAIN_BUDGET_MS = "700"; // أضيق من ثلاث مهل
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const r = await run();
    report("② ميزانية", r);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(r.providerAttemptCount).toBeGreaterThanOrEqual(2);
    expect(r.routeAttemptCount).toBe(0); // نفس الضياع
  });

  it("★ A مهلة → B يردّ 503 ⇒ استنفاد", async () => {
    markCooldown(FREE_MODEL_CHAIN[2]!, "no_free_model");
    markCooldown(FREE_MODEL_CHAIN[3]!, "no_free_model");
    vi.stubGlobal(
      "fetch",
      transport((i, _m, signal) => (i === 0 ? stalling(signal) : err(503))),
    );
    const r = await run();
    report("② مهلة+503", r);

    expect(calls.length).toBe(2);
    expect(r.providerAttemptCount).toBe(2);
    expect(r.routeAttemptCount).toBe(0);
    expect(r.errorCode).toBe("provider_unavailable");
  });

  /**
   * ★ (٧) هل يُحسب السبر محاولةً؟
   *
   * يجب أن يُحسب: نداءٌ فعلي وقع على المزوّد. وهو كذلك — `stats.attempts++`
   * في رأس الدورة لا يميّز بين سبر وغيره.
   */
  it("★ كل النماذج مهدّأة ⇒ سبر واحد يتجاوز المهلة ويُحسب محاولة", async () => {
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "provider_error");
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const r = await run();
    report("② سبر بمهلة", r);

    expect(calls.length).toBe(1);
    expect(r.providerAttemptCount).toBe(1); // ★ السبر محاولة
    expect(r.outcome).toBe("cooled_probe_failed");
    expect(r.routeAttemptCount).toBe(0);
  });

  it("★ البوابة مغلقة ⇒ صفر نداءات وصفر محاولات", async () => {
    process.env.YSD_TEST_PROBE_GATE_MS = "60000";
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "provider_error");

    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    await run(); // يستهلك السبر
    calls = [];
    const r = await run(); // داخل النافذة
    report("② بوابة مغلقة", r);

    expect(calls.length).toBe(0);
    expect(r.providerAttemptCount).toBe(0);
    expect(r.outcome).toBe("all_models_cooling");
    // ★ هنا الصفر صادق: لا نداء ولا محاولة
    expect(fallbackOf(r.routeAttemptCount)).toBe(0);
  });

  /**
   * ★ الاتساع الحقيقي للعطل: حتى **النجاح** يفقد العدّاد.
   *
   * إطار البثّ العام الناجح (openrouter.ts:938) يحمل `model` بلا
   * `attemptCount`، والإطار الختامي (:358) يحمل `attemptCount` بلا `model`.
   * فالإطار الذي يقبله المسار لا يحمل العدّاد، والذي يحمله يرفضه المسار.
   * أي أن `fallback_count` صفرٌ في المسار العام كلّه لا في الفشل وحده.
   */
  it("★ نجاح بعد مهلة ⇒ المسار لا يرى العدّاد أيضًا (العطل أوسع)", async () => {
    const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";
    vi.stubGlobal(
      "fetch",
      transport((i, model, signal) => {
        if (i === 0) return stalling(signal);
        const body = new ReadableStream<Uint8Array>({
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
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const r = await run();
    report("② نجاح بعد مهلة", r);

    expect(r.providerAttemptCount).toBe(2); // المزوّد يعدّ صحيحًا
    expect(r.routeAttemptCount).toBe(0); // ★ ولا يصل — إطار :938 بلا عدّاد
    expect(fallbackOf(r.routeAttemptCount)).toBe(0);
  });

  /**
   * ★ توقيع الحادثة الحيّة بالضبط: مهل ثم فشل سريع ⇒ `provider_unavailable`.
   *
   * هذا وحده يفسّر اجتماع 39.4 ثانية مع رمز `provider_unavailable`: مهلتان
   * تستغرقان الزمن، ثم محاولة ثالثة تفشل فورًا فتُحدّد الرمز.
   */
  it("★ توقيع الحادثة: مهلة + مهلة + فشل سريع ⇒ provider_unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, _m, signal) => (i < 2 ? stalling(signal) : err(503))),
    );
    const r = await run();
    report("② توقيع الحادثة", r);

    /**
     * أربع محاولات: اثنتان تستنزفان الزمن بالمهلة، واثنتان تفشلان فورًا.
     * الزمن ≈ مهلتين، والرمز من آخر فشل — وهو ما رُصد حيًّا بالضبط:
     * ≈39.4 ثانية مع `provider_unavailable`.
     */
    expect(calls.length).toBe(4);
    expect(r.errorCode).toBe("provider_unavailable");
    expect(r.providerAttemptCount).toBe(4);
    expect(r.routeAttemptCount).toBe(0); // ← ما رُصد حيًّا
    // الزمن يقارب مهلتين لا ثلاثًا: الثالثة تفشل فورًا
    expect(r.elapsedMs).toBeGreaterThanOrEqual(TEST_FIRST_BYTE_MS * 2 * 0.8);
    expect(r.elapsedMs).toBeLessThan(TEST_FIRST_BYTE_MS * 3);
  });
});
