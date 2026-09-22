/**
 * مزوّد التضمين F2LLM-v2-80M (320 بُعدًا) — محلي بالكامل عبر ONNX Runtime.
 *
 * ★ الاستعلام والمقاطع من الفضاء نفسه: نموذجٌ واحد، مُرمِّزٌ واحد، تجميعٌ واحد. والفرق الوحيد ما يقرّره
 *   النموذج نفسه: الاستعلام يسبقه تعليمة `queryPrompt`، والمقطع بلا بادئة.
 * ★ التجميع = حالة الرمز الأخير (رمز النهاية الذي يضيفه المُرمِّز) ثم تطبيع L2 — لا متوسط ولا CLS.
 * ★ الذاكرة: خيط واحد، بلا ساحة CPU ولا نمط ذاكرة، وطلبٌ واحد للنموذج في أي لحظة. ويشترط الإقلاعُ
 *   ضبطَ MALLOC_MMAP_THRESHOLD_ و MALLOC_TRIM_THRESHOLD_ على 65536 (على Linux): بدونهما تتضخّم ذاكرة
 *   ONNX Runtime الأصلية ~300MB فوق حدّ 512MB (قيس). الحارس يرفض التحميل بدل أن يعمل خطرًا.
 * ★ لا يُحمَّل شيءٌ ثقيل عند استيراد الوحدة: ONNX وtransformers.js يُستوردان كسولًا عند أول تضمين.
 */
import type { EmbeddingCallTimings, EmbeddingProvider } from "./embeddings";
import { F2LLM } from "./f2llm-manifest";
import { resolveF2llmDir, verifyF2llmArtifactOnce } from "./f2llm-artifact";

/** ما تفعله الصورة قبل بدء Node — انظر docker-entrypoint.sh */
export const F2LLM_REQUIRED_MALLOC_ENV = {
  MALLOC_MMAP_THRESHOLD_: "65536",
  MALLOC_TRIM_THRESHOLD_: "65536",
} as const;

/** خيارات جلسة ONNX منخفضة الذاكرة — القيم المقيسة نفسها */
export const F2LLM_SESSION_OPTIONS = Object.freeze({
  executionProviders: ["cpu"],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  enableCpuMemArena: false,
  enableMemPattern: false,
});

const MAX_INPUT_CHARS = 2000;
const BATCH_TIMEOUT_MS = 120_000;

export class F2llmConfigError extends Error {
  readonly code = "malloc_env" as const;
  constructor(message: string) {
    super(message);
    this.name = "F2llmConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * على Linux فقط (glibc): المتغيّران يُقرآن عند بدء العملية، فلا يكفي أن يُضبطا بعد الإقلاع.
 * وعلى غيره لا أثر لهما فلا يُشترطان (تطوير محلي).
 */
export function assertF2llmRuntimeEnv(env: Env = process.env, platform: string = process.platform): void {
  if (platform !== "linux") return;
  const bad = Object.entries(F2LLM_REQUIRED_MALLOC_ENV).filter(([k, v]) => env[k] !== v);
  if (bad.length > 0) {
    throw new F2llmConfigError(
      `f2llm requires ${bad.map(([k, v]) => `${k}=${v}`).join(" ")} at process start (see docker-entrypoint.sh)`,
    );
  }
}

/** النصّ الذي يُعطى للمُرمِّز: الاستعلام بتعليمته، والمقطع كما هو — وكلاهما مقصوص كما في e5 */
export function buildF2llmInput(kind: "query" | "document", text: string): string {
  const body = text.slice(0, MAX_INPUT_CHARS);
  return kind === "query" ? F2LLM.queryPrompt + body : F2LLM.documentPrompt + body;
}

/** ما يحتاجه التضمين من بيئة التشغيل — يُحقن في الاختبار */
export interface F2llmRuntime {
  /** رموز النص، بما فيها رمز النهاية الذي يضيفه المُرمِّز */
  tokenize(input: string): number[];
  /** تمريرة واحدة: حالات الرموز المخفية مسطّحة [n × hidden] */
  forward(ids: number[]): Promise<{ hidden: Float32Array; size: number }>;
}

/** قصّ الرموز إلى الحدّ الأقصى مع إبقاء رمز النهاية الأخير — فهو الذي يُجمَّع عليه */
export function truncateKeepingEos(ids: number[], max: number): number[] {
  if (ids.length <= max) return ids;
  return [...ids.slice(0, max - 1), ids[ids.length - 1]!];
}

export async function embedWithRuntime(rt: F2llmRuntime, input: string): Promise<number[]> {
  const ids = truncateKeepingEos(rt.tokenize(input), F2LLM.maxTokens);
  const { hidden, size } = await rt.forward(ids);
  if (size !== F2LLM.dims) throw new Error("embedding failed: unexpected hidden size");
  const n = ids.length;
  const last = hidden.subarray((n - 1) * size, n * size);
  let norm = 0;
  for (let i = 0; i < size; i++) norm += last[i]! * last[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(size);
  for (let i = 0; i < size; i++) out[i] = last[i]! / norm;
  return out;
}

// ---------------------------------------------------------------------------
// تحميل الجلسة والمُرمِّز — مرّة واحدة لكل عملية
// ---------------------------------------------------------------------------

export type F2llmModelState = "not_loaded" | "loading" | "ready" | "failed";

let runtimePromise: Promise<F2llmRuntime> | null = null;
let modelState: F2llmModelState = "not_loaded";
let instanceCount = 0;
let runtimeReady = false;

async function loadRuntime(): Promise<F2llmRuntime> {
  assertF2llmRuntimeEnv();
  const verified = await verifyF2llmArtifactOnce(resolveF2llmDir());

  const tf = await import("@huggingface/transformers");
  tf.env.localModelPath = verified.parentDir.endsWith("/") ? verified.parentDir : verified.parentDir + "/";
  const tokenizer = await tf.AutoTokenizer.from_pretrained(verified.modelId, { local_files_only: true });

  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(verified.modelPath, { ...F2LLM_SESSION_OPTIONS, executionProviders: ["cpu"] });

  return {
    tokenize(input: string): number[] {
      const enc = tokenizer(input, { return_tensor: false }) as { input_ids: ArrayLike<number | bigint> };
      return Array.from(enc.input_ids, Number);
    },
    async forward(ids: number[]) {
      const n = ids.length;
      const feeds = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, n]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(ids, () => 1n), [1, n]),
      };
      const out = await session.run(feeds);
      const hs = out.last_hidden_state;
      if (!hs) throw new Error("embedding failed: model returned no last_hidden_state");
      const hidden = Float32Array.from(hs.data as Float32Array);
      const size = hs.dims[2] as number;
      hs.dispose?.();
      return { hidden, size };
    },
  };
}

function getRuntime(): Promise<F2llmRuntime> {
  if (!runtimePromise) {
    instanceCount += 1;
    modelState = "loading";
    runtimePromise = loadRuntime().then(
      (rt) => {
        modelState = "ready";
        runtimeReady = true;
        return rt;
      },
      (err) => {
        // الفشل لا يسمّم المحاولات اللاحقة
        runtimePromise = null;
        instanceCount = Math.max(0, instanceCount - 1);
        runtimeReady = false;
        modelState = "failed";
        throw err;
      },
    );
  }
  return runtimePromise;
}

export function getF2llmState(): { state: F2llmModelState; model: string; dims: number; instances: number; space: "f2llm" } {
  return { state: modelState, model: F2LLM.tag, dims: F2LLM.dims, instances: instanceCount, space: "f2llm" };
}

// ---------------------------------------------------------------------------
// طابور تسلسلي وحدّ زمني — كما في مزوّد e5
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job);
  queueTail = run.catch(() => undefined);
  return run;
}

class F2llmProvider implements EmbeddingProvider {
  readonly id = "local-f2llm-v2-80m";
  readonly dims = F2LLM.dims;
  /** وسم النموذج المخزَّن مع كل متجه يصنعه هذا المزوّد */
  readonly modelTag = F2LLM.tag;

  async embedQuery(text: string, timings?: EmbeddingCallTimings): Promise<number[]> {
    const row = await this.run(buildF2llmInput("query", text), timings);
    if (row.length !== F2LLM.dims) throw new Error("embedding failed: bad output");
    return row;
  }

  async embedPassages(texts: string[], onProgress?: (done: number) => void): Promise<number[][]> {
    const all: number[][] = [];
    // مقطعًا مقطعًا — لكلٍّ دورٌ مستقلّ في الطابور، فلا ينتظر سؤالُ مستخدمٍ دفعةً كاملة
    for (const t of texts) {
      const row = await this.run(buildF2llmInput("document", t));
      if (row.length !== F2LLM.dims) throw new Error("embedding failed: incomplete batch output");
      all.push(row);
      onProgress?.(all.length);
    }
    return all;
  }

  private run(input: string, timings?: EmbeddingCallTimings): Promise<number[]> {
    return enqueue(() =>
      withTimeout(
        (async () => {
          const readyBefore = runtimeReady;
          const started = runtimePromise !== null;
          const tLoad = Date.now();
          const rt = await getRuntime();
          if (timings && !readyBefore) {
            timings.modelLoadMs = Date.now() - tLoad;
            timings.modelLoadWaited = started;
          }
          const tEmbed = Date.now();
          const row = await embedWithRuntime(rt, input);
          if (timings) timings.embedMs = Date.now() - tEmbed;
          return row;
        })(),
        BATCH_TIMEOUT_MS,
        "embedding batch",
      ),
    );
  }
}

let providerSingleton: F2llmProvider | null = null;

export function getF2llmProvider(): EmbeddingProvider & { readonly modelTag: string } {
  if (!providerSingleton) providerSingleton = new F2llmProvider();
  return providerSingleton;
}
