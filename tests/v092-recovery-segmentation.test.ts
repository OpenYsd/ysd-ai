/**
 * الاسترداد يرث إصدار التقسيم — إصلاح صحّة (v0.9.2).
 *
 * ── العطل ──
 *
 * `resolveEvidence` كان يعمل بالإصدار المتفاوَض عليه، بينما مسار الاسترداد
 * يستدعي `parseEvidenceMarkers` بلا إصدار فيهبط ضمنًا إلى v1. فتحت v2 صار
 * `resolved` ثلاثيّ المقاطع والاسترداد أُحاديّه.
 *
 * والدمج يطابق `segmentIndex` بـ`segmentIndex`. فالفهرس نفسه يعني فقرتين
 * مختلفتين على الجانبين، ومصدرٌ وُجد للادّعاء الثالث يُلصق بالأول. وذلك
 * **استشهاد في غير موضعه** — أسوأ من غيابه، لأن الغياب يظهر للقارئ
 * والخطأ يمنح ثقةً بلا أساس.
 *
 * ── الإصلاح ──
 *
 * `ResolvedEvidence` تحمل `segmentationVersion` صراحةً، ويرثها الاسترداد
 * الجزئي من `base` لا من وسيطٍ يُنسى. والاسترداد الكامل — لا `base` موثوق
 * لديه — يتلقّاها من المسار. ونقطة الدمج ترفض ما اختلف إصداره.
 *
 * ملاحظة: `SERVER_ENABLED_VERSION` يبقى 1. هذه الاختبارات تمرّر الإصدار
 * صراحةً، فتغطّي v2 قبل تفعيله.
 */

import { describe, it, expect } from "vitest";

import {
  attemptEvidenceRecovery,
  attemptPartialEvidenceRecovery,
  mergePartialEvidence,
  resolveRecoveredEvidence,
} from "@/lib/evidence/evidence-recovery";
import { resolveEvidence } from "@/lib/evidence/resolve-evidence";
import { buildEvidencePayload } from "@/lib/evidence/evidence-repository";
import type { AIProviderAdapter } from "@/lib/ai/types";

/* ─────────────────────── تجهيزات ─────────────────────── */

const CHUNK_A = "بدأ المشروع سنة 2021 على يد فريق صغير من ثلاثة مهندسين.";
const CHUNK_B = "يعتمد النظام على قاعدة بيانات علائقية مع فهارس مركّبة.";
const CHUNK_C = "تغطية الاختبارات تتجاوز ثمانين بالمئة من المسارات الحرجة.";

const mk = (chunkId: string, content: string) => ({
  chunkId,
  fileId: `f-${chunkId}`,
  chunkIndex: 0,
  fileName: `ملف-${chunkId}.pdf`,
  pageNumber: 1,
  content,
  similarity: 0.9,
});

const registry = [
  { marker: 1, snippet: mk("c1", CHUNK_A) },
  { marker: 2, snippet: mk("c2", CHUNK_B) },
  { marker: 3, snippet: mk("c3", CHUNK_C) },
];

/** ثلاثة ادّعاءات مرقّمة — الشكل الذي رُصد حيًّا */
const THREE_CLAIMS =
  "1. claim A [[1]]\n2. claim B [[2]]\n3. claim C [[3]]";

/** اقتباس claim C وحده صالح — الاثنان الآخران ملفّقان */
const ONLY_C_VALID = [
  { marker: 1, quote: "نصٌّ لا وجود له في أي مقطع إطلاقًا" },
  { marker: 2, quote: "اقتباس آخر مختلق تمامًا ولا يطابق شيئًا" },
  { marker: 3, quote: "تغطية الاختبارات تتجاوز ثمانين بالمئة" },
];

/** مزوّد مُحاكى يسجّل الموجّه المُرسَل ويردّ بما يحدّده الاختبار */
function spyProvider(reply: string | null) {
  const seen: { systemPrompt: string; userText: string }[] = [];
  const adapter = {
    id: "groq",
    displayName: "groq",
    isConfigured: () => true,
    listModels: () => [],
    async requestJsonCompletion(req: { systemPrompt: string; userText: string }) {
      seen.push({ systemPrompt: req.systemPrompt, userText: req.userText });
      return reply === null
        ? ({ ok: false, reason: "error" } as const)
        : ({ ok: true, text: reply } as const);
    },
    async *streamChat() {
      /* لا يُستعمل */
    },
  } as unknown as AIProviderAdapter;
  return { adapter, seen };
}

/** عناوين الفقرات في الموجّه — لا محتوى، أرقامٌ فقط */
const segmentLabels = (userText: string): number[] =>
  [...userText.matchAll(/\[فقرة (\d+)\]/g)].map((m) => Number(m[1]));

/* ═══════ (٦) الجزئي يرسل [1,2] ولا يرسل [0] ═══════ */

describe("★ (٦) الاسترداد الجزئي تحت v2 يستهدف المقاطع الصحيحة", () => {
  const base = () =>
    resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: ONLY_C_VALID,
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 2,
    });

  it("★ الأساس: ثلاثة مقاطع، والمدعوم هو الثالث وحده", () => {
    const b = base();
    expect(b.segmentationVersion).toBe(2);
    expect(b.segments.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
    expect(b.unsupportedSegments).toEqual([0, 1]);
  });

  it("★ الموجّه يحوي المقطعين غير المدعومين فقط — لا المدعوم", async () => {
    const b = base();
    // نُثبّت الحالة المطلوبة في السؤال: المدعوم هو 0، وغير المدعومين [1,2]
    const forced = {
      ...b,
      segments: b.segments.map((s) => ({ ...s, supported: s.segmentIndex === 0 })),
      unsupportedSegments: [1, 2],
    };
    const { adapter, seen } = spyProvider('{"links":[]}');

    await attemptPartialEvidenceRecovery({
      cleanText: forced.cleanText,
      resolved: forced,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
    });

    expect(seen).toHaveLength(1);
    const labels = segmentLabels(seen[0]!.userText);
    // ★ جوهر الإصلاح: 1 و2 حاضران، و0 غائب
    expect(labels).toEqual([1, 2]);
    expect(labels).not.toContain(0);
  });

  it("★ تحت العطل القديم (v1) كان الموجّه يحوي المقطع 0 وحده", async () => {
    const v1 = resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 1,
    });
    const { adapter, seen } = spyProvider('{"links":[]}');
    await attemptPartialEvidenceRecovery({
      cleanText: v1.cleanText,
      resolved: v1,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
    });
    // مقطع واحد يضمّ الادّعاءات الثلاثة — وهذا هو مصدر الخلط
    expect(segmentLabels(seen[0]!.userText)).toEqual([0]);
  });
});

/* ═══════ (٦ب) المقطع 2 يبقى 2 بعد التحقق والدمج ═══════ */

describe("★ (٦ب) الفهرس لا ينزلق عبر الدمج", () => {
  it("★ استشهاد للمقطع 2 يبقى 2 — لا يتحوّل إلى 0", async () => {
    const b = resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 2,
    });
    expect(b.unsupportedSegments).toEqual([0, 1, 2]);

    // النموذج يردّ باستشهاد للمقطع الثالث باقتباس حرفيّ صحيح
    const { adapter } = spyProvider(
      '{"links":[{"segmentIndex":2,"marker":3,"quote":"تغطية الاختبارات تتجاوز ثمانين بالمئة"}]}',
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: b.cleanText,
      resolved: b,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
    });

    expect(out.status).toBe("success");
    expect(out.recoveredSegments).toEqual([2]);
    expect(out.failedSegments).toEqual([0, 1]);

    const merged = out.evidence!;
    expect(merged.segmentationVersion).toBe(2);
    const supported = merged.segments.filter((s) => s.supported);
    // ★ المقطع المدعوم هو 2 وحده — لا 0
    expect(supported.map((s) => s.segmentIndex)).toEqual([2]);
    expect(merged.unsupportedSegments).toEqual([0, 1]);
  });
});

/* ═══════ (٧) الانحدار الأخطر: البنية السابقة للتخزين ═══════ */

describe("★ (٧) الاستشهاد يرتبط حصريًّا بالادّعاء الثالث", () => {
  it("★ صفوف message_citation_segments تحمل segment_index=2 لا 0", async () => {
    const b = resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 2,
    });
    const { adapter } = spyProvider(
      '{"links":[{"segmentIndex":2,"marker":3,"quote":"تغطية الاختبارات تتجاوز ثمانين بالمئة"}]}',
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: b.cleanText,
      resolved: b,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
    });

    /**
     * ★ الإثبات على `buildEvidencePayload` — وهي البنية التي تُمرَّر إلى
     * القاعدة حرفيًّا. الادّعاء على بنية وسيطة لا يثبت ما سيُخزَّن.
     */
    const payload = buildEvidencePayload(out.evidence!);
    expect(payload.segments).toHaveLength(1);
    expect(payload.segments[0]!.segment_index).toBe(2);
    expect(payload.segments[0]!.marker).toBe(3);
    // ولا صفّ واحد يشير إلى الادّعاء الأول أو الثاني
    expect(payload.segments.some((s) => s.segment_index === 0)).toBe(false);
    expect(payload.segments.some((s) => s.segment_index === 1)).toBe(false);
    expect(payload.summary.unsupportedSegments).toEqual([0, 1]);
  });

  it("★ وتحت العطل القديم كان الرقم 0 — أي منسوبًا للادّعاء الأول", () => {
    /**
     * محاكاة الحالة القديمة بدقّة: حلٌّ مسترَدّ قُسّم بـv1 (مقطع واحد
     * فهرسه 0) لنفس النصّ. فالمصدر الذي وُجد لـclaim C كان يحمل الفهرس 0.
     */
    const v1Recovered = resolveRecoveredEvidence({
      cleanText: THREE_CLAIMS,
      links: [
        {
          segmentIndex: 0,
          marker: 3,
          quote: "تغطية الاختبارات تتجاوز ثمانين بالمئة",
        },
      ],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 1,
    });
    const payload = buildEvidencePayload(v1Recovered);
    expect(payload.segments[0]!.segment_index).toBe(0);
    // نفس الاقتباس، ونفس النصّ — ورقمُ فقرةٍ مختلف. هذا هو الخلط بعينه.
  });
});

/* ═══════ (٥) الثابت: لا دمج عبر إصدارين ═══════ */

describe("★ (٥) ثابت الإصدار عند الدمج", () => {
  const v2Base = () =>
    resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 2,
    });

  it("★ اختلاف الإصدار ⇒ يُعاد الأساس بمرجعه بلا دمج", () => {
    const base = v2Base();
    const v1Recovered = resolveRecoveredEvidence({
      cleanText: THREE_CLAIMS,
      links: [
        {
          segmentIndex: 0,
          marker: 3,
          quote: "تغطية الاختبارات تتجاوز ثمانين بالمئة",
        },
      ],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 1,
    });
    expect(v1Recovered.segmentationVersion).toBe(1);
    expect(base.segmentationVersion).toBe(2);

    const merged = mergePartialEvidence(base, v1Recovered, 4);
    // ★ المرجع نفسه: لم يُدمج شيء، ولم يُنسب مصدر إلى فقرة ليست له
    expect(merged).toBe(base);
    expect(merged.unsupportedSegments).toEqual([0, 1, 2]);
  });

  it("★ تساوي الإصدارين ⇒ الدمج يجري كالمعتاد", () => {
    const base = v2Base();
    const v2Recovered = resolveRecoveredEvidence({
      cleanText: THREE_CLAIMS,
      links: [
        {
          segmentIndex: 2,
          marker: 3,
          quote: "تغطية الاختبارات تتجاوز ثمانين بالمئة",
        },
      ],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 2,
    });
    const merged = mergePartialEvidence(base, v2Recovered, 4);
    expect(merged).not.toBe(base);
    expect(merged.segmentationVersion).toBe(2);
    expect(merged.unsupportedSegments).toEqual([0, 1]);
  });
});

/* ═══════ (٨) الاسترداد الكامل يرى ثلاثة مقاطع ═══════ */

describe("★ (٨) الاسترداد الكامل تحت v2", () => {
  it("★ مظروف معطوب + v2 ⇒ الموجّه يحوي ثلاث فقرات لا واحدة", async () => {
    const { adapter, seen } = spyProvider('{"links":[]}');
    await attemptEvidenceRecovery({
      cleanText: THREE_CLAIMS,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
      segmentation: 2,
    });
    expect(segmentLabels(seen[0]!.userText)).toEqual([0, 1, 2]);
  });

  it("★ ونتيجته تحمل الإصدار 2 — فيقبلها الدمج لاحقًا", async () => {
    const { adapter } = spyProvider(
      '{"links":[{"segmentIndex":2,"marker":3,"quote":"تغطية الاختبارات تتجاوز ثمانين بالمئة"}]}',
    );
    const out = await attemptEvidenceRecovery({
      cleanText: THREE_CLAIMS,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
      segmentation: 2,
    });
    expect(out.status).toBe("success");
    expect(out.evidence!.segmentationVersion).toBe(2);
    const payload = buildEvidencePayload(out.evidence!);
    expect(payload.segments[0]!.segment_index).toBe(2);
  });
});

/* ═══════ (٩) التوافق الخلفيّ: v1 كما كان ═══════ */

describe("★ (٩) سلوك v1 لم يتغيّر", () => {
  it("★ الاسترداد الكامل بـv1 يرى مقطعًا واحدًا — كما قبل الإصلاح", async () => {
    const { adapter, seen } = spyProvider('{"links":[]}');
    await attemptEvidenceRecovery({
      cleanText: THREE_CLAIMS,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
      segmentation: 1,
    });
    expect(segmentLabels(seen[0]!.userText)).toEqual([0]);
  });

  it("★ الجزئي بـv1 يرث 1 من الأساس — لا يقفز إلى 2", async () => {
    const b = resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
      segmentation: 1,
    });
    expect(b.segmentationVersion).toBe(1);
    const { adapter } = spyProvider(
      '{"links":[{"segmentIndex":0,"marker":3,"quote":"تغطية الاختبارات تتجاوز ثمانين بالمئة"}]}',
    );
    const out = await attemptPartialEvidenceRecovery({
      cleanText: b.cleanText,
      resolved: b,
      sourceRegistry: registry,
      provider: adapter,
      maxVerifiedSources: 4,
    });
    expect(out.status).toBe("success");
    expect(out.evidence!.segmentationVersion).toBe(1);
    expect(out.recoveredSegments).toEqual([0]);
  });

  it("★ الافتراض بلا إصدار في resolveEvidence ما يزال 1", () => {
    const b = resolveEvidence({
      responseText: THREE_CLAIMS,
      quoteCandidates: [],
      sourceRegistry: registry,
      maxVerifiedSources: 4,
    });
    expect(b.segmentationVersion).toBe(1);
  });
});

/* ═══════ حارس بنيويّ: لا نداء تحليل بلا إصدار ═══════ */

describe("★ حارس المصدر", () => {
  it("★ لا يبقى في وحدة الاسترداد نداءٌ يعتمد الافتراض", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/evidence/evidence-recovery.ts", "utf8");
    const calls = [...src.matchAll(/parseEvidenceMarkers\(([^;]*?)\)\s*;/gs)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // كل نداء يمرّر segmentation صراحةً — لا هبوط ضمنيّ إلى v1
      expect(c[1]).toContain("segmentation");
    }
  });
});
