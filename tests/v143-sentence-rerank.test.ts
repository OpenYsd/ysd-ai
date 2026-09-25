import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  rerankBySentences,
  resetSentenceCache,
  sentenceCacheSize,
  splitSentences,
  SECONDARY_CACHE_MAX_SENTENCES,
  SECONDARY_MAX_SENTENCES,
  SECONDARY_MAX_SENTENCES_PER_CHUNK,
  SECONDARY_SENTENCE_MAX_CHARS,
  SECONDARY_TIME_BUDGET_MS,
} from "@/lib/rag/sentence-rerank";
import { bowVector } from "./helpers/fake-embedder";

/**
 * البحثُ الثانويّ بالجمل — وحدةً معزولة.
 *
 * ★ المقيس:
 *   (١) مقطعٌ متعدّد الموضوعات فيه جملةُ الجواب يتقدّم على مقطعٍ أعلى تشابهًا متّجهيًّا.
 *   (٢) الحدود: جملٌ لكلّ سؤال، جملٌ لكلّ مقطع، وميزانيةُ وقت — وعند بلوغها يبقى الترتيبُ المتّجهيّ للبقيّة.
 *   (٣) المسجَّلُ بادئةٌ من الأعلى متّجهيًّا: توقّفٌ مبكّر لا يُخرج من الستّة الأولى ما كان فيها.
 *   (٤) الذاكرة المخبّأة محدودة وتُغني السؤالَ التالي عن التضمين.
 *   (٥) فشلُ المزوّد لا يرمي: الترتيبُ المتّجهيّ كما هو.
 */

const D = 64;
const vec = (t: string) => bowVector(t, D);

function provider() {
  const calls: string[] = [];
  return {
    calls,
    embedPassages: async (texts: string[]) => {
      calls.push(...texts);
      return texts.map(vec);
    },
  };
}

let seq = 0;
const cand = (content: string, similarity: number) => ({ chunk_id: `c${++seq}`, content, similarity });
/** جملةٌ حشوٌ ≥ 25 حرفًا بكلماتٍ فريدة — لا تشبه السؤال */
const filler = (n: number) => `filler${n}a filler${n}b filler${n}c filler${n}d.`;

beforeEach(() => {
  resetSentenceCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("splitSentences", () => {
  it("يقسم على نهايات الجمل العربيّة واللاتينيّة والأسطر، ويدمج الشظايا القصيرة، ويقصّ الطويل", () => {
    expect(splitSentences("The first sentence is long enough. The second one is long enough too!")).toEqual([
      "The first sentence is long enough.",
      "The second one is long enough too!",
    ]);
    expect(splitSentences("هذه جملةٌ عربيّةٌ طويلةٌ بما يكفي؟ وهذه جملةٌ ثانيةٌ طويلةٌ كذلك؛ وثالثةٌ طويلةٌ بما يكفي هنا.")).toHaveLength(3);
    expect(splitSentences("Short.\nAlso short.\nThis line is definitely longer than the threshold.")).toHaveLength(1);
    expect(splitSentences("x".repeat(1000))[0]!.length).toBe(SECONDARY_SENTENCE_MAX_CHARS);
    expect(splitSentences("  \n\n ")).toEqual([]);
  });
});

describe("rerankBySentences", () => {
  it("★ ★ ★ مقطعُ الجواب المذوَّب يتقدّم على مقطعٍ أعلى تشابهًا متّجهيًّا", async () => {
    const q = "employee badge number zeta seven";
    const gold = cand([filler(1), filler(2), "The employee badge number is zeta seven, issued once.", filler(3), filler(4)].join(" "), 0.2);
    const decoy = cand("employee employee employee overview of the whole department and its structure.", 0.6);
    const p = provider();
    const { order, stats } = await rerankBySentences(p, vec(q), [decoy, gold], "tag");
    expect(order.map((c) => c.chunk_id)).toEqual([gold.chunk_id, decoy.chunk_id]);
    expect(stats).toMatchObject({ scored: 2, cached: 0, complete: true });
    expect(stats.embedded).toBe(p.calls.length);
  });

  it("★ ★ ★ الذاكرة المخبّأة: السؤالُ التالي عن المقاطع نفسِها لا يضمّن شيئًا — والوسمُ جزءٌ من المفتاح", async () => {
    const rows = [cand(`${filler(1)} ${filler(2)}`, 0.5), cand(`${filler(3)} ${filler(4)}`, 0.4)];
    const p = provider();
    const first = await rerankBySentences(p, vec("anything at all here"), rows, "tagA");
    expect(first.stats.embedded).toBe(4);
    const second = await rerankBySentences(p, vec("another question entirely"), rows, "tagA");
    expect(second.stats).toMatchObject({ embedded: 0, cached: 4, scored: 2, complete: true });
    expect(p.calls).toHaveLength(4);
    const otherModel = await rerankBySentences(p, vec("anything at all here"), rows, "tagB");
    expect(otherModel.stats.embedded).toBe(4);
  });

  it("★ ★ ★ سقفُ الجمل لكلّ مقطع", async () => {
    const big = cand(Array.from({ length: 60 }, (_, i) => filler(i)).join(" "), 0.5);
    const p = provider();
    const { stats } = await rerankBySentences(p, vec("q q q"), [big], "t");
    expect(stats.embedded).toBe(SECONDARY_MAX_SENTENCES_PER_CHUNK);
  });

  it("★ ★ ★ سقفُ الجمل لكلّ سؤال — والبقيّةُ بترتيبها المتّجهيّ بعد المسجَّلين", async () => {
    const perChunk = SECONDARY_MAX_SENTENCES_PER_CHUNK;
    const n = Math.ceil(SECONDARY_MAX_SENTENCES / perChunk) + 3;
    const rows = Array.from({ length: n }, (_, k) =>
      cand(Array.from({ length: perChunk }, (_, i) => filler(k * 100 + i)).join(" "), 1 - k / 100),
    );
    const p = provider();
    const { order, stats } = await rerankBySentences(p, vec("q q q"), rows, "t");
    expect(stats.complete).toBe(false);
    expect(stats.embedded).toBeLessThanOrEqual(SECONDARY_MAX_SENTENCES);
    expect(p.calls.length).toBeLessThanOrEqual(SECONDARY_MAX_SENTENCES);
    const unscored = rows.slice(stats.scored);
    expect(order.slice(stats.scored)).toEqual(unscored);
  });

  it("★ ★ ★ ميزانيةُ الوقت: يتوقّف قبل الجملة التالية؛ والمقطعُ الجزئيّ لا يُسجَّل ولا يُخبَّأ", async () => {
    let t = 0;
    const now = () => t;
    const p = {
      calls: 0,
      embedPassages: async (texts: string[]) => {
        p.calls++;
        t += 700; // كلُّ جملةٍ 700 مل
        return texts.map(vec);
      },
    };
    const rows = [cand(`${filler(1)} ${filler(2)} ${filler(3)}`, 0.9), cand(`${filler(4)} ${filler(5)} ${filler(6)}`, 0.8), cand(filler(7), 0.7)];
    const { order, stats } = await rerankBySentences(p, vec("q q q"), rows, "t", now);
    // 5 جمل × 700 = 3500 > 3000: الخامسةُ آخرُ ما بدأ قبل الميزانية، فلا سادسة
    expect(p.calls).toBe(Math.floor(SECONDARY_TIME_BUDGET_MS / 700) + 1);
    expect(stats).toMatchObject({ scored: 1, complete: false });
    expect(order.map((c) => c.chunk_id)).toEqual(rows.map((c) => c.chunk_id));
    expect(sentenceCacheSize()).toBe(3); // الأوّل وحده — جملُ الثاني الناقصة لم تُخبَّأ
  });

  it("★ ★ ★ التوقّفُ المبكّر يعيد ترتيبَ البادئة فيما بينها فقط: الستّةُ الأولى هي الستّةُ المتّجهيّة", async () => {
    let t = 0;
    const p = {
      embedPassages: async (texts: string[]) => {
        t += 1100;
        return texts.map(vec);
      },
    };
    const q = "alpha bravo charlie delta echo";
    const rows = Array.from({ length: 12 }, (_, k) => cand(k === 2 ? `alpha bravo charlie delta echo and more words here.` : filler(k), 1 - k / 20));
    const { order } = await rerankBySentences(p, vec(q), rows, "t", () => t);
    expect(new Set(order.slice(0, 6).map((c) => c.chunk_id))).toEqual(new Set(rows.slice(0, 6).map((c) => c.chunk_id)));
    expect(order[0]!.chunk_id).toBe(rows[2]!.chunk_id);
  });

  it("★ ★ ★ فشلُ المزوّد لا يرمي: الترتيبُ المتّجهيّ كما هو", async () => {
    const rows = [cand(filler(1), 0.9), cand(filler(2), 0.8)];
    const p = { embedPassages: async () => Promise.reject(new Error("runtime gone")) };
    const out = await rerankBySentences(p, vec("q q q"), rows, "t");
    expect(out.order).toBe(rows);
    expect(out.stats.complete).toBe(false);
  });

  it("★ ★ ★ الذاكرة المخبّأة لا تتجاوز سقفها أبدًا (تُطرد الأقدمُ أوّلًا)", async () => {
    const p = provider();
    const perChunk = 20;
    const rounds = Math.ceil((SECONDARY_CACHE_MAX_SENTENCES * 1.5) / perChunk);
    for (let r = 0; r < rounds; r++) {
      const row = cand(Array.from({ length: perChunk }, (_, i) => filler(r * 1000 + i)).join(" "), 0.5);
      await rerankBySentences(p, vec("q q q"), [row], "t");
      expect(sentenceCacheSize()).toBeLessThanOrEqual(SECONDARY_CACHE_MAX_SENTENCES);
    }
    expect(sentenceCacheSize()).toBeGreaterThan(SECONDARY_CACHE_MAX_SENTENCES - perChunk);
  });
});
