/**
 * مزود Embeddings خلف Adapter مستقل — قابل للاستبدال لاحقًا.
 *
 * التنفيذ الحالي: نموذج مفتوح متعدد اللغات يعمل محليًا داخل خادم المشروع
 * (intfloat/multilingual-e5-small عبر ONNX — بناء Xenova) بلا أي API مدفوع،
 * ومحتوى ملفات المستخدمين لا يغادر الخادم أبدًا (يُنزَّل النموذج نفسه مرة
 * واحدة فقط من HuggingFace ثم يعمل دون شبكة).
 *
 * ملاحظات نموذج E5: الاستعلام يسبقه "query: " والمقاطع "passage: ".
 */

export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  /** Embedding لسؤال المستخدم */
  embedQuery(text: string): Promise<number[]>;
  /** Embeddings لمقاطع — معالجة متسلسلة على دفعات لحماية الذاكرة */
  embedPassages(texts: string[], onProgress?: (done: number) => void): Promise<number[][]>;
}

const MODEL_ID = "Xenova/multilingual-e5-small";
const DIMS = 384;
const BATCH_SIZE = 8;
const BATCH_TIMEOUT_MS = 120_000;
/** حد أقصى لطول النص المرسل للنموذج (E5 يقتطع عند 512 token تقريبًا) */
const MAX_INPUT_CHARS = 2000;

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;
let instanceCount = 0;

/** حالة النموذج للفحص الصحي — لا يُحمّل النموذج، يقرأ الحالة فقط */
export type EmbeddingModelState = "not_loaded" | "loading" | "ready" | "failed";
let modelState: EmbeddingModelState = "not_loaded";
export function getEmbeddingModelState(): {
  state: EmbeddingModelState;
  model: string;
  dims: number;
  instances: number;
} {
  return { state: modelState, model: MODEL_ID, dims: DIMS, instances: instanceCount };
}

/** تحميل النموذج مرة واحدة وإعادة استخدامه — نسخة واحدة فقط داخل العملية */
async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    instanceCount += 1;
    if (instanceCount > 1) {
      // حارس صريح: يجب ألا تُحمّل أكثر من نسخة في العملية نفسها
      console.error("[embeddings] guard: multiple model instances attempted");
    }
    modelState = "loading";
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // الكاش: YSD_MODEL_CACHE إن ضُبط (الصورة تخبز النموذج فيه وقت البناء)،
      // وإلا كاش محلي داخل المشروع (مُتجاهَل في git) للتطوير.
      env.cacheDir = process.env.YSD_MODEL_CACHE || `${process.cwd()}/.cache/transformers`;
      const pipe = await pipeline("feature-extraction", MODEL_ID, {
        dtype: "q8",
      });
      modelState = "ready";
      return pipe as unknown as Extractor;
    })().catch((err) => {
      // فشل التحميل يجب ألا يسمّم المحاولات اللاحقة
      extractorPromise = null;
      instanceCount = Math.max(0, instanceCount - 1);
      modelState = "failed";
      throw err;
    });
  }
  return extractorPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** طابور تسلسلي — طلب واحد للنموذج في أي لحظة (حماية الذاكرة) */
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job);
  queueTail = run.catch(() => undefined);
  return run;
}

class LocalTransformersProvider implements EmbeddingProvider {
  readonly id = "local-multilingual-e5-small";
  readonly dims = DIMS;

  async embedQuery(text: string): Promise<number[]> {
    const rows = await this.run([`query: ${text.slice(0, MAX_INPUT_CHARS)}`]);
    const row = rows[0];
    if (!row || row.length !== DIMS) throw new Error("embedding failed: bad output");
    return row;
  }

  async embedPassages(
    texts: string[],
    onProgress?: (done: number) => void,
  ): Promise<number[][]> {
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts
        .slice(i, i + BATCH_SIZE)
        .map((t) => `passage: ${t.slice(0, MAX_INPUT_CHARS)}`);
      const rows = await this.run(batch);
      if (rows.length !== batch.length || rows.some((r) => r.length !== DIMS)) {
        throw new Error("embedding failed: incomplete batch output");
      }
      all.push(...rows);
      onProgress?.(all.length);
    }
    return all;
  }

  private run(texts: string[]): Promise<number[][]> {
    return enqueue(() =>
      withTimeout(
        (async () => {
          const extractor = await getExtractor();
          const output = await extractor(texts, { pooling: "mean", normalize: true });
          return output.tolist();
        })(),
        BATCH_TIMEOUT_MS,
        "embedding batch",
      ),
    );
  }
}

let providerSingleton: EmbeddingProvider | null = null;

/** نقطة الاستبدال الوحيدة لمزود Embeddings */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!providerSingleton) providerSingleton = new LocalTransformersProvider();
  return providerSingleton;
}
