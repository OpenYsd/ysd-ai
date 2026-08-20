import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { isConsentActive, readTrainingConsent } from "./consent";
import { computeContentFingerprint } from "./fingerprint";
import { redactForReview, screenPrivacy, type PrivacyReasonCode } from "./privacy";
import { screenQuality, type QualityReasonCode } from "./quality";

/**
 * إعادة التحقّق من مرشّح تدريب (v0.9.5، المرحلة 2B).
 *
 * ── لماذا يوجد هذا الملفّ ──
 *
 * لأن المرشّح **مرجعٌ لا نسخة**. وقتَ المشاركة كان صحيحًا؛ وبين تلك اللحظة
 * وأيّ قرارٍ لاحق يستطيع صاحبه أن يعدّل رسالته، أو يحذفها، أو يسحب إذنه —
 * ولا يعلم الصفُّ المخزَّن بشيءٍ من ذلك.
 *
 * فالحقول المحفوظة في المرشّح **ليست حكمًا صالحًا**، بل أثرُ حكمٍ مضى.
 * ومن يقرؤها ويقرّر بها يقرّر على ماضٍ.
 *
 * ── والبصمة هي الشاهد ──
 *
 * تُحسب من النصّ **الحاليّ** بالتطبيع والفاصل والخوارزمية نفسها، ثم تُقارن
 * بالمخزَّنة. فاختلافُها يقول: هذا ليس ما وافق عليه صاحبه. ولا نُحدّث
 * المخزَّنة لتوافق الجديد — المرشّح يمثّل ما اختاره المستخدم وقتَ اختاره،
 * وتحديثُ البصمة يجعله يمثّل شيئًا لم يُختَر.
 *
 * ── والباب واحد ──
 *
 *   ★ كل تصديرٍ مستقبليّ يمرّ من هنا. حتى المرشّح **المعتمَد**.
 *
 * لأن الاعتماد أيضًا حكمٌ في لحظة، والمصدر يتغيّر بعده كما يتغيّر قبله.
 * وحارسٌ يُستدعى مرّةً عند الاعتماد ثم يُوثَق به عند التصدير هو حارسٌ
 * يحرس اللحظة الخطأ.
 */

/** ما يمنع المراجعة أصلًا — فلا معاينة ولا قرار */
export type RevalidationFailure =
  | "not_found"
  | "consent_inactive"
  | "source_deleted"
  | "source_changed"
  | "not_owner"
  | "before_consent"
  | "role_mismatch"
  | "already_decided"
  | "database_error";

/** ما يمنع الاعتماد وحده — والمعاينة قائمة ليُرفض عن علم */
export type ApprovalBlocker = "privacy_finding" | "quality_rejected";

export interface CandidateRow {
  id: string;
  user_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  source: string;
  status: string;
  privacy_status: string;
  quality_status: string;
  content_fingerprint: string;
  created_at: string;
  decided_at: string | null;
}

export interface RevalidationOk {
  ok: true;
  /** هل يجوز أن يُعتمد **الآن**؟ */
  approvable: boolean;
  blockers: ApprovalBlocker[];
  privacyCodes: PrivacyReasonCode[];
  qualityCodes: QualityReasonCode[];
  /** النصّ الحاليّ للزوج — يُقرأ عند الطلب ولا يُخزَّن */
  preview: { userText: string; assistantText: string; redacted: boolean };
  candidate: CandidateRow;
}

export type RevalidationResult =
  | RevalidationOk
  | { ok: false; reason: RevalidationFailure };

export interface RevalidationDependencies {
  getAdminClient: typeof getAdminClient;
  readConsent: typeof readTrainingConsent;
}

const DEFAULTS: RevalidationDependencies = { getAdminClient, readConsent: readTrainingConsent };

const CANDIDATE_COLUMNS =
  "id, user_id, conversation_id, user_message_id, assistant_message_id, source, status, " +
  "privacy_status, quality_status, content_fingerprint, created_at, decided_at";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string | null;
  deleted_at: string | null;
  metadata: unknown;
}

/** غيابُ `metadata.completion` يعني مكتملًا — عقدُ المسار منذ v0.7.0 */
function readCompletion(metadata: unknown): { status: string | null; reason: string | null } {
  if (typeof metadata !== "object" || metadata === null) return { status: null, reason: null };
  const c = (metadata as Record<string, unknown>).completion;
  if (typeof c !== "object" || c === null) return { status: null, reason: null };
  const rec = c as Record<string, unknown>;
  return {
    status: typeof rec.status === "string" && rec.status.length > 0 ? rec.status : null,
    reason: typeof rec.reason === "string" && rec.reason.length > 0 ? rec.reason : null,
  };
}

/** طابعٌ غائب أو غير مقروء ⇒ «قبل الإذن» — كما في بوّابة الإدخال */
function isAfter(createdAt: string | null, grantedAt: string | null): boolean {
  if (typeof createdAt !== "string" || typeof grantedAt !== "string") return false;
  const c = Date.parse(createdAt);
  const g = Date.parse(grantedAt);
  if (Number.isNaN(c) || Number.isNaN(g)) return false;
  return c >= g;
}

/**
 * ★ يعيد التحقّق من مرشّحٍ بقراءة مصدره **الآن** — ولا يثق بحقلٍ مخزَّن.
 *
 * @param requirePending عند القرار: المرشّح لم يُحسم بعد. وعند المراجعة
 *   وحدها يجوز تركها، فقراءةُ محسومٍ لا تضرّ.
 */
export async function revalidateTrainingCandidate(
  candidateId: string,
  options: { requirePending?: boolean } = {},
  deps: Partial<RevalidationDependencies> = {},
): Promise<RevalidationResult> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  // ── (١) المرشّح ──
  let candidate: CandidateRow;
  try {
    const { data, error } = await db
      .from("training_candidates")
      .select(CANDIDATE_COLUMNS)
      .eq("id", candidateId)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as unknown as CandidateRow[];
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    candidate = rows[0]!;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  if (options.requirePending === true && candidate.status !== "pending") {
    return { ok: false, reason: "already_decided" };
  }

  /**
   * ★ (٢) الإذن قبل أن يُقرأ نصّ العيّنة.
   *
   * وهو الترتيب نفسه الذي في بوّابة الإدخال، لسببه نفسه: من سحب إذنه لا
   * يُقرأ كلامه لغرضٍ سحب إذنه منه — ولو كان القارئ مراجِعًا يريد رفضها.
   */
  const consent = await d.readConsent(db, candidate.user_id);
  if (!isConsentActive(consent)) return { ok: false, reason: "consent_inactive" };

  // ── (٣) المحادثة: حيّة، ومملوكة لصاحب المرشّح ──
  try {
    const { data, error } = await db
      .from("conversations")
      .select("id, user_id, deleted_at")
      .eq("id", candidate.conversation_id)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { id: string; user_id: string; deleted_at: string | null }[];
    if (rows.length === 0) return { ok: false, reason: "source_deleted" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    const conv = rows[0]!;
    if (conv.user_id !== candidate.user_id) return { ok: false, reason: "not_owner" };
    if (conv.deleted_at !== null) return { ok: false, reason: "source_deleted" };
  } catch {
    return { ok: false, reason: "database_error" };
  }

  // ── (٤) الرسالتان ──
  let userMsg: MessageRow | undefined;
  let assistantMsg: MessageRow | undefined;
  try {
    const { data, error } = await db
      .from("messages")
      .select("id, conversation_id, role, content, created_at, deleted_at, metadata")
      .in("id", [candidate.user_message_id, candidate.assistant_message_id])
      .limit(4);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as MessageRow[];
    userMsg = rows.find((m) => m.id === candidate.user_message_id);
    assistantMsg = rows.find((m) => m.id === candidate.assistant_message_id);
  } catch {
    return { ok: false, reason: "database_error" };
  }

  if (!userMsg || !assistantMsg) return { ok: false, reason: "source_deleted" };
  if (userMsg.deleted_at !== null || assistantMsg.deleted_at !== null) {
    return { ok: false, reason: "source_deleted" };
  }
  if (
    userMsg.conversation_id !== candidate.conversation_id ||
    assistantMsg.conversation_id !== candidate.conversation_id
  ) {
    return { ok: false, reason: "not_owner" };
  }
  if (userMsg.role !== "user" || assistantMsg.role !== "assistant") {
    return { ok: false, reason: "role_mismatch" };
  }
  if (
    !isAfter(userMsg.created_at, consent.grantedAt) ||
    !isAfter(assistantMsg.created_at, consent.grantedAt)
  ) {
    /**
     * ولا يكفي أن الإذن قائمٌ الآن: سحبٌ ثم منحٌ جديد يُجدّد `granted_at`،
     * فيصير ما شورك تحت الإذن الأول سابقًا للإذن القائم. وهو كذلك فعلًا —
     * القرار الجديد قرارٌ جديد لا استئنافٌ لقديم.
     */
    return { ok: false, reason: "before_consent" };
  }

  /**
   * ★ (٥) البصمة — الشاهد على أن النصّ هو النصّ.
   *
   * ولا تُحدَّث المخزَّنة عند الاختلاف. المرشّح يمثّل ما اختاره صاحبه في
   * لحظة اختياره؛ ومن يُحدّث البصمة يجعله يمثّل شيئًا لم يُعرض عليه.
   * والنصّ الجديد — إن أراده — يُشارَك من جديد فيُنشئ مرشّحًا ببصمته.
   */
  const current = computeContentFingerprint(userMsg.content, assistantMsg.content);
  if (current !== candidate.content_fingerprint) {
    return { ok: false, reason: "source_changed" };
  }

  // ── (٦) البوّابتان تُعادان على النصّ الحاليّ لا على الحكم المخزَّن ──
  const stored = readCompletion(assistantMsg.metadata);
  const quality = screenQuality({
    userText: userMsg.content,
    assistantText: assistantMsg.content,
    userRole: userMsg.role,
    assistantRole: assistantMsg.role,
    errorCode: stored.reason,
    completion: stored.status,
    clientAborted: false,
  });

  const privacy = screenPrivacy(`${userMsg.content}\n${assistantMsg.content}`);

  const blockers: ApprovalBlocker[] = [];
  if (quality.status !== "passed") blockers.push("quality_rejected");
  /**
   * ★ ووجودُ ما يُكشف حتميًّا يمنع الاعتماد — ولا يُتجاوَز بيدٍ.
   *
   * المراجعة اليدوية تُضيف حكمًا حيث لا يملك الفحص حكمًا (`needs_review`)،
   * ولا تنقض حكمًا يملكه. ولو جاز التجاوز لَصار الفحص اقتراحًا، ولَكفى
   * ضغطُ زرٍّ في يومٍ مزدحم لإدخال مفتاحٍ أو بريدِ إنسان إلى بنك تدريب.
   */
  if (privacy.status === "rejected") blockers.push("privacy_finding");

  const userPreview = redactForReview(userMsg.content);
  const assistantPreview = redactForReview(assistantMsg.content);

  return {
    ok: true,
    approvable: blockers.length === 0,
    blockers,
    privacyCodes: privacy.reasonCodes,
    qualityCodes: quality.reasonCodes,
    preview: {
      userText: userPreview.text,
      assistantText: assistantPreview.text,
      redacted: userPreview.redacted || assistantPreview.redacted,
    },
    candidate,
  };
}
