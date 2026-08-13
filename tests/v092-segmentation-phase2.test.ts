/**
 * تقسيم الأدلة v2 — المرحلة الثانية: **تفعيل الحدود** (A–L).
 *
 * المرحلة الأولى نقلت ملكية الحساب وشحنت التوصيل كاملًا بينما بقيت الحدود
 * كما هي (`SERVER_ENABLED_VERSION = 1`). وهذه المرحلة سطر واحد: 1 ← 2.
 *
 * فما يُختبر هنا ليس منطقًا جديدًا — بل أن السطر الواحد أنتج الأثر المقصود
 * ولم يُنتج غيره: البنود المرقّمة تنفصل، وكل ما ليس بندًا لا ينفصل، والرسائل
 * القديمة لا يتغيّر عرضها بحرف.
 *
 * والحذر مقصود في الاتجاه الواحد: قاعدة متحفّظة تُبقي بندين معًا أحيانًا،
 * لكنها لا تقطع نصًّا ليس قائمة. فالانفصال الخاطئ يزيح أزرار الاستشهاد إلى
 * فقرات لم تُدَّعَ — وذلك استشهاد كاذب، وهو أسوأ من المفقود لأن المفقود يظهر.
 */

import { describe, it, expect } from "vitest";

import {
  CLIENT_MAX_VERSION,
  SERVER_ENABLED_VERSION,
  buildEvidenceLayout,
  decideLayout,
  negotiateSegmentationVersion,
  readEvidenceLayout,
} from "@/lib/evidence/evidence-layout";
import { parseEvidenceMarkers } from "@/lib/evidence/marker-parser";
import {
  resolveEvidence,
  type EvidenceQuoteCandidate,
  type EvidenceSourceRegistryEntry,
} from "@/lib/evidence/resolve-evidence";
import type { RetrievedSnippet } from "@/lib/rag/retrieval";

/** عدد المقاطع المتميّزة التي أنتجها التقسيم */
const segmentCount = (text: string, segmentation: 1 | 2): number =>
  new Set(
    parseEvidenceMarkers(text, { segmentation }).lineSegments.filter(
      (s) => s !== null,
    ),
  ).size;

/* ═════════════════ (A–B) التفاوض بعد التفعيل ═════════════════ */

describe("★ (A–B) التفاوض والخادم عند 2", () => {
  it("★ الخادم مفعَّل عند 2 — وإلا فبقيّة هذا الملفّ تختبر العدم", () => {
    /**
     * ★ يوثّق **ما هو مشحون**، لا ما نتمنّاه.
     *
     * عاد إلى 2 بعد أن صار الاسترداد يرث إصدار التقسيم من المعطى: كان
     * التعطيل مشروطًا بذلك الإصلاح بعينه، لا بمرور وقت.
     */
    expect(SERVER_ENABLED_VERSION).toBe(2);
  });

  it("★ (A) عميل قديم بلا حقل + خادم 2 ⇒ 1", () => {
    expect(negotiateSegmentationVersion(undefined, SERVER_ENABLED_VERSION)).toBe(1);
    /**
     * هذا هو ما يحمي المستخدمين الذين لم تُحدَّث صفحاتهم بعد النشر: حزمتهم
     * تجهل v2، فلو أرسل الخادم تخطيط v2 لأخفت الواجهة كل الاستشهادات. الحقل
     * الغائب ليس نقصًا في الطلب بل إعلان قدرة: «أقصى ما أفهمه 1».
     */
  });

  it("★ (B) عميل يعلن 2 + خادم 2 ⇒ 2", () => {
    /**
     * الخادم يُمرَّر صراحةً لا من الثابت المشحون: المُختبَر هنا **منطق
     * التفاوض** لا حالة التفعيل. فيبقى البند (B) مُغطًّى وإن كان الشحن
     * الحاليّ عند 1، ولا يلزم لمسه حين يُرفع التفعيل ثانيةً.
     */
    expect(negotiateSegmentationVersion(2, 2)).toBe(2);
    // وحزمة العميل المشحونة تعلن 2 فعلًا — لا 1
    expect(CLIENT_MAX_VERSION).toBe(2);
    // ومع الخادم المشحون (2) يتّفق الطرفان على 2 — وهو أثر التفعيل
    expect(negotiateSegmentationVersion(CLIENT_MAX_VERSION)).toBe(2);
  });
});

/* ═════════════ (C–D) القسمة تعمل من العمود صفر ═════════════ */

describe("★ (C–D) البنود المرقّمة تنفصل", () => {
  const THREE = "1. claim one\n2. claim two\n3. claim three";

  it("★ (C) ثلاثة بنود ⇒ ثلاثة مقاطع تحت v2", () => {
    expect(segmentCount(THREE, 2)).toBe(3);
    // وكل سطر في مقطعه: لا سطر يتيم ولا سطران في واحد
    const lines = parseEvidenceMarkers(THREE, { segmentation: 2 }).lineSegments;
    expect(lines).toEqual([0, 1, 2]);
  });

  it("★ (C′) وهذا هو ما رُصد حيًّا: v1 كان يعطي مقطعًا واحدًا", () => {
    expect(segmentCount(THREE, 1)).toBe(1);
    expect(segmentCount(THREE, 2)).toBe(3);
  });

  it("★ (D) العمود صفر شرطٌ — لا انفصال من داخل السطر", () => {
    // رقم في وسط السطر ليس بندًا مهما بدا
    const inline = "مقدّمة 1. ليست بندًا 2. ولا هذه";
    expect(segmentCount(inline, 2)).toBe(1);
  });

  it("★ (D′) البند الأول يفتح مقطعًا حتى لو سبقته فقرة", () => {
    const withLead = "مقدّمة الجواب\n1. الأول\n2. الثاني";
    const lines = parseEvidenceMarkers(withLead, { segmentation: 2 }).lineSegments;
    // المقدّمة مقطع، ثم بندان — ثلاثة مقاطع لا اثنان
    expect(lines).toEqual([0, 1, 2]);
  });
});

/* ═══════ (E–G) ما ليس بندًا لا ينفصل — الاتجاه الخطر ═══════ */

describe("★ (E–G) القاعدة متحفّظة", () => {
  it("★ (E) البند المتداخل بمسافتين أو ثلاث لا يقسّم", () => {
    for (const indent of ["  ", "   "]) {
      const nested = `1. الأب\n${indent}2. ابن\n${indent}3. ابن آخر`;
      // القائمة المتداخلة جزء من بندها الأب لا بند مستقلّ
      expect(segmentCount(nested, 2)).toBe(1);
    }
  });

  it("★ (F) «2023 - Present» ليس بندًا — لا فاصل بعد الرقم", () => {
    const cv = "2023 - Present\n2019 - 2023\n2015 - 2019";
    expect(segmentCount(cv, 2)).toBe(1);
    // ولا يتغيّر شيء عن v1 — النصّ غير القائمة يُعامل كما كان
    expect(segmentCount(cv, 2)).toBe(segmentCount(cv, 1));
  });

  it("★ (G) «1.2.3» ترقيم أقسام لا بند — لا مسافة بعد النقطة", () => {
    const sections = "1.2.3 التفاصيل\n1.2.4 المزيد";
    expect(segmentCount(sections, 2)).toBe(1);
    expect(segmentCount(sections, 2)).toBe(segmentCount(sections, 1));
  });

  it("★ (F′/G′) صور أخرى قريبة لا تقسّم كذلك", () => {
    const cases = [
      "3.14 قيمة تقريبية\n2.71 قيمة أخرى", // أعداد عشرية
      "1.لاصق بلا مسافة\n2.لاصق كذلك", // بلا فاصل
      "1. \n2. ", // بلا محتوى بعد الفاصل
      "١. عربي\n٢. عربي", // أرقام عربية-هندية خارج القاعدة
    ];
    for (const text of cases) {
      expect(segmentCount(text, 2)).toBe(1);
    }
  });

  it("★ الأسوار البرمجية محميّة — الشيفرة ليست قائمة", () => {
    const fenced = "مقدّمة\n\n```py\n1. ليس بندًا\n2. ولا هذا\n```";
    const v2 = parseEvidenceMarkers(fenced, { segmentation: 2 }).lineSegments;
    const inFence = v2.slice(3).filter((s) => s !== null);
    expect(new Set(inFence).size).toBeLessThanOrEqual(1);
  });
});

/* ═════ (H–I) الأثر على الدعم والاسترداد — عبر الحلّ الكامل ═════ */

const CONTENT =
  "الاسترجاع هو ما يعطي النموذج مقاطعه، وبغير ذلك يملأ الفراغ بما يشبه الجواب.";
const QUOTE = "الاسترجاع هو ما يعطي النموذج مقاطعه";

const snippet = (over: Partial<RetrievedSnippet> = {}): RetrievedSnippet => ({
  content: CONTENT,
  fileId: "file-a",
  fileName: "تقرير.pdf",
  pageNumber: 7,
  similarity: 0.8,
  chunkId: "chunk-a",
  chunkIndex: 3,
  ...over,
});

const resolve = (
  responseText: string,
  quoteCandidates: EvidenceQuoteCandidate[],
  sourceRegistry: EvidenceSourceRegistryEntry[],
  segmentation: 1 | 2,
) =>
  resolveEvidence({
    responseText,
    quoteCandidates,
    sourceRegistry,
    maxVerifiedSources: 4,
    segmentation,
  });

describe("★ (H–I) الدعم والاسترداد بعد التفعيل", () => {
  /** ثلاثة بنود، والاستشهاد صالح للأول وحده */
  const THREE_CLAIMS = "1. الأول [[1]]\n2. الثاني\n3. الثالث";

  const out = () =>
    resolve(
      THREE_CLAIMS,
      [{ marker: 1, quote: QUOTE }],
      [{ marker: 1, snippet: snippet() }],
      2,
    );

  it("★ (H) البند الأول مدعوم، و[1,2] غير مدعومين", () => {
    const r = out();
    expect(r.sources).toHaveLength(1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.supported).toBe(true);
    expect(r.segments[0]!.sourceMarkers).toEqual([1]);
    expect(r.segments[1]!.supported).toBe(false);
    expect(r.segments[2]!.supported).toBe(false);
    // ★ وهذا هو الكسب: v1 كان يعدّ الثلاثة مقطعًا واحدًا «مدعومًا»
    expect(r.unsupportedSegments).toEqual([1, 2]);
  });

  it("★ (H′) v1 على النصّ نفسه: مقطع واحد مدعوم — بلا كشف للفجوة", () => {
    const v1 = resolve(
      THREE_CLAIMS,
      [{ marker: 1, quote: QUOTE }],
      [{ marker: 1, snippet: snippet() }],
      1,
    );
    expect(v1.segments).toHaveLength(1);
    expect(v1.unsupportedSegments).toEqual([]);
    // ادّعاءان بلا سند كانا يمرّان صامتَين تحت غطاء البند الأول
    expect(v1.numberedClaimCount - v1.segments.length).toBe(2);
  });

  it("★ (I) الاسترداد الجزئي يستهدف [1,2] وحدهما — لا البند المدعوم", () => {
    const r = out();
    /**
     * `unsupportedSegments` هو بعينه ما يُبنى عليه طلب الاسترداد الجزئي.
     * فاستهداف مقطع مدعوم يعني إنفاق نداء مزوّد على ما هو مُثبت أصلًا،
     * واستهداف مقطع غير موجود يعني طلبًا فارغًا.
     */
    expect(r.unsupportedSegments).not.toContain(0);
    expect(r.unsupportedSegments).toEqual([1, 2]);
    // وكلّها ضمن مدى المقاطع الفعلي — لا فهرس خارج التخطيط
    for (const idx of r.unsupportedSegments) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(r.segments.length);
    }
  });

  it("★ (I′) `segmentIndex` لكل استشهاد يقع داخل التخطيط المخزَّن", () => {
    const r = out();
    const layout = buildEvidenceLayout(r.lineSegments, 2)!;
    const maxSegment = Math.max(...layout.lines);
    for (const seg of r.segments) {
      // مرجعٌ خارج التخطيط = زرٌّ بلا موضع
      expect(seg.segmentIndex).toBeLessThanOrEqual(maxSegment);
    }
    expect(maxSegment).toBe(2);
  });
});

/* ═════════ (J–K) التطابق وعدم إعادة التحليل — تحت v2 ═════════ */

describe("★ (J–K) البثّ والتخزين وإعادة التحميل تحت v2", () => {
  it("★ (J) الحيّ = المخزَّن = المُعاد تحميله — تطابق عميق", () => {
    const r = resolve(
      "1. الأول [[1]]\n2. الثاني\n3. الثالث",
      [{ marker: 1, quote: QUOTE }],
      [{ marker: 1, snippet: snippet() }],
      2,
    );
    const live = buildEvidenceLayout(r.lineSegments, 2);
    expect(live).not.toBeNull();
    expect(live!.v).toBe(2);

    // ما يمرّ عبر SSE ثم عبر JSONB هو المسار نفسه حرفيًّا
    const persisted = readEvidenceLayout(JSON.parse(JSON.stringify(live)));
    const reloaded = readEvidenceLayout(JSON.parse(JSON.stringify(persisted)));
    expect(persisted).toEqual(live);
    expect(reloaded).toEqual(live);
    expect(decideLayout({ version: 2, layout: reloaded }).lines).toEqual(live!.lines);
  });

  it("★ (K) رسالة جديدة بتخطيط v2 ⇒ استهلاك بلا تحليل", () => {
    const d = decideLayout({ version: 2, layout: { v: 2, lines: [0, 1, 2] } });
    expect(d.mode).toBe("layout");
    expect(d.reason).toBe("server_layout");
    expect(d.lines).toEqual([0, 1, 2]);
    // ولا مسار يعيد التفسير: `legacy` للقديم وحده
    expect(d.mode).not.toBe("legacy");
  });

  it("★ (K′) رسالة v2 بلا تخطيط ⇒ إخفاء لا هبوط إلى v1", () => {
    const d = decideLayout({ version: 2, layout: null });
    expect(d.mode).toBe("hidden");
    expect(d.reason).toBe("hidden_layout_missing");
  });
});

/* ═══════════ (L) الرسائل القديمة لا يتغيّر عرضها ═══════════ */

describe("★ (L) سلوك v1 التاريخيّ محفوظ", () => {
  const NUMBERED = "1. الأول\n2. الثاني\n3. الثالث";

  it("★ (L) رسالة قديمة بلا إصدار ⇒ تحليل قديم بنتيجة v1 القديمة", () => {
    expect(decideLayout({ version: null, layout: null }).mode).toBe("legacy");
    // والمحرّك القديم لم يُمسّ: النتيجة نفسها قبل التفعيل وبعده
    expect(segmentCount(NUMBERED, 1)).toBe(1);
  });

  it("★ (L′) رسالة مخزَّنة بتخطيط v1 تُعرض بتخطيطها هي — لا بـv2", () => {
    const stored = { v: 1 as const, lines: [0, 0, 0] };
    const d = decideLayout({ version: 1, layout: stored });
    expect(d.mode).toBe("layout");
    /**
     * الأهمّ: لا يُعاد حسابها بـv2 فتصير [0,1,2] وتنزلق أزرارها. التخطيط
     * المخزَّن هو الحقيقة، والإصلاح يسري على المولَّد بعده وحده.
     */
    expect(d.lines).toEqual([0, 0, 0]);
  });

  it("★ (L″) الافتراض بلا خيار ما يزال v1 — لا مستدعٍ قائم انزاح", () => {
    expect(parseEvidenceMarkers(NUMBERED).lineSegments).toEqual(
      parseEvidenceMarkers(NUMBERED, { segmentation: 1 }).lineSegments,
    );
  });
});
