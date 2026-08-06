import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveEvidence,
  type EvidenceQuoteCandidate,
  type EvidenceSourceRegistryEntry,
} from "@/lib/evidence/resolve-evidence";
import type { RetrievedSnippet } from "@/lib/rag/retrieval";

/**
 * حلّ الأدلة — من ادّعاء النموذج إلى مصادر مُثبَتة (v0.9.0، الإيداع الخامس).
 *
 * محور الاختبارات سؤالان: هل يُقبل ما لا يستحق؟ وهل تُؤخذ حقيقةٌ من النموذج
 * بدل القاعدة؟ الأول يُنتج استشهادًا كاذبًا، والثاني يُنتج نسبةً كاذبة —
 * وكلاهما أسوأ من غياب الدليل، لأن الغياب يظهر والكذب لا.
 */

const CONTENT_A =
  "النموذج اللغوي لا يعرف إلا ما أُعطي، والاسترجاع هو ما يعطيه المقاطع. " +
  "وبغير ذلك يملأ الفراغ بما يشبه الجواب.";

const CONTENT_B =
  "الاستشهاد الكاذب أخطر من المفقود، لأن المفقود يظهر للقارئ والكاذب يمنح ثقة بلا أساس.";

const snippet = (over: Partial<RetrievedSnippet> = {}): RetrievedSnippet => ({
  content: CONTENT_A,
  fileId: "file-a",
  fileName: "تقرير.pdf",
  pageNumber: 7,
  similarity: 0.8,
  chunkId: "chunk-a",
  chunkIndex: 3,
  ...over,
});

const run = (
  responseText: string,
  quoteCandidates: EvidenceQuoteCandidate[],
  sourceRegistry: EvidenceSourceRegistryEntry[],
  maxVerifiedSources = 4,
) => resolveEvidence({ responseText, quoteCandidates, sourceRegistry, maxVerifiedSources });

const QUOTE_A = "والاسترجاع هو ما يعطيه المقاطع";
const QUOTE_A2 = "النموذج اللغوي لا يعرف إلا ما أُعطي";
const QUOTE_B = "الاستشهاد الكاذب أخطر من المفقود";

describe("مصدر يجتاز التحقق", () => {
  it("(١) مطابقة حرفية تُنتج مصدرًا verification=exact", () => {
    const out = run("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE_A }], [
      { marker: 1, snippet: snippet() },
    ]);

    expect(out.sources).toHaveLength(1);
    const src = out.sources[0]!;
    expect(src.marker).toBe(1);
    expect(src.verification).toBe("exact");
    expect(src.quote).toBe(QUOTE_A);
    // الإزاحات تشير إلى موضعه الفعلي في المقطع
    expect(CONTENT_A.slice(src.quoteStart, src.quoteEnd)).toBe(QUOTE_A);
    expect(out.segments[0]!.supported).toBe(true);
    expect(out.stats.verifiedSources).toBe(1);
  });

  /**
   * النموذج يكتب بلا تشكيل وبألف مهموزة مختلفة؛ الملف مُشكَّل. التطبيع يقبل
   * ذلك، **والمُعاد شريحة الملف** لا نصّ النموذج — وإلا عُرض للمستخدم نصٌّ لا
   * يطابق ملفه ولا يمكن تمييزه فيه.
   */
  it("(٢) مطابقة بعد تطبيع الرسم تُنتج verification=normalized بنصّ المقطع", () => {
    const out = run("جواب [[1]].", [{ marker: 1, quote: "النموذج اللغوى لا يعرف الا ما اعطي" }], [
      { marker: 1, snippet: snippet() },
    ]);

    expect(out.sources).toHaveLength(1);
    const src = out.sources[0]!;
    expect(src.verification).toBe("normalized");
    expect(src.quote).toBe(QUOTE_A2); // نصّ الملف بهمزته وتشكيله
    expect(src.quote).not.toBe("النموذج اللغوى لا يعرف الا ما اعطي");
  });
});

describe("ما لا يثبت لا يُحفظ", () => {
  it("(٣) رقم في النص بلا مدخل في السجلّ ⇒ الفقرة غير مدعومة", () => {
    const out = run("جواب [[9]].", [{ marker: 9, quote: QUOTE_A }], []);

    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedUnknownMarkers).toBe(1);
    expect(out.unsupportedSegments).toEqual([0]);
  });

  it("(٤) رقم له مصدر وبلا اقتباس ⇒ غير مدعوم", () => {
    const out = run("جواب [[1]].", [], [{ marker: 1, snippet: snippet() }]);

    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedMissingQuotes).toBe(1);
    expect(out.unsupportedSegments).toEqual([0]);
  });

  it("(٥) اقتباس غير موجود في المقطع ⇒ غير مدعوم", () => {
    const out = run(
      "جواب [[1]].",
      [{ marker: 1, quote: "جملة لم ترد في المقطع إطلاقًا ولا تقاربه" }],
      [{ marker: 1, snippet: snippet() }],
    );

    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedInvalidQuotes).toBe(1);
    expect(out.unsupportedSegments).toEqual([0]);
  });

  it("(٦) مرشّح لعلامة لم ترد في النص يُهمل بلا أثر", () => {
    const out = run(
      "جواب [[1]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 5, quote: QUOTE_B }, // لا وجود لـ[[5]] في النص
      ],
      [
        { marker: 1, snippet: snippet() },
        { marker: 5, snippet: snippet({ content: CONTENT_B, chunkId: "chunk-b" }) },
      ],
    );

    expect(out.sources.map((s) => s.marker)).toEqual([1]);
    expect(out.stats.requestedMarkers).toBe(1);
    // لا يُعدّ مسقَطًا: لم يُطلب أصلًا
    expect(out.stats.droppedUnknownMarkers).toBe(0);
    expect(out.stats.droppedInvalidQuotes).toBe(0);
  });
});

describe("المرشّحون المكرّرون", () => {
  it("(٧) تكرار متطابق بعد التشذيب يُزال بلا أثر", () => {
    const out = run(
      "جواب [[1]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 1, quote: `  ${QUOTE_A}  ` },
      ],
      [{ marker: 1, snippet: snippet() }],
    );

    expect(out.sources).toHaveLength(1);
    expect(out.stats.droppedInvalidQuotes).toBe(0);
  });

  /** أيّهما قصد النموذج؟ لا نُخمّن — والتخمين هنا ينسب اقتباسًا بلا أساس */
  it("(٨) تكرار مختلف يُسقط الرقم كاملًا", () => {
    const out = run(
      "جواب [[1]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 1, quote: QUOTE_A2 },
      ],
      [{ marker: 1, snippet: snippet() }],
    );

    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedInvalidQuotes).toBe(1);
    expect(out.unsupportedSegments).toEqual([0]);
  });
});

describe("الربط بين الفقرات والمصادر", () => {
  it("(٩) رقم مكرّر في فقرتين يرتبط بالمصدر نفسه مرة واحدة", () => {
    const out = run(
      "الفقرة الأولى [[1]].\n\nالفقرة الثانية [[1]] أيضًا.",
      [{ marker: 1, quote: QUOTE_A }],
      [{ marker: 1, snippet: snippet() }],
    );

    expect(out.sources).toHaveLength(1); // لا نسخة لكل فقرة
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]!.sourceMarkers).toEqual([1]);
    expect(out.segments[1]!.sourceMarkers).toEqual([1]);
    expect(out.unsupportedSegments).toEqual([]);
  });

  it("(١٠) فقرة واحدة بعدة مصادر", () => {
    const out = run(
      "جواب يجمع مرجعين [[1]] و[[2]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 2, quote: QUOTE_B },
      ],
      [
        { marker: 1, snippet: snippet() },
        { marker: 2, snippet: snippet({ content: CONTENT_B, chunkId: "chunk-b" }) },
      ],
    );

    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]!.sourceMarkers).toEqual([1, 2]);
    expect(out.sources).toHaveLength(2);
  });

  /** يقابل الفهرس الجزئي `(message_id, chunk_id, quote)` في 0032 */
  it("(١١) نفس المقطع بعلامتين يمرّ إن اختلف الاقتباس، ويُمنع إن تطابق", () => {
    const shared = snippet();

    const distinct = run(
      "أولًا [[1]] وثانيًا [[2]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 2, quote: QUOTE_A2 },
      ],
      [
        { marker: 1, snippet: shared },
        { marker: 2, snippet: shared },
      ],
    );
    expect(distinct.sources).toHaveLength(2);
    expect(new Set(distinct.sources.map((s) => s.chunkId))).toEqual(new Set(["chunk-a"]));

    const same = run(
      "أولًا [[1]] وثانيًا [[2]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 2, quote: QUOTE_A },
      ],
      [
        { marker: 1, snippet: shared },
        { marker: 2, snippet: shared },
      ],
    );
    expect(same.sources).toHaveLength(1);
    expect(same.sources[0]!.marker).toBe(1); // الأول يُبقى
    expect(same.stats.droppedInvalidQuotes).toBe(1);
  });
});

describe("★ حدّ الثقة: ما يأتي من القاعدة لا من النموذج", () => {
  it("(١٢) relevance من snippet.similarity وحده", () => {
    const out = run(
      "جواب [[1]].",
      // النموذج لا يملك حقلًا للصلة أصلًا — ولو حُقن يُتجاهل
      [{ marker: 1, quote: QUOTE_A, relevance: 0.99 } as EvidenceQuoteCandidate],
      [{ marker: 1, snippet: snippet({ similarity: 0.42 }) }],
    );

    expect(out.sources[0]!.relevance).toBeCloseTo(0.42, 10);
  });

  it("(١٣) المعرّفات والأسماء والصفحات من المقطع لا من المرشّح", () => {
    const injected = {
      marker: 1,
      quote: QUOTE_A,
      chunkId: "مزوّر",
      fileId: "مزوّر",
      fileName: "ملف-الضحية.pdf",
      pageNumber: 999,
      chunkIndex: 999,
    } as EvidenceQuoteCandidate;

    const out = run("جواب [[1]].", [injected], [
      { marker: 1, snippet: snippet({ fileId: "file-real", chunkId: "chunk-real", chunkIndex: 12, fileName: "الحقيقي.pdf", pageNumber: 5 }) },
    ]);

    const src = out.sources[0]!;
    expect(src.chunkId).toBe("chunk-real");
    expect(src.fileId).toBe("file-real");
    expect(src.fileNameSnapshot).toBe("الحقيقي.pdf");
    expect(src.pageNumberSnapshot).toBe(5);
    expect(src.chunkIndex).toBe(12);
    expect(JSON.stringify(out)).not.toContain("مزوّر");
    expect(JSON.stringify(out)).not.toContain("ملف-الضحية.pdf");
  });

  it("(★) similarity خارج [0,1] يُحصر ولا يُسقط المصدر", () => {
    const high = run("جواب [[1]].", [{ marker: 1, quote: QUOTE_A }], [
      { marker: 1, snippet: snippet({ similarity: 1.0000000000000002 }) },
    ]);
    expect(high.sources[0]!.relevance).toBe(1);

    const low = run("جواب [[1]].", [{ marker: 1, quote: QUOTE_A }], [
      { marker: 1, snippet: snippet({ similarity: -0.0001 }) },
    ]);
    expect(low.sources[0]!.relevance).toBe(0);
  });
});

describe("حدّ الخطة", () => {
  const many = (n: number) => {
    const text = Array.from({ length: n }, (_, i) => `فقرة [[${i + 1}]].`).join("\n\n");
    const candidates: EvidenceQuoteCandidate[] = [];
    const registry: EvidenceSourceRegistryEntry[] = [];
    for (let i = 0; i < n; i++) {
      candidates.push({ marker: i + 1, quote: QUOTE_A });
      registry.push({
        marker: i + 1,
        // مقاطع مختلفة كي لا يتدخّل منع التكرار
        snippet: snippet({ chunkId: `chunk-${i}`, similarity: 0.9 - i * 0.1 }),
      });
    }
    return { text, candidates, registry };
  };

  /**
   * (١٤) الحدّ **بعد** التحقق.
   *
   * المرجع 6 أعلى صلةً من كل ما عداه واقتباسه كاذب. لو طُبّق الحدّ قبل التحقق
   * لاحتلّ مكانًا في الأربعة ثم سقط، فيخسر المستخدم دليلًا صالحًا بسبب ادّعاء
   * كاذب سبقه في الترتيب.
   */
  it("(١٤) الحدّ يُطبَّق بعد التحقق لا قبله", () => {
    const { text, candidates, registry } = many(5);
    const textWith6 = `${text}\n\nفقرة [[6]].`;
    candidates.push({ marker: 6, quote: "اقتباس لا وجود له في أي مقطع هنا" });
    registry.push({ marker: 6, snippet: snippet({ chunkId: "chunk-6", similarity: 0.99 }) });

    const out = run(textWith6, candidates, registry, 4);

    expect(out.sources).toHaveLength(4);
    expect(out.sources.map((s) => s.marker)).toEqual([1, 2, 3, 4]);
    expect(out.stats.droppedInvalidQuotes).toBe(1);
    expect(out.stats.droppedByPlanLimit).toBe(1);
  });

  it("(١٥) الترتيب relevance تنازليًا ثم أول ظهور عند التعادل", () => {
    const text = "أ [[3]].\n\nب [[1]].\n\nج [[2]].";
    const out = run(
      text,
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 2, quote: QUOTE_A },
        { marker: 3, quote: QUOTE_A },
      ],
      [
        // 1 و3 متعادلان؛ 3 يسبق 1 في النص
        { marker: 1, snippet: snippet({ chunkId: "c1", similarity: 0.5 }) },
        { marker: 2, snippet: snippet({ chunkId: "c2", similarity: 0.9 }) },
        { marker: 3, snippet: snippet({ chunkId: "c3", similarity: 0.5 }) },
      ],
      4,
    );

    expect(out.sources.map((s) => s.marker)).toEqual([2, 3, 1]);
  });

  it("(١٦) المصدر الذي أسقطه الحدّ تُزال روابطه من الفقرات", () => {
    const { text, candidates, registry } = many(5);
    const out = run(text, candidates, registry, 4);

    expect(out.sources.map((s) => s.marker)).toEqual([1, 2, 3, 4]);
    expect(out.stats.droppedByPlanLimit).toBe(1);
    // الفقرة الخامسة كان مصدرها الوحيد رقم 5
    expect(out.segments[4]!.sourceMarkers).toEqual([]);
    expect(out.segments[4]!.supported).toBe(false);
    expect(out.unsupportedSegments).toEqual([4]);
  });
});

describe("الفقرات غير المدعومة والنصّ النظيف", () => {
  it("(١٧) unsupportedSegments تشمل ما لم يبقَ له مصدر وما لم يستشهد أصلًا", () => {
    const out = run(
      "فقرة مدعومة [[1]].\n\nفقرة بلا استشهاد.\n\nفقرة بمرجع مجهول [[9]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 9, quote: QUOTE_A },
      ],
      [{ marker: 1, snippet: snippet() }],
    );

    expect(out.segments.map((s) => s.supported)).toEqual([true, false, false]);
    expect(out.unsupportedSegments).toEqual([1, 2]);
  });

  it("(١٨) لا علامة خام في cleanText — لا مقبولة ولا مرفوضة", () => {
    const out = run(
      "مقبول [[1]] ومرفوض [[2]] ومجهول [[9]].",
      [
        { marker: 1, quote: QUOTE_A },
        { marker: 2, quote: "لا شيء من هذا في المقطع أبدًا" },
      ],
      [
        { marker: 1, snippet: snippet() },
        { marker: 2, snippet: snippet({ chunkId: "chunk-b" }) },
      ],
    );

    expect(out.cleanText).not.toMatch(/\[\[\d{1,2}\]\]/);
    expect(out.cleanText).toBe("مقبول ومرفوض ومجهول.");
  });
});

describe("★ حارس التسجيل", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * الوحدة نقيّة ولا تسجّل. والحارس يثبت ذلك بمحتوى فريد: لو ظهر في أي مجرى
   * لكان مصدره هذه الوحدة وحدها.
   */
  it("لا يظهر الاقتباس ولا المقطع في أي مجرى خرج", () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR وما بعده في المقطع";
    const streams: string[] = [];
    const capture = (...args: unknown[]) => void streams.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "info").mockImplementation(capture);
    vi.spyOn(console, "debug").mockImplementation(capture);

    const out = run(
      "جواب [[1]].\n\nوآخر [[2]].",
      [
        { marker: 1, quote: "SECRET_QUOTE_MUST_NOT_APPEAR وما بعده" },
        { marker: 2, quote: "SECRET_QUOTE_MUST_NOT_APPEAR غير موجود هنا" },
      ],
      [
        { marker: 1, snippet: snippet({ content: SECRET }) },
        { marker: 2, snippet: snippet({ content: CONTENT_B, chunkId: "chunk-b" }) },
      ],
    );

    expect(streams.join("\n")).not.toContain("SECRET_QUOTE_MUST_NOT_APPEAR");
    expect(streams).toHaveLength(0);
    // `stats` وحدها ما يجوز تسجيله — عدّادات مجرّدة
    expect(JSON.stringify(out.stats)).not.toContain("SECRET_QUOTE_MUST_NOT_APPEAR");
    expect(Object.values(out.stats).every((v) => typeof v === "number")).toBe(true);
  });
});

describe("مدخلات شاذّة لا تُسقط الحلّ", () => {
  it("نصّ فارغ ⇒ نتيجة فارغة بلا رمي", () => {
    const out = run("", [{ marker: 1, quote: QUOTE_A }], [{ marker: 1, snippet: snippet() }]);
    expect(out.sources).toEqual([]);
    expect(out.segments).toEqual([]);
    expect(out.stats.requestedMarkers).toBe(0);
  });

  it("سقف صفر ⇒ لا مصادر وكل الفقرات غير مدعومة", () => {
    const out = run("جواب [[1]].", [{ marker: 1, quote: QUOTE_A }], [
      { marker: 1, snippet: snippet() },
    ], 0);
    expect(out.sources).toEqual([]);
    expect(out.stats.droppedByPlanLimit).toBe(1);
    expect(out.unsupportedSegments).toEqual([0]);
  });

  it("رقم واحد في السجلّ لمقطعين مختلفين ⇒ التباس يُسقط الرقم", () => {
    const out = run("جواب [[1]].", [{ marker: 1, quote: QUOTE_A }], [
      { marker: 1, snippet: snippet({ chunkId: "c1" }) },
      { marker: 1, snippet: snippet({ chunkId: "c2" }) },
    ]);
    expect(out.sources).toHaveLength(0);
    expect(out.stats.droppedUnknownMarkers).toBe(1);
  });
});
