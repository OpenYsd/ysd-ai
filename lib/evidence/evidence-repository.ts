import "server-only";

import { createHash } from "node:crypto";

import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { ResolvedEvidence } from "@/lib/evidence/resolve-evidence";

/**
 * مستودع كتابة الأدلة (v0.9.0، الإيداع الخامس).
 *
 * الطبقة الوحيدة التي تكتب أدلة الاستشهاد — وهي لا تكتب بنفسها. تُحوّل
 * `ResolvedEvidence` إلى حمولة ضيّقة وتنادي `replace_message_evidence`.
 *
 * ── لماذا لا كتابة مباشرة، ولا حتى عند فشل الدالة ──
 *
 * `service_role` يتجاوز RLS. فكتابةٌ مباشرة على الجدولين من هنا تعني أن كل
 * فحوص 0034 — الملكية، واشتقاق اللقطات، والذرّية — تصير اختيارية: مسارٌ واحد
 * يلتفّ عليها يكفي لإفسادها كلها.
 *
 * ولهذا **لا احتياطي**. فشل الدالة يعني «لا أدلة لهذه الرسالة»، وهو أسوأ ما
 * يمكن أن يقع: الرد يبقى، والفقرات تُوسم غير مدعومة. أما الكتابة الالتفافية
 * فتنتج أدلةً لم يتحقق منها أحد وتبدو كغيرها تمامًا.
 *
 * ── ما يجوز تسجيله ──
 *
 * رمزٌ ثابت، ومرجعٌ مُعمّى، وعدّادات. **لا** `error.message` ولا `details` ولا
 * `hint` — لأن PostgreSQL يضع الصفّ المخالف في `DETAIL` عند مخالفة قيد، ومعه
 * نصّ الاقتباس. وسطرُ سجلٍّ واحد يطبعه يحوّل السجلّات إلى نسخة من ملفات
 * المستخدم بلا أن يظهر في الشيفرة حقلٌ اسمه `quote`.
 */

export type EvidenceWriteCode =
  | "ok"
  /** الرسالة غير موجودة، أو ليست للمستخدم، أو ليست ردَّ مساعد — بلا تفريق */
  | "evidence_not_writable"
  /** الحمولة خالفت حدود 0032/0034 */
  | "evidence_validation_failed"
  /** خطأ غير متوقّع داخل الدالة */
  | "evidence_write_failed"
  /** تعذّر بلوغ الدالة أصلًا: نقل، أو صلاحية، أو مفتاح خدمة غير مضبوط */
  | "evidence_rpc_unavailable"
  /** ردٌّ بشكل غير متوقّع — لا يُفسَّر ولا يُخمَّن */
  | "evidence_rpc_malformed";

export type EvidenceWriteResult =
  | { ok: true; unchanged: boolean; sourcesCount: number; segmentsCount: number }
  | { ok: false; code: Exclude<EvidenceWriteCode, "ok"> };

/** حمولة المصدر — **بلا** file_id ولا اسم ولا صفحة ولا ترتيب: تُشتقّ في القاعدة */
interface EvidenceSourcePayload {
  marker: number;
  chunk_id: string;
  quote: string;
  quote_start: number;
  quote_end: number;
  relevance: number;
  verification: "exact" | "normalized";
}

/** زوجٌ مسطّح يقابل صفًّا في `message_citation_segments` مباشرةً */
interface EvidenceSegmentPayload {
  segment_index: number;
  marker: number;
}

/**
 * مرجعٌ مُعمّى للربط بين السطور.
 *
 * معرّف الرسالة نفسه لا يُطبع: هو مقبضٌ ثابت يربط سطر سجلّ بمحادثة بعينها في
 * القاعدة. والتعمية تكفي للربط بين سطرين ولا تكفي للرجوع إلى الصفّ.
 */
function redact(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/**
 * يبني حمولة الكتابة من `ResolvedEvidence`.
 *
 * منفصلة عن الإرسال كي تُختبر وحدها، ولتكون **القائمة البيضاء** ظاهرة في مكان
 * واحد: ما ليس هنا لا يصل القاعدة، ولو أُضيف حقلٌ إلى `ResolvedEvidenceSource`
 * لاحقًا.
 */
export function buildEvidencePayload(evidence: ResolvedEvidence): {
  sources: EvidenceSourcePayload[];
  segments: EvidenceSegmentPayload[];
  summary: { unsupportedSegments: number[] };
} {
  const sources: EvidenceSourcePayload[] = evidence.sources.map((s) => ({
    marker: s.marker,
    chunk_id: s.chunkId,
    quote: s.quote,
    quote_start: s.quoteStart,
    quote_end: s.quoteEnd,
    relevance: s.relevance,
    verification: s.verification,
  }));

  const known = new Set(sources.map((s) => s.marker));
  const segments: EvidenceSegmentPayload[] = [];
  for (const seg of evidence.segments) {
    for (const marker of seg.sourceMarkers) {
      // حارس مكرّر عمدًا: القاعدة ترفض المجهول، وهذا يمنع رحلةً محكومًا عليها
      if (known.has(marker)) {
        segments.push({ segment_index: seg.segmentIndex, marker });
      }
    }
  }

  return {
    sources,
    segments,
    /**
     * `unsupportedSegments` وحدها تُرسَل: القاعدة لا تعرف عدد فقرات الرد فلا
     * تستطيع اشتقاقها. وكل ما عداها (`supported`، `sourcesCount`،
     * `supportedSegments`) تحسبه بنفسها من الحمولة المُتحقَّقة.
     */
    summary: { unsupportedSegments: evidence.unsupportedSegments },
  };
}

/**
 * يستبدل أدلة رسالة عبر `replace_message_evidence`.
 *
 * لا يرمي أبدًا: فشل كتابة الأدلة لا يجوز أن يُسقط ردًّا سليمًا بين يدي
 * المستخدم. يُعيد الرمز، والمستدعي يقرّر.
 */
export async function replaceMessageEvidence(input: {
  userId: string;
  messageId: string;
  evidence: ResolvedEvidence;
  correlation?: string;
}): Promise<EvidenceWriteResult> {
  const ref = redact(input.messageId);
  const payload = buildEvidencePayload(input.evidence);

  const admin = getAdminClient();
  if (!admin) {
    logger.warn({
      event: "evidence.write",
      code: "evidence_rpc_unavailable",
      ref,
      correlation: input.correlation,
    });
    return { ok: false, code: "evidence_rpc_unavailable" };
  }

  const { data, error } = await admin.rpc("replace_message_evidence", {
    p_user_id: input.userId,
    p_message_id: input.messageId,
    p_sources: payload.sources,
    p_segments: payload.segments,
    p_summary: payload.summary,
  });

  if (error) {
    /**
     * `error.message` و`error.details` و`error.hint` **لا تُلمس**. حتى رمز
     * الخطأ من PostgREST لا يُمرَّر كما هو: نُخرج رمزًا من عندنا، فلا يعتمد
     * أحد على شكل خطأ المزوّد ولا يتسرّب منه تفصيل.
     */
    logger.error({
      event: "evidence.write",
      code: "evidence_rpc_unavailable",
      ref,
      correlation: input.correlation,
      count: payload.sources.length,
    });
    return { ok: false, code: "evidence_rpc_unavailable" };
  }

  const body = data as
    | { ok?: unknown; code?: unknown; unchanged?: unknown; sources_count?: unknown; segments_count?: unknown }
    | null;

  if (!body || typeof body !== "object" || typeof body.ok !== "boolean") {
    logger.error({
      event: "evidence.write",
      code: "evidence_rpc_malformed",
      ref,
      correlation: input.correlation,
    });
    return { ok: false, code: "evidence_rpc_malformed" };
  }

  if (!body.ok) {
    const code: Exclude<EvidenceWriteCode, "ok"> =
      body.code === "evidence_not_writable" ||
      body.code === "evidence_validation_failed" ||
      body.code === "evidence_write_failed"
        ? body.code
        : "evidence_rpc_malformed";
    logger.warn({
      event: "evidence.write",
      code,
      ref,
      correlation: input.correlation,
      count: payload.sources.length,
    });
    return { ok: false, code };
  }

  const sourcesCount = typeof body.sources_count === "number" ? body.sources_count : 0;
  const segmentsCount = typeof body.segments_count === "number" ? body.segments_count : 0;

  logger.info({
    event: "evidence.write",
    code: "ok",
    ref,
    correlation: input.correlation,
    count: sourcesCount,
    // عدّاد لا محتوى — ولا حتى طول اقتباس
    status: body.unchanged === true ? "unchanged" : "replaced",
  });

  return {
    ok: true,
    unchanged: body.unchanged === true,
    sourcesCount,
    segmentsCount,
  };
}
