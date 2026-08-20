import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { computeContentFingerprint } from "./fingerprint";
import { isConsentActive, readTrainingConsent } from "./consent";
import { screenPrivacy, type PrivacyReasonCode } from "./privacy";
import { screenQuality, type QualityReasonCode } from "./quality";

/**
 * إنشاء مرشّح تدريب (v0.9.4، المرحلة الأولى) — **خاملٌ بالتصميم**.
 *
 * ── لا يُستدعى من مسار المحادثة ──
 *
 * وذلك قرارٌ لا سهو. مستخدمٌ يرسل رسالة لا ينتظر بنك تدريب: كل عملٍ
 * يُضاف إلى مساره الساخن يدفع ثمنه هو. والربط — إن جاء — يكون بعد اكتمال
 * الرد وخارج طريقه.
 *
 * فهذه الوحدة تُبنى وتُختبر ولا يناديها شيء بعد. وحارسٌ في الاختبارات
 * يمنع أن يستوردها المسار سهوًا.
 *
 * ── والترتيب هو الأمان ──
 *
 *   الموافقة ⇐ الملكية ⇐ الحياة ⇐ زمن الإذن ⇐ الجودة ⇐ الخصوصية ⇐ البصمة ⇐ الكتابة
 *
 * والموافقة أولًا لأن ما بعدها **يقرأ كلام إنسان**. فمن لم يأذن لا يُقرأ
 * كلامه لغرضٍ لم يأذن به، ولو كان القارئ سطرَ شيفرةٍ يحسب بصمة.
 */

export type CandidateRejection =
  | "consent_missing"
  | "source_not_found"
  | "source_deleted"
  | "not_owner"
  | "before_consent"
  | "quality_rejected"
  | "privacy_rejected"
  | "duplicate"
  | "database_error";

export type CandidateResult =
  | { ok: true; created: true; candidateId: string; privacyStatus: string }
  | { ok: false; reason: CandidateRejection; privacyCodes?: PrivacyReasonCode[]; qualityCodes?: QualityReasonCode[] };

export interface CandidateInput {
  userId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  source?: "user_opt_in" | "thumbs_up" | "user_correction" | "admin_curated" | "synthetic_evaluation";
  /** ما سجّله المسار عن حال الرد — لا نصّه */
  errorCode?: string | null;
  completion?: string | null;
  clientAborted?: boolean;
}

export interface CandidateDependencies {
  getAdminClient: typeof getAdminClient;
  readConsent: typeof readTrainingConsent;
}

const DEFAULTS: CandidateDependencies = {
  getAdminClient,
  readConsent: readTrainingConsent,
};

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string | null;
  deleted_at: string | null;
  metadata: unknown;
}

/**
 * حال الرد كما سجّله مسار المحادثة في `metadata.completion` — لا نصّه.
 *
 * وغيابُ الحقل يعني **مكتمل**: هذا عقد المسار منذ v0.7.0، والرسائل التي
 * سبقته تبقى صالحة بلا ترحيل. أما الردّ المقطوع أو المعطوب فيُوسَم صراحةً،
 * ولا يُوسَم ردٌّ مقطوعٌ مكتملًا أبدًا.
 */
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

/**
 * ★ هل وقع هذا الكلام **بعد** الإذن؟
 *
 * ويفشل مغلقًا: طابعٌ غائب أو غير مقروء ⇒ «لا». فما لا يُثبت أنه بعد
 * الموافقة يُعامل كأنه قبلها — لأن الخطأ في الاتجاه الآخر يُدخل كلامًا لم
 * يأذن به صاحبه، وذلك ما لا يُصلَح بعد وقوعه.
 */
function isAfter(createdAt: string | null, grantedAt: string | null): boolean {
  if (typeof createdAt !== "string" || typeof grantedAt !== "string") return false;
  const c = Date.parse(createdAt);
  const g = Date.parse(grantedAt);
  if (Number.isNaN(c) || Number.isNaN(g)) return false;
  return c >= g;
}

interface ConversationRow {
  id: string;
  user_id: string;
  deleted_at: string | null;
}

/**
 * ★ يُنشئ مرشّحًا — أو يرفض برمزٍ مغلق.
 *
 * ولا يُعيد نصًّا ولا بصمةً ولا سببًا خامًّا من القاعدة.
 */
export async function createTrainingCandidate(
  input: CandidateInput,
  deps: Partial<CandidateDependencies> = {},
): Promise<CandidateResult> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  /**
   * ★ (١) الموافقة قبل كل شيء — وقبل قراءة أي كلام.
   *
   * وتُفحص سريانها لا عَلَمها: ملغاةٌ أو لنسخة نصٍّ قديمة ⇒ لا.
   */
  const consent = await d.readConsent(db, input.userId);
  if (!isConsentActive(consent)) return { ok: false, reason: "consent_missing" };

  // ── (٢) المحادثة: موجودة، غير محذوفة، ومملوكة لمن يدّعيها ──
  let conversation: ConversationRow | null;
  try {
    const { data, error } = await db
      .from("conversations")
      .select("id, user_id, deleted_at")
      .eq("id", input.conversationId)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as ConversationRow[];
    if (rows.length === 0) return { ok: false, reason: "source_not_found" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    conversation = rows[0]!;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  if (conversation.user_id !== input.userId) return { ok: false, reason: "not_owner" };
  if (conversation.deleted_at !== null) return { ok: false, reason: "source_deleted" };

  // ── (٣) الرسالتان: من هذه المحادثة، حيّتان، وبدوريهما ──
  let messages: MessageRow[];
  try {
    const { data, error } = await db
      .from("messages")
      .select("id, conversation_id, role, content, created_at, deleted_at, metadata")
      .in("id", [input.userMessageId, input.assistantMessageId])
      .limit(4);
    if (error) return { ok: false, reason: "database_error" };
    messages = (data ?? []) as MessageRow[];
  } catch {
    return { ok: false, reason: "database_error" };
  }

  const userMsg = messages.find((m) => m.id === input.userMessageId);
  const assistantMsg = messages.find((m) => m.id === input.assistantMessageId);
  if (!userMsg || !assistantMsg) return { ok: false, reason: "source_not_found" };
  if (userMsg.id === assistantMsg.id) return { ok: false, reason: "source_not_found" };

  /**
   * ★ الرسالتان من محادثةٍ واحدة — والمحادثة مملوكة لصاحب الطلب.
   *
   * والقاعدة تحرس هذا بمرجعٍ مركّب كذلك؛ وهذا الفحص يمنع الرحلة الضائعة
   * ويعطي رمزًا مفهومًا بدل خطأ قيد.
   */
  if (
    userMsg.conversation_id !== input.conversationId ||
    assistantMsg.conversation_id !== input.conversationId
  ) {
    return { ok: false, reason: "not_owner" };
  }
  if (userMsg.deleted_at !== null || assistantMsg.deleted_at !== null) {
    return { ok: false, reason: "source_deleted" };
  }

  /**
   * ── (٤) حدّ الموافقة الزمنيّ — **لا عيّنة بأثر رجعيّ** ──
   *
   * ما قيل قبل الإذن قيل بلا إذن. واختيارُ المستخدم اليوم أن يشارك محادثةً
   * قديمة لا يجعل كلام الأمس مأذونًا: هو يملك أن يأذن لما هو آتٍ ولما وقع
   * تحت إذنٍ قائم، ولا يملك أن يُنشئ إذنًا في الماضي.
   *
   * ── ولماذا هنا لا في المستدعي ──
   *
   * لأن مستدعيًا يُكتب بعد سنة لن يقرأ هذه الفقرة. وشرطٌ يعيش في طبقةٍ
   * أعلى يسقط أوّل ما يُضاف طريقٌ ثانٍ إلى البنك — وهذا بالضبط ما يقع
   * حين يُبنى الالتقاط التلقائيّ. فيسكن الشرط حيث لا يُلتَفّ عليه: في
   * الباب الوحيد الذي يمرّ منه كل مرشّح.
   *
   * ── والقياس على الرسالتين ──
   *
   * لا على `conversations.created_at`. فمحادثةٌ بدأت قبل الإذن قد تحمل
   * أزواجًا وقعت بعده، وهي مأذونة؛ والقياس على بدء المحادثة كان سيرفضها
   * كلها أو — لو قِيس على آخر تحديث — يقبل ما قبل الإذن معها.
   */
  if (
    !isAfter(userMsg.created_at, consent.grantedAt) ||
    !isAfter(assistantMsg.created_at, consent.grantedAt)
  ) {
    return { ok: false, reason: "before_consent" };
  }

  /**
   * ── (٥) الجودة: حتميّة، وتسبق الخصوصية لأنها أرخص ──
   *
   * ★ وحالُ الردّ يُقرأ من القاعدة لا من المستدعي.
   *
   * `screenQuality` تأخذ `completion` و`errorCode` وسيطين — وسيطٌ يُملأ من
   * الخارج بابٌ يُفتح بحسن نيّة: مستدعٍ ينسى تمريره فيمرّ ردٌّ مقطوع كأنه
   * تامّ. والمسار كتب الحقيقة في `metadata.completion` لحظة الحفظ، فتُقرأ
   * من هناك. وما يمرّره المستدعي يُضمّ ولا يَنسخ: الأشدّ يفوز.
   */
  const stored = readCompletion(assistantMsg.metadata);
  const quality = screenQuality({
    userText: userMsg.content,
    assistantText: assistantMsg.content,
    userRole: userMsg.role,
    assistantRole: assistantMsg.role,
    errorCode: input.errorCode ?? stored.reason,
    completion: input.completion ?? stored.status,
    clientAborted: input.clientAborted === true,
  });
  if (quality.status !== "passed") {
    return { ok: false, reason: "quality_rejected", qualityCodes: quality.reasonCodes };
  }

  // ── (٦) الخصوصية على النصّين معًا ──
  const privacy = screenPrivacy(`${userMsg.content}\n${assistantMsg.content}`);
  if (privacy.status === "rejected") {
    return { ok: false, reason: "privacy_rejected", privacyCodes: privacy.reasonCodes };
  }

  // ── (٧) البصمة ثم الكتابة ──
  const digest = computeContentFingerprint(userMsg.content, assistantMsg.content);

  try {
    const { data, error } = await db
      .from("training_candidates")
      .insert({
        user_id: input.userId,
        conversation_id: input.conversationId,
        user_message_id: input.userMessageId,
        assistant_message_id: input.assistantMessageId,
        source: input.source ?? "user_opt_in",
        status: "pending",
        privacy_status: privacy.status,
        quality_status: quality.status,
        privacy_reason_codes: privacy.reasonCodes,
        quality_reason_codes: quality.reasonCodes,
        content_fingerprint: digest,
      })
      .select("id")
      .limit(1);

    if (error) {
      /**
       * ★ التكرار يُميَّز عن العطل.
       *
       * `23505` انتهاكُ فرادة — أي أن هذا الزوج مسجَّل سلفًا. وهو ليس
       * عطلًا بل نتيجة، والفهرس هو ما يجعلها آمنة تحت التزامن: فحصٌ ثم
       * إدراج في التطبيق كان سيسمح لطلبين متزامنين بالمرور معًا.
       */
      if (error.code === "23505") return { ok: false, reason: "duplicate" };
      return { ok: false, reason: "database_error" };
    }

    const id = (data ?? [])[0]?.id;
    if (typeof id !== "string") return { ok: false, reason: "database_error" };
    return { ok: true, created: true, candidateId: id, privacyStatus: privacy.status };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

/**
 * ★ الإبطال — يجعل الإلغاء فعّالًا لا إعلانًا.
 *
 * يُبطل كل مرشّحٍ لم يخرج بعد. ولا حالة `exported` في هذه المرحلة، فكل
 * ما في البنك قابلٌ للإبطال بالبناء — وهذا ما يجعل الوعد بالإلغاء صادقًا.
 *
 * ولا يُقال إن أوزانًا دُرّبت يمكن أن تُنسي شيئًا: البنك لا يصل إليها بعد،
 * وهذه هي اللحظة الوحيدة التي يكون فيها الإلغاء كاملًا فعلًا.
 */
export async function revokeUserCandidates(
  userId: string,
  deps: Partial<CandidateDependencies> = {},
): Promise<{ ok: true; revoked: number } | { ok: false; reason: "database_error" }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const now = new Date().toISOString();
  try {
    const { data, error } = await db
      .from("training_candidates")
      .update({ status: "revoked", revoked_at: now, updated_at: now })
      .eq("user_id", userId)
      .in("status", ["pending", "approved"])
      .select("id");
    if (error) return { ok: false, reason: "database_error" };
    return { ok: true, revoked: (data ?? []).length };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}
