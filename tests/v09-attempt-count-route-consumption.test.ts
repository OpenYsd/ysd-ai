import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { _resetCooldowns, markCooldown } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * استهلاك المسار للقياسات — الحارس الأساسي لعطل `fallback_count = 0`.
 *
 * كان المسار يشترط `chunk.type === "meta" && chunk.model` قبل قراءة أي قياس،
 * والحدث الختامي للسلسلة لا يحمل نموذجًا — لأنه لا يخصّ نموذجًا بعينه. فكان
 * يُرفض بأكمله ويبقى `attemptCount = 0` مهما جرى من احتياط.
 *
 * ★ لماذا لا نُعيد كتابة الحلقة هنا؟
 *
 * لأن هذا بالضبط ما أطال عمر العطل: اختبارات المسار القائمة تُحاكي منطقه
 * بنسخة مكتوبة يدويًا، والنسخة كانت **سليمة** بينما الأصل معطوب — فمرّت
 * خضراء وهي تحرس شيئًا لا وجود له. لذا نستخرج كتلة `meta` من الملف الحقيقي
 * ونُشغّلها كما هي: أي رجوع للشرط القديم يُسقط هذه الاختبارات فورًا.
 */

const ROUTE_SRC = readFileSync("app/api/chat/route.ts", "utf8");

/** الحقول التي تكتبها كتلة meta في المسار */
interface MetaState {
  actualModelId: string | null;
  attemptCount: number;
  chainOutcome: string;
  answerMode: string;
  regenerations: number;
  emptyCompletions: number;
  groundingSource: string;
  protectedDetailBlocked: boolean;
  shortCircuit: boolean;
  providerCalls: number;
}

const FIELDS = [
  "actualModelId",
  "attemptCount",
  "chainOutcome",
  "answerMode",
  "regenerations",
  "emptyCompletions",
  "groundingSource",
  "protectedDetailBlocked",
  "shortCircuit",
  "providerCalls",
] as const;

/**
 * يستخرج جسم فرع `meta` من مصدر المسار ويحوّله دالةً قابلة للتنفيذ.
 *
 * الاستخراج بموازنة الأقواس من رأس الفرع. وفشلُه يُسقط الاختبار بصوت عالٍ
 * بدل أن يمرّ صامتًا — فغياب الفرع خبرٌ لا سكوت.
 */
function extractMetaBranch(): { head: string; body: string } {
  const prefix = '} else if (chunk.type === "meta"';
  const at = ROUTE_SRC.indexOf(prefix);
  if (at < 0) {
    throw new Error(
      "تعذّر إيجاد فرع meta في app/api/chat/route.ts — إن تغيّر شكله فحدّث هذا المستخرِج، ولا تحذف الحارس.",
    );
  }
  const braceAt = ROUTE_SRC.indexOf("{", at + prefix.length);
  const head = ROUTE_SRC.slice(at, braceAt + 1);

  let i = braceAt + 1;
  let depth = 1;
  while (i < ROUTE_SRC.length && depth > 0) {
    const ch = ROUTE_SRC[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) throw new Error("قوس غير متوازن في فرع meta");
  return { head, body: ROUTE_SRC.slice(braceAt + 1, i) };
}

/**
 * ★ الاستخراج يقبل **الشكلين** عمدًا.
 *
 * لو رفض الشكل القديم لَفشل الملف عند التحميل، فيظهر «لا اختبارات» — وهو
 * خبرٌ ملتبس يسهل تفسيره خطأً. وبقبوله يعود العطل، إن أُعيد، فشلًا صريحًا
 * في اختبارات مسمّاة تقول ما انكسر بالضبط.
 */
const META_BRANCH = extractMetaBranch();

const META_BODY = META_BRANCH.body;

/**
 * ★ الشرط نفسه يُنفَّذ أيضًا — لا الجسم وحده.
 *
 * تشغيل الجسم بمعزل عن رأسه يتخطّى الحارس المعطوب: لو أُعيد ربط الفرع
 * بـ`chunk.model` لبقيت السيناريوهات خضراء لأنها تستدعي الجسم مباشرة.
 * فنستخرج الشرط ونُحكّمه كما يفعل المسار حرفيًا.
 */
const META_CONDITION = META_BRANCH.head.slice(
  META_BRANCH.head.indexOf("(") + 1,
  META_BRANCH.head.lastIndexOf(")"),
);
const metaMatches = new Function("chunk", `return (${META_CONDITION});`) as (
  chunk: StreamChunk,
) => boolean;

type MetaFn = (
  chunk: StreamChunk,
  state: MetaState,
  send: (m: unknown) => void,
  requestId: string,
  providerFirstByteMs: number,
) => MetaState;

/** يلفّ الكتلة المستخرجة في دالة تُرجع الحالة بعد التطبيق */
const applyMeta = new Function(
  "chunk",
  "state",
  "send",
  "requestId",
  "providerFirstByteMs",
  `let { ${FIELDS.join(", ")} } = state;
${META_BODY}
return { ${FIELDS.join(", ")} };`,
) as unknown as MetaFn;

const freshState = (): MetaState => ({
  actualModelId: null,
  attemptCount: 0, // القيمة الابتدائية في المسار
  chainOutcome: "unknown",
  answerMode: "general",
  regenerations: 0,
  emptyCompletions: 0,
  groundingSource: "none",
  protectedDetailBlocked: false,
  shortCircuit: false,
  providerCalls: 0,
});

/** كما يحسبه المسار حرفيًا */
const fallbackOf = (attemptCount: number) => Math.max(0, attemptCount - 1);

// ════════════════════════════════════════════════════════════
//  جهاز البثّ — مزوّد حقيقي بنقل مُحاكى
// ════════════════════════════════════════════════════════════

let calls: string[] = [];

const ARABIC = "هذه إجابة عربية سليمة تمامًا عن سؤال المستخدم بلا أي خلط لغوي إطلاقًا.";

function sse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(
        enc.encode(`data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`),
      );
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ model, usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
        ),
      );
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

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

interface Observed extends MetaState {
  providerCallsActual: number;
  fallbackCount: number;
  errorCode: string | null;
  usageFrames: number;
  sentMetaModels: string[];
}

/**
 * يمرّر بثّ المزوّد الحقيقي عبر كتلة `meta` الحقيقية للمسار.
 *
 * أي أن ما يُقاس هنا هو ما سيصل `observability_events` فعلًا — لا نسخة منه.
 */
async function runThroughRoute(): Promise<Observed> {
  let state = freshState();
  const sentMetaModels: string[] = [];
  const send = (m: unknown) => {
    const model = (m as { model?: string }).model;
    if (model) sentMetaModels.push(model);
  };

  let providerFirstByteMs = -1;
  let usageFrames = 0;
  let errorCode: string | null = null;

  for await (const chunk of new OpenRouterProvider().streamChat({
    modelId: YSD_FREE_MODEL_ID,
    messages: [{ role: "user", content: "ما عاصمة السعودية؟" }],
  })) {
    if (chunk.type === "text" && chunk.text) {
      if (providerFirstByteMs < 0) providerFirstByteMs = 1;
    } else if (metaMatches(chunk)) {
      // ★ الشرط الحقيقي ثم الجسم الحقيقي — كما في المسار
      state = applyMeta(chunk, state, send, "rid-test", providerFirstByteMs);
    } else if (chunk.type === "usage" && chunk.usage) {
      usageFrames++;
    } else if (chunk.type === "error") {
      errorCode = chunk.errorCode ?? "unknown";
    }
  }

  return {
    ...state,
    providerCallsActual: calls.length,
    fallbackCount: fallbackOf(state.attemptCount),
    errorCode,
    usageFrames,
    sentMetaModels,
  };
}

function report(name: string, o: Observed): void {
  // eslint-disable-next-line no-console
  console.log(
    `[قياس] ${name} | provider_calls=${o.providerCallsActual} ` +
      `attemptCount=${o.attemptCount} fallback_count=${o.fallbackCount} ` +
      `outcome=${o.chainOutcome} providerCalls(meta)=${o.providerCalls} ` +
      `actual_model=${o.actualModelId ?? "-"} code=${o.errorCode ?? "-"}`,
  );
}

beforeEach(() => {
  _resetCooldowns();
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.YSD_TEST_FIRST_BYTE_MS = "300";
  process.env.YSD_TEST_IDLE_MS = "250";
  process.env.YSD_TEST_CHAIN_BUDGET_MS = "5000";
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
//  ★ الحارس الأساسي
// ════════════════════════════════════════════════════════════

describe("★ حارس الانحدار: إطار ختامي بلا model", () => {
  /**
   * ★ الشرط نفسه — قبل أي سلوك.
   *
   * `chunk.model` حارسٌ للحقول الخاصة بالنموذج وحدها. ربطُ الفرع كلّه به
   * يُسقط الحدث الختامي، وهو بالضبط ما وقع حيًّا.
   */
  it("★ رأس فرع meta لا يشترط وجود model", () => {
    expect(META_BRANCH.head).toContain('chunk.type === "meta"');
    expect(META_BRANCH.head).not.toContain("chunk.model");
  });

  /**
   * ★ هذا هو الحارس الذي كان غائبًا.
   *
   * إطار `meta` بلا `model` **يجب** أن يُحدّث القياسات. ولو أُعيد ربط الفرع
   * بوجود النموذج لسقط هذا الاختبار وحده قبل أي شيء آخر.
   */
  it("★ meta بلا model يُحدّث attemptCount وchainOutcome وproviderCalls", () => {
    const terminal: StreamChunk = {
      type: "meta",
      attemptCount: 3,
      chainOutcome: "chain_exhausted",
      providerCalls: 3,
    };
    const out = applyMeta(terminal, freshState(), () => {}, "rid", -1);

    expect(out.attemptCount).toBe(3);
    expect(out.chainOutcome).toBe("chain_exhausted");
    expect(out.providerCalls).toBe(3);
    expect(fallbackOf(out.attemptCount)).toBe(2);
    // ولا يخترع نموذجًا لم يصل
    expect(out.actualModelId).toBeNull();
  });

  it("★ الحقول الخاصة بالنموذج تبقى داخل حارسها", () => {
    const sent: string[] = [];
    const out = applyMeta(
      { type: "meta", attemptCount: 2 },
      freshState(),
      (m) => {
        const model = (m as { model?: string }).model;
        if (model) sent.push(model);
      },
      "rid",
      -1,
    );
    // إطار بلا نموذج لا يُرسل meta للعميل ولا يمسّ actual_model
    expect(sent).toEqual([]);
    expect(out.actualModelId).toBeNull();
    expect(out.attemptCount).toBe(2); // القياس مع ذلك وصل
  });

  it("★ إطار يحمل model يظل يثبّت actual_model ويُرسل للعميل", () => {
    const sent: string[] = [];
    const out = applyMeta(
      { type: "meta", model: "m/one", attemptCount: 1 },
      freshState(),
      (m) => {
        const model = (m as { model?: string }).model;
        if (model) sent.push(model);
      },
      "rid",
      -1,
    );
    expect(out.actualModelId).toBe("m/one");
    expect(sent).toEqual(["m/one"]);
  });

  /** تبديل النموذج بعد أول نص يبقى مرفوضًا — لا يُنسب ردّ واحد لنموذجين */
  it("★ تبديل النموذج بعد أول نص يبقى مرفوضًا", () => {
    let st = freshState();
    st = applyMeta({ type: "meta", model: "m/one" }, st, () => {}, "rid", -1);
    st = applyMeta({ type: "meta", model: "m/two" }, st, () => {}, "rid", 5);
    expect(st.actualModelId).toBe("m/one");
  });
});

// ════════════════════════════════════════════════════════════
//  A–F عبر المزوّد الحقيقي
// ════════════════════════════════════════════════════════════

describe("سيناريوهات A–F عبر بثّ المزوّد الحقيقي", () => {
  it("★ (A) A مهلة → B ينجح ⇒ attemptCount=2 · fallback=1", async () => {
    vi.stubGlobal(
      "fetch",
      transport((i, model, signal) => (i === 0 ? stalling(signal) : sse(ARABIC, model))),
    );
    const o = await runThroughRoute();
    report("A", o);

    expect(o.providerCallsActual).toBe(2);
    expect(o.attemptCount).toBe(2);
    expect(o.fallbackCount).toBe(1);
    expect(o.chainOutcome).toBe("success");
    // ★ ولم تنكسر بقية القياسات
    expect(o.actualModelId).toBe(FREE_MODEL_CHAIN[1]!);
    expect(o.usageFrames).toBeGreaterThanOrEqual(1);
    expect(o.providerCalls).toBe(2);
  });

  it("★ (B) A مهلة → B مهلة ⇒ فشل طرفي · attemptCount=2 · fallback=1", async () => {
    markCooldown(FREE_MODEL_CHAIN[2]!, "no_free_model");
    markCooldown(FREE_MODEL_CHAIN[3]!, "no_free_model");
    vi.stubGlobal(
      "fetch",
      transport((_i, _m, signal) => stalling(signal)),
    );
    const o = await runThroughRoute();
    report("B", o);

    expect(o.providerCallsActual).toBe(2);
    expect(o.attemptCount).toBe(2);
    expect(o.fallbackCount).toBe(1);
    expect(o.chainOutcome).toBe("chain_exhausted");
  });

  it("★ (C) أربعة نداءات ⇒ provider_unavailable · attemptCount=4 · fallback=3", async () => {
    vi.stubGlobal("fetch", transport(() => err(503)));
    const o = await runThroughRoute();
    report("C", o);

    expect(o.providerCallsActual).toBe(4);
    expect(o.attemptCount).toBe(4);
    expect(o.fallbackCount).toBe(3);
    expect(o.errorCode).toBe("provider_unavailable");
    expect(o.chainOutcome).toBe("chain_exhausted");
  });

  it("★ (D) الجميع مهدّأ والبوابة مغلقة ⇒ 0 · 0 · 0", async () => {
    process.env.YSD_TEST_PROBE_GATE_MS = "60000";
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "provider_error");
    vi.stubGlobal("fetch", transport(() => err(503)));

    await runThroughRoute(); // يستهلك السبر
    calls = [];
    const o = await runThroughRoute();
    report("D", o);

    expect(o.providerCallsActual).toBe(0);
    expect(o.attemptCount).toBe(0);
    expect(o.fallbackCount).toBe(0);
    expect(o.chainOutcome).toBe("all_models_cooling");
  });

  it("★ (E) سبر واحد يفشل ⇒ attemptCount=1 · fallback=0", async () => {
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "provider_error");
    vi.stubGlobal("fetch", transport(() => err(503)));
    const o = await runThroughRoute();
    report("E", o);

    expect(o.providerCallsActual).toBe(1);
    expect(o.attemptCount).toBe(1);
    expect(o.fallbackCount).toBe(0);
    expect(o.chainOutcome).toBe("cooled_probe_failed");
  });

  it("★ (F) نجاح من أول نموذج ⇒ attemptCount=1 · fallback=0", async () => {
    vi.stubGlobal(
      "fetch",
      transport((_i, model) => sse(ARABIC, model)),
    );
    const o = await runThroughRoute();
    report("F", o);

    expect(o.providerCallsActual).toBe(1);
    expect(o.attemptCount).toBe(1);
    expect(o.fallbackCount).toBe(0);
    expect(o.chainOutcome).toBe("success");
    expect(o.actualModelId).toBe(FREE_MODEL_CHAIN[0]!);
    expect(o.sentMetaModels.length).toBeGreaterThanOrEqual(1);
  });
});
