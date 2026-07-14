/**
 * اختبار حي لمزود Embeddings المحلي — YSD_LIVE=1 فقط
 * (أول تشغيل يُنزّل النموذج ~112MB مرة واحدة).
 * يقيس الزمن والذاكرة فعليًا ويتحقق من جودة التشابه بالعربية.
 */
import { describe, it, expect } from "vitest";

const live = process.env.YSD_LIVE === "1";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // المتجهات مطبَّعة
}

describe.runIf(live)("Local embeddings (live)", () => {
  it("يولّد متجهات 384 بُعدًا ويميز التشابه العربي", async () => {
    const { getEmbeddingProvider } = await import("../lib/rag/embeddings");
    const provider = getEmbeddingProvider();

    const memBefore = process.memoryUsage().rss / 1024 / 1024;
    const t0 = Date.now();
    const q = await provider.embedQuery("ما هي فوائد قواعد البيانات؟");
    const loadAndFirstMs = Date.now() - t0;

    const t1 = Date.now();
    const passages = await provider.embedPassages([
      "تخزن قواعد البيانات المعلومات بطريقة منظمة وتتيح الوصول السريع والآمن إليها.",
      "يفضل القط النوم في الأماكن الدافئة خلال فصل الشتاء الطويل.",
      "Databases store information in a structured way enabling fast access.",
    ]);
    const threeMs = Date.now() - t1;
    const memAfter = process.memoryUsage().rss / 1024 / 1024;

    expect(q.length).toBe(384);
    expect(passages.length).toBe(3);

    const simRelated = cosine(q, passages[0]!);
    const simUnrelated = cosine(q, passages[1]!);
    const simCross = cosine(q, passages[2]!);

    console.log(
      `[live] first(load+embed)=${loadAndFirstMs}ms | 3 passages=${threeMs}ms | rss ${Math.round(memBefore)}→${Math.round(memAfter)}MB`,
    );
    console.log(
      `[live] sim related=${simRelated.toFixed(3)} unrelated=${simUnrelated.toFixed(3)} cross-lingual=${simCross.toFixed(3)}`,
    );

    // المقطع المتعلق يجب أن يكون الأقرب — والفرق واضح
    expect(simRelated).toBeGreaterThan(simUnrelated + 0.03);
    // التشابه عبر اللغات (سؤال عربي/مقطع إنجليزي بنفس المعنى) أعلى من غير المتعلق
    expect(simCross).toBeGreaterThan(simUnrelated);
  }, 600_000);
});

describe.runIf(!live)("Local embeddings — متخطى", () => {
  it("يتخطى بدون YSD_LIVE=1", () => {
    expect(true).toBe(true);
  });
});
