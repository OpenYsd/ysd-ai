import "server-only";

/**
 * بوّابة الجودة لبنك التدريب (v0.9.4، المرحلة الأولى) — **حتميّة لا حَكَم**.
 *
 * ── ما تفعله ──
 *
 * ترفض ما نعرف يقينًا أنه لا يصلح للتعلّم: ردٌّ فارغ، أو مقطوع، أو ملغى،
 * أو ناتجٌ عن عطل مزوّد، أو أقصر من أن يحمل معنًى.
 *
 * ── وما لا تفعله ──
 *
 * لا تحكم على «جودة» الجواب. ذلك يحتاج حكمًا نموذجيًّا أو بشريًّا لم يُبنَ،
 * وإطلاقُ اسم «جودة» على فحصٍ لا يقرأ المعنى يجعل من يقرأ الحقل يظنّ أن
 * شيئًا قد قُرئ.
 *
 * ── والإعجاب ليس دليلًا ──
 *
 * إبهامٌ مرفوع يقول إن القارئ رضي، لا إن الجواب صحيح. فيُخزَّن مصدرًا
 * (`thumbs_up`) لا حكمًا — ولا يفتح وحده بوّابة.
 */

export type QualityStatus = "unknown" | "passed" | "rejected";

export type QualityReasonCode =
  | "empty_assistant"
  | "empty_user"
  | "too_short"
  | "provider_error"
  | "incomplete_completion"
  | "user_aborted"
  | "not_assistant_role"
  | "not_user_role";

export interface QualityVerdict {
  status: QualityStatus;
  reasonCodes: QualityReasonCode[];
}

/** ما يصف حال الرد كما سجّله المسار — لا نصّه */
export interface QualityInput {
  userText: string;
  assistantText: string;
  userRole: string;
  assistantRole: string;
  /** رمز الخطأ إن وُجد — من `observability_events.error_code` أو نظيره */
  errorCode?: string | null;
  /** `incomplete_provider` وأخواتها من عقد البثّ */
  completion?: string | null;
  clientAborted?: boolean;
}

/**
 * حدٌّ متحفّظ: أقصر من هذا لا يحمل تعليمةً ولا جوابًا.
 *
 * ولا يُرفع اعتباطًا: كل رفعٍ يقصّ عيّناتٍ قصيرة مشروعة، وكل خفضٍ يُدخل
 * ضجيجًا. والعشرون محلٌّ وسط يُراجَع بالبيانات لا بالرأي.
 */
const MIN_TEXT_LENGTH = 20;

/**
 * ★ يحكم على صلاحية الزوج — ولا يعيد منه نصًّا.
 */
export function screenQuality(input: QualityInput): QualityVerdict {
  const codes = new Set<QualityReasonCode>();

  // الأدوار أولًا: زوجٌ مقلوب ليس زوجًا
  if (input.userRole !== "user") codes.add("not_user_role");
  if (input.assistantRole !== "assistant") codes.add("not_assistant_role");

  const user = (input.userText ?? "").trim();
  const assistant = (input.assistantText ?? "").trim();

  if (user.length === 0) codes.add("empty_user");
  if (assistant.length === 0) codes.add("empty_assistant");
  if (
    !codes.has("empty_user") &&
    !codes.has("empty_assistant") &&
    (user.length < MIN_TEXT_LENGTH || assistant.length < MIN_TEXT_LENGTH)
  ) {
    codes.add("too_short");
  }

  /**
   * ★ عطلُ المزوّد يُرفض حتى لو وصل نصّ.
   *
   * ردٌّ بدأ ثم انقطع بعطلٍ ليس جوابًا ناقصًا فحسب — هو جوابٌ قد يكون
   * انقطع عند نفيٍ أو شرط، فيصير تعليمُه تعليمَ عكسِ المقصود.
   */
  if (typeof input.errorCode === "string" && input.errorCode.length > 0) {
    codes.add("provider_error");
  }
  if (typeof input.completion === "string" && input.completion.length > 0) {
    codes.add("incomplete_completion");
  }
  if (input.clientAborted === true) codes.add("user_aborted");

  if (codes.size > 0) {
    return { status: "rejected", reasonCodes: [...codes].sort() };
  }
  return { status: "passed", reasonCodes: [] };
}
