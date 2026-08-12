import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  EVIDENCE_END,
  EVIDENCE_END_NEAR_MISS,
  EVIDENCE_START,
  EVIDENCE_START_NEAR_MISS,
  extractEvidenceEnvelope,
} from "@/lib/evidence/evidence-envelope";
import { attemptEvidenceRecovery } from "@/lib/evidence/evidence-recovery";
import type { AIProviderAdapter } from "@/lib/ai/types";

/**
 * تشخيص Evidence — رموز مغلقة بدل كلمات تجمع أسبابًا متباينة.
 *
 * `envelopeStatus=malformed` كانت تجمع عشرة شروط، و`recoveryStatus=failed`
 * ثلاث حالات علاجُ كلٍّ منها مختلف. وفي الطلب الحيّ الأخير لم يصل
 * `sentinelStatus` أصلًا إلى ما يُحفظ — لأنني وصلتُه بالمُنتِج ونسيتُ
 * المستهلك، وهو نفس ما وقع في `attemptCount`.
 *
 * لذلك يوجد هنا **اختبار مستهلك**: يُشغّل كتلة `evidenceDiagnostics` الحقيقية
 * من `route.ts` لا نسخةً منها.
 */

const JSON_OK = '{"quotes":[{"marker":1,"quote":"نصّ حرفي منقول من المصدر الأول"}]}';

const wrap = (start: string, end: string | null, body = JSON_OK) => {
  const head = "النتيجة الأولى.\n\nالنتيجة الثانية.\n\n";
  return end === null ? `${head}${start}\n${body}` : `${head}${start}\n${body}\n${end}`;
};

// ════════════════════════════════════════════════════════════
//  A–F — سبب المظروف
// ════════════════════════════════════════════════════════════

describe("A–F — envelopeReason", () => {
  it("★ (A) قانوني صالح ⇒ canonical · none", () => {
    const e = extractEvidenceEnvelope(wrap(EVIDENCE_START, EVIDENCE_END));
    expect(e.status).toBe("valid");
    expect(e.sentinelStatus).toBe("canonical");
    expect(e.sentinelRepairApplied).toBe(false);
    expect(e.reason).toBe("none");
    expect(e.repairedButInvalid).toBe(false);
  });

  it("★ (B) ناقص مُقوَّم وصالح ⇒ repaired · none", () => {
    const e = extractEvidenceEnvelope(wrap(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS));
    expect(e.status).toBe("valid");
    expect(e.sentinelStatus).toBe("repaired_missing_trailing_gt");
    expect(e.sentinelRepairApplied).toBe(true);
    expect(e.reason).toBe("none");
    expect(e.repairedButInvalid).toBe(false);
  });

  /**
   * ★ (C) التقويم يُسجَّل منفصلًا عن السبب.
   *
   * `reason` يبقى على السبب **الحقيقي** للفساد، و`repairedButInvalid` يقول
   * إن التقويم سبقه. لو جعلنا السبب نفسه «قُوّم ثم فسد» لأخفينا ما نحتاجه.
   */
  it("★ (C) ناقص + JSON فاسد ⇒ json_parse_failed مع repairedButInvalid", () => {
    const e = extractEvidenceEnvelope(
      wrap(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS, "{ليس JSON}"),
    );
    expect(e.status).toBe("malformed");
    expect(e.sentinelRepairApplied).toBe(true);
    expect(e.reason).toBe("json_parse_failed"); // ★ السبب الأصلي محفوظ
    expect(e.repairedButInvalid).toBe(true);
  });

  it("★ (D) بلا سنتينل نهاية ⇒ missing_end_sentinel", () => {
    const e = extractEvidenceEnvelope(wrap(EVIDENCE_START, null));
    expect(e.status).toBe("malformed");
    expect(e.reason).toBe("missing_end_sentinel");
  });

  it("★ (E) كتلتان ⇒ duplicate_block", () => {
    const two = `${wrap(EVIDENCE_START, EVIDENCE_END)}\n${EVIDENCE_START}\n${JSON_OK}\n${EVIDENCE_END}`;
    const e = extractEvidenceEnvelope(two);
    expect(e.status).toBe("malformed");
    expect(e.reason).toBe("duplicate_block");
  });

  /** ★ (F) JSON صالح بعقد خاطئ — يُفصل عن فشل التحليل */
  it("★ (F) JSON صالح ومخطط خاطئ ⇒ schema_invalid", () => {
    for (const body of ['{"links":[]}', '{"quotes":[],"extra":1}', '{"quotes":"نص"}', "[1,2]"]) {
      const e = extractEvidenceEnvelope(wrap(EVIDENCE_START, EVIDENCE_END, body));
      expect(e.status).toBe("malformed");
      expect(e.reason).toBe("schema_invalid");
    }
  });

  it("★ نصّ بعد سنتينل النهاية ⇒ text_after_end", () => {
    const e = extractEvidenceEnvelope(
      `${wrap(EVIDENCE_START, EVIDENCE_END)}\nكلامٌ بعد الكتلة.`,
    );
    expect(e.reason).toBe("text_after_end");
  });

  it("★ نصّ قبل البداية في سطرها ⇒ text_before_start", () => {
    const e = extractEvidenceEnvelope(
      `مقدمة. ${EVIDENCE_START}\n${JSON_OK}\n${EVIDENCE_END}`,
    );
    expect(e.status).toBe("malformed");
    expect(["text_before_start", "start_not_at_line_start"]).toContain(e.reason);
  });

  it("★ بلا سنتينل ⇒ absent · none", () => {
    const e = extractEvidenceEnvelope("جواب عادي بلا أي كتلة.");
    expect(e.status).toBe("missing");
    expect(e.sentinelStatus).toBe("absent");
    expect(e.reason).toBe("none");
  });
});

// ════════════════════════════════════════════════════════════
//  G–K — سبب فشل الاسترداد
// ════════════════════════════════════════════════════════════

const registry = [
  {
    marker: 1,
    snippet: {
      chunkId: "c1",
      fileId: "f1",
      chunkIndex: 0,
      fileName: "ملف.pdf",
      pageNumber: 1,
      content: "خبرة عملية منذ عام 2023 في تطوير الأنظمة الخلفية وقواعد البيانات.",
      similarity: 0.9,
    },
  },
];

const CLEAN = "النتيجة الأولى عن الخبرة العملية [[1]].";

/** مزوّد مُحاكى: يتحكّم الاختبار في نتيجة نداء JSON */
const provider = (reply: string | null): AIProviderAdapter =>
  ({
    id: "groq",
    displayName: "groq",
    isConfigured: () => true,
    listModels: () => [],
    async requestJsonCompletion() {
      return reply === null
        ? ({ ok: false, reason: "error" } as const)
        : ({ ok: true, text: reply } as const);
    },
    async *streamChat() {
      /* لا يُستعمل */
    },
  }) as unknown as AIProviderAdapter;

const recover = (reply: string | null) =>
  attemptEvidenceRecovery({
    cleanText: CLEAN,
    sourceRegistry: registry,
    provider: provider(reply),
    maxVerifiedSources: 4,
  });

describe("G–K — recoveryFailureReason", () => {
  it("★ (G) نداء المحوّل لم ينجح ⇒ provider_error", async () => {
    const r = await recover(null);
    expect(r.status).toBe("failed");
    expect(r.telemetry.failureReason).toBe("provider_error");
    expect(r.telemetry.providerCallAttempted).toBe(true);
    // ★ ولا ندّعي أن الطلب بلغ المزوّد الخارجي — المحوّل لا يقول ذلك
    expect(r.telemetry.providerCallSucceeded).toBe(false);
  });

  it("★ (H) ردّ غير قابل للتحليل ⇒ unparseable", async () => {
    const r = await recover("ليس JSON إطلاقًا");
    expect(r.telemetry.failureReason).toBe("unparseable");
    expect(r.telemetry.providerCallSucceeded).toBe(true);
    expect(r.telemetry.linksReturned).toBe(0);
  });

  it("★ (I) روابط فارغة ⇒ no_links", async () => {
    const r = await recover('{"links":[]}');
    expect(r.telemetry.failureReason).toBe("no_links");
    expect(r.telemetry.providerCallSucceeded).toBe(true);
    expect(r.telemetry.linksReturned).toBe(0);
  });

  /** ★ (J) الفرق الحاسم: وصلت روابط لكن المُتحقِّق أسقطها كلها */
  it("★ (J) اقتباسات ملفّقة ⇒ no_verified_quote", async () => {
    const r = await recover(
      '{"links":[{"segmentIndex":0,"marker":1,"quote":"نصّ مخترع لا وجود له في المصدر"}]}',
    );
    expect(r.telemetry.failureReason).toBe("no_verified_quote");
    expect(r.telemetry.linksReturned).toBe(1); // ★ وصلت
    expect(r.telemetry.verifiedSources).toBe(0); // ★ ولم ينجُ منها شيء
    expect(r.evidence).toBeNull();
  });

  it("★ (K) اقتباس حرفي ⇒ success · none", async () => {
    const r = await recover(
      '{"links":[{"segmentIndex":0,"marker":1,"quote":"خبرة عملية منذ عام 2023 في تطوير الأنظمة"}]}',
    );
    expect(r.status).toBe("success");
    expect(r.telemetry.failureReason).toBe("none");
    expect(r.telemetry.verifiedSources).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
//  ★ (L) المستهلك — ما يُحفظ فعلًا
// ════════════════════════════════════════════════════════════

/**
 * ★ الحارس الذي كان غائبًا.
 *
 * الحقلان كانا يُملآن في المظروف ولا يصلان `evidenceDiagnostics` — واختباري
 * السابق فحص المُنتِج وحده فمرّ أخضر على عطلٍ قائم. هذا يُشغّل كتلة المسار
 * **الحقيقية** المستخرَجة من الملف، لا نسخةً مكتوبة يدويًا.
 */
describe("★ (L) اختبار المستهلك — التخزين", () => {
  const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

  /** يستخرج جسم كائن `evidenceDiagnostics` من المصدر ويُشغّله */
  function buildDiagnostics(scope: Record<string, unknown>): Record<string, unknown> {
    const head = "evidenceDiagnostics = {";
    const at = ROUTE.indexOf(head);
    expect(at).toBeGreaterThan(0);
    let i = at + head.length;
    let depth = 1;
    while (i < ROUTE.length && depth > 0) {
      const ch = ROUTE[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) break;
      i++;
    }
    const body = ROUTE.slice(at + head.length, i);
    const keys = Object.keys(scope);
    const fn = new Function(...keys, `return {${body}};`) as (
      ...a: unknown[]
    ) => Record<string, unknown>;
    return fn(...keys.map((k) => scope[k]));
  }

  it("★ القيم تُحفظ فعلًا — لا في المُنتِج وحده", () => {
    const envelope = extractEvidenceEnvelope(
      wrap(EVIDENCE_START_NEAR_MISS, EVIDENCE_END_NEAR_MISS, "{ليس JSON}"),
    );
    // الحالة المرصودة حيًّا بالضبط
    expect(envelope.sentinelStatus).toBe("repaired_missing_trailing_gt");
    expect(envelope.sentinelRepairApplied).toBe(true);
    expect(envelope.reason).toBe("json_parse_failed");

    const saved = buildDiagnostics({
      envelope,
      resolved: {
        stats: {
          requestedMarkers: 2,
          verifiedSources: 0,
          droppedUnknownMarkers: 0,
          droppedMissingQuotes: 0,
          droppedInvalidQuotes: 0,
          droppedInvalidRelevance: 0,
          droppedByPlanLimit: 0,
        },
        unsupportedSegments: [0, 1],
        segments: [],
        sources: [],
        numberedClaimCount: 3,
      },
      chosenSegmentationVersion: 1,
      layoutLineCount: 7,
      layoutOmittedOversize: false,
      evidenceLayout: { v: 1, lines: [0, 0, -1, 1, 1, -1, 2] },
      recoveryStatus: "failed",
      recoveryReason: "malformed_envelope",
      recoveryTel: {
        providerCallAttempted: true,
        providerCallSucceeded: true,
        linksReturned: 0,
        linksScoped: 0,
        verifiedSources: 0,
        failureReason: "no_links",
      },
      partialRequested: [],
      partialRecovered: [],
      partialFailed: [],
      partialBudget: null,
      partialLinksReturned: 0,
      sourceRegistry: registry,
    });

    // ★ نفس القيم التي أنتجها المظروف — مُخزَّنة لا ضائعة
    expect(saved.sentinelStatus).toBe("repaired_missing_trailing_gt");
    expect(saved.sentinelRepairApplied).toBe(true);
    expect(saved.envelopeReason).toBe("json_parse_failed");
    expect(saved.repairedButInvalid).toBe(true);
    // وتفكيك سبب الفشل يصل كذلك
    expect(saved.recoveryFailureReason).toBe("no_links");
    expect(saved.recoveryProviderCallAttempted).toBe(true);
    expect(saved.recoveryProviderCallSucceeded).toBe(true);
    expect(saved.recoveryVerifiedSources).toBe(0);

    // ★ (v0.9.2) قياسات التقسيم تُخزَّن هي الأخرى — لا في المُنتِج وحده
    expect(saved.evidenceSegmentationVersion).toBe(1);
    expect(saved.detectedNumberedClaimCount).toBe(3);
    expect(saved.parsedSegmentCount).toBe(0);
    // الفجوة = مرقّمة مكتشفة − مقاطع محلَّلة، وهي بالضبط ما رُصد حيًّا
    expect(saved.numberedClaimCoverageGap).toBe(3);
    expect(saved.layoutLineCount).toBe(7);
    expect(saved.layoutOmittedOversize).toBe(false);
    // إنذار لا تقرير: التخطيط يُبنى بالإصدار المختار نفسه فلا يفترقان
    expect(saved.layoutVersionMismatch).toBe(false);
  });

  it("★ التشخيص المحفوظ أرقام ورموز — بلا أي محتوى", () => {
    const at = ROUTE.indexOf("evidenceDiagnostics = {");
    const block = ROUTE.slice(at, at + 2_000);
    for (const bad of ["quote:", "fileName", "snippet.content", "assistantText", "userText"]) {
      expect(block).not.toContain(bad);
    }
  });
});
