/**
 * مزوّد تضمين وهميّ حتميّ يُستعمل بدل `@/lib/rag/embeddings` في اختبارات التدفّق (الذاكرة وPostgreSQL الحقيقي).
 *
 * ★ الوهميّ هو النموذج فقط؛ كل ما عداه (worker وretrieval وjobs والمسار والقاعدة) هو الكود الحقيقي.
 * ★ بُعد المتجه يتبع العَلَم كما يفعل المزوّد الحقيقي: 384 لـ e5 و320 لـ F2LLM — فيكشف أيَّ خلطٍ بين الفضاءين
 *   عند القاعدة (أعمدة vector(384)/vector(320)).
 * ★ أكياس كلماتٍ مجزَّأة ثم تطبيع: نصّان متطابقان ⇒ تشابه 1، ومتباعدان ⇒ ≈ 0.
 */
import { f2llmEnabled } from "@/lib/rag/embedding-space";

export const fake = {
  /** حجم كل نداء embedPassages */
  batches: [] as number[],
  /** كل نصٍّ ضُمِّن كمقطع، بالترتيب */
  embedded: [] as string[],
  queries: [] as Array<{ text: string; dims: number }>,
  /** رقم النداء (من 1) الذي ينهار — بعد أن تُحفَظ الدفعات السابقة */
  failOnBatch: null as number | null,
  /** يجبر بُعدًا بعينه (محاكاة خلل إعداد) */
  forceDims: null as number | null,
  reset() {
    this.batches.length = 0;
    this.embedded.length = 0;
    this.queries.length = 0;
    this.failOnBatch = null;
    this.forceDims = null;
  },
};

export const dimsNow = (): number => fake.forceDims ?? (f2llmEnabled() ? 320 : 384);

export function bowVector(text: string, d: number): number[] {
  const v = new Array<number>(d).fill(0);
  for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
    v[h % d]! += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** ما يُعيده `vi.mock("@/lib/rag/embeddings", ...)` */
export function embeddingsMock() {
  const provider = {
    id: "fake",
    get dims() {
      return dimsNow();
    },
    embedQuery: async (text: string) => {
      fake.queries.push({ text, dims: dimsNow() });
      return bowVector(text, dimsNow());
    },
    embedPassages: async (texts: string[]) => {
      fake.batches.push(texts.length);
      if (fake.failOnBatch !== null && fake.batches.length === fake.failOnBatch) throw new Error("simulated crash");
      fake.embedded.push(...texts);
      return texts.map((t) => bowVector(t, dimsNow()));
    },
  };
  return {
    getEmbeddingProvider: () => provider,
    getEmbeddingModelState: () => ({ state: "ready", model: "fake", dims: dimsNow(), instances: 1 }),
  };
}
