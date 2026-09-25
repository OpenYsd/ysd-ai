/**
 * بحثٌ ثانويّ محدود: ترتيبُ المقاطع المرشّحة بأفضل جملةٍ فيها.
 *
 * ★ لماذا
 *
 *   مقطعٌ متعدّد الموضوعات (~700–1000 حرف) يذوب فيه متجهُ الحقيقة الواحدة: F2LLM
 *   يضع متجهًا واحدًا للمقطع كلِّه، فتضعف صلتُه بسؤالٍ عن سطرٍ واحدٍ فيه. قيس
 *   على المزوّد نفسِه (scripts/f2llm/calibration/crosslingual-eval.ts، 27 سؤالًا
 *   عربيًّا/إنجليزيًّا على مستندين طويلين): الترتيبُ بالمقطع أدخل مقطعَ الجواب
 *   الموجّهَ في 23 حالة؛ والترتيبُ بأفضل جملة في 27. والإخفاقاتُ لم تكن عبر
 *   اللغتين وحدها — سؤالٌ إنجليزيٌّ عن مستندٍ إنجليزيٍّ أخفق أيضًا — وترجمةُ
 *   السؤال يدويًّا (حدٌّ أعلى لاستراتيجيّة ترجمة) لم تُصلح شيئًا (23).
 *
 * ★ المحدود
 *
 *   - المرشّحون: ما أعاده البحثُ المتّجه نفسُه (≤ 16 مقطعًا)، بمحتواه — لا استعلامَ إضافيّ.
 *   - سقفٌ للجمل في السؤال الواحد، وسقفٌ للجمل في المقطع، وميزانيةُ وقت. حين
 *     يُبلغ أحدُها يتوقّف التسجيل، وتبقى المقاطعُ غيرُ المسجَّلة بترتيبها المتّجهيّ.
 *     والمرشّحون يُسجَّلون بترتيبهم المتّجهيّ، فالمسجَّلُ بادئةٌ من الأعلى: توقّفٌ
 *     مبكّر يعيد ترتيبَ الأعلى فيما بينه ولا يُخرج من الاختيار ما كان فيه.
 *   - ذاكرةٌ مخبّأةٌ محدودة (Float32Array، ≈ 4 MB) بمفتاح المقطع ووسم النموذج:
 *     السؤالُ التالي عن الملفّ نفسِه لا يكلّف شيئًا.
 *   - لا يُرفع أيُّ حدّ: ميزانيةُ المصادر (عددُ المقاطع والأحرف) تُطبَّق بعده كما هي.
 *   - لا يرمي: أيُّ فشلٍ في التضمين يُرجِع الترتيبَ المتّجهيّ كما هو.
 */
import type { EmbeddingProvider } from "./embeddings";

export const SECONDARY_MAX_SENTENCES = 200;
export const SECONDARY_MAX_SENTENCES_PER_CHUNK = 24;
export const SECONDARY_TIME_BUDGET_MS = 3000;
export const SECONDARY_SENTENCE_MAX_CHARS = 300;
/** سقفُ الذاكرة المخبّأة بالجمل: 3000 × 320 × 4 بايت ≈ 3.8 MB */
export const SECONDARY_CACHE_MAX_SENTENCES = 3000;

/** جملٌ تقريبيّة: فواصلُ الأسطر وعلاماتُ نهاية الجملة (عربيّةً ولاتينيّة)؛ تُدمج الشظايا القصيرة */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?؟;؛])\s+|\n+/u)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const last = out.length - 1;
    if (last >= 0 && (out[last]!.length < 25 || p.length < 25)) out[last] = `${out[last]} ${p}`;
    else out.push(p);
  }
  return out.map((s) => s.slice(0, SECONDARY_SENTENCE_MAX_CHARS));
}

// ------------------------------------------------------------------ bounded cache (LRU by insertion order)
const cache = new Map<string, Float32Array[]>();
let cachedSentences = 0;

function cacheGet(key: string): Float32Array[] | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cachePut(key: string, vecs: Float32Array[]): void {
  if (vecs.length > SECONDARY_CACHE_MAX_SENTENCES) return;
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cachedSentences -= old.length;
  }
  while (cachedSentences + vecs.length > SECONDARY_CACHE_MAX_SENTENCES && cache.size > 0) {
    const [oldestKey, oldest] = cache.entries().next().value as [string, Float32Array[]];
    cache.delete(oldestKey);
    cachedSentences -= oldest.length;
  }
  cache.set(key, vecs);
  cachedSentences += vecs.length;
}

/** للاختبار وحده */
export function resetSentenceCache(): void {
  cache.clear();
  cachedSentences = 0;
}
export function sentenceCacheSize(): number {
  return cachedSentences;
}

function cosine(q: number[], v: Float32Array): number {
  let d = 0;
  let nq = 0;
  let nv = 0;
  for (let i = 0; i < v.length; i++) {
    d += q[i]! * v[i]!;
    nq += q[i]! * q[i]!;
    nv += v[i]! * v[i]!;
  }
  return nq > 0 && nv > 0 ? d / Math.sqrt(nq * nv) : 0;
}

export interface RerankCandidate {
  chunk_id: string;
  content: string;
  similarity: number;
}

export interface RerankStats {
  /** مقاطعُ سُجِّلت بأفضل جملة */
  scored: number;
  /** جملٌ ضُمِّنت الآن (غيرُ المخبّأ) */
  embedded: number;
  /** جملٌ جاءت من الذاكرة المخبّأة */
  cached: number;
  ms: number;
  /** هل سُجِّل كلُّ المرشّحين قبل بلوغ أيّ سقف؟ */
  complete: boolean;
}

/**
 * يعيد المرشّحين مرتّبين بأفضل جملةٍ في كلٍّ منها (المسجَّلون أوّلًا، ثم الباقون
 * بترتيبهم المتّجهيّ). الترتيبُ المُدخَل يُفترض أنه المتّجهيّ (الأعلى أوّلًا).
 */
export async function rerankBySentences<T extends RerankCandidate>(
  provider: Pick<EmbeddingProvider, "embedPassages">,
  queryEmbedding: number[],
  candidates: T[],
  cacheTag: string,
  now: () => number = Date.now,
): Promise<{ order: T[]; stats: RerankStats }> {
  const t0 = now();
  const stats: RerankStats = { scored: 0, embedded: 0, cached: 0, ms: 0, complete: true };
  const best = new Map<string, number>();
  let used = 0;
  try {
    outer: for (const c of candidates) {
      const key = `${cacheTag}|${c.chunk_id}`;
      let vecs = cacheGet(key);
      if (vecs) {
        stats.cached += vecs.length;
      } else {
        const sentences = splitSentences(c.content).slice(0, SECONDARY_MAX_SENTENCES_PER_CHUNK);
        if (sentences.length === 0) continue;
        if (used + sentences.length > SECONDARY_MAX_SENTENCES) {
          stats.complete = false;
          break;
        }
        // جملةً جملة — فحصُ الوقت قبل كلٍّ منها يحدّ التجاوزَ بجملةٍ واحدة. مقطعٌ
        // لم تكتمل جملُه لا يُسجَّل ولا يُخبَّأ: أقصى جزئيٍّ ليس أقصى.
        const fresh: Float32Array[] = [];
        for (const s of sentences) {
          if (now() - t0 > SECONDARY_TIME_BUDGET_MS) {
            stats.complete = false;
            break outer;
          }
          const [row] = await provider.embedPassages([s]);
          if (!row) throw new Error("empty sentence embedding");
          fresh.push(Float32Array.from(row));
          used++;
          stats.embedded++;
        }
        vecs = fresh;
        cachePut(key, vecs);
      }
      let m = -1;
      for (const v of vecs) m = Math.max(m, cosine(queryEmbedding, v));
      best.set(c.chunk_id, m);
      stats.scored++;
    }
  } catch (err) {
    // التضمينُ الثانويّ تحسين: فشلُه يُسجَّل ويبقى الترتيبُ المتّجهيّ كما هو
    console.error(`[rag] sentence rerank failed, keeping vector order: ${(err as Error).message?.slice(0, 80)}`);
    stats.complete = false;
    stats.ms = now() - t0;
    return { order: candidates, stats };
  }
  const scored = candidates
    .filter((c) => best.has(c.chunk_id))
    .sort((a, b) => best.get(b.chunk_id)! - best.get(a.chunk_id)! || b.similarity - a.similarity);
  const rest = candidates.filter((c) => !best.has(c.chunk_id));
  stats.ms = now() - t0;
  return { order: [...scored, ...rest], stats };
}
