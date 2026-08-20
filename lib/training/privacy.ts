import "server-only";

/**
 * بوّابة الخصوصية لبنك التدريب (v0.9.4، المرحلة الأولى) — **حتميّة، وتعرف حدّها**.
 *
 * ── ما تكشفه ──
 *
 * ما يُكشف بيقين: بريدٌ، وهاتفٌ، وعنوان IP، وبطاقة، ومفاتيح ورموز، وعناوين
 * تحمل أسرارًا في مسارها أو استعلامها.
 *
 * ── وما لا تكشفه ──
 *
 * الأسماء، والعناوين البريدية، والسياق الذي يدلّ على صاحبه بلا أن يسمّيه.
 * تلك تحتاج مصنِّفًا لم يُبنَ بعد.
 *
 * ── ولذلك ثلاث حالات لا منطقيّ واحد ──
 *
 * `boolean` كان سيقول «نظيف» عن نصٍّ لم نفحص فيه إلا ما نعرف. و
 * `needs_review` تقول الحقيقة: لم نجد ما نرفضه، ولم نطمئن. فيبقى الباب
 * مفتوحًا لمصنِّفٍ يرفع الحكم لاحقًا، ولا يُبنى على وعدٍ لم يُعطَ.
 *
 * ── ولا يُعاد النصّ ولا يُسجَّل ──
 *
 * المُخرَج حالةٌ ورموزُ أسباب. فمن يقرأ سجلًّا لا يقرأ كلام أحد.
 */

export type PrivacyStatus = "unknown" | "passed" | "rejected" | "needs_review";

/** رموز مغلقة — تقول **أي نوع** وُجد، لا ماذا كان */
export type PrivacyReasonCode =
  | "email"
  | "phone"
  | "ip_address"
  | "credit_card"
  | "secret_token"
  | "url_with_credentials"
  | "too_short_to_judge";

export interface PrivacyVerdict {
  status: PrivacyStatus;
  reasonCodes: PrivacyReasonCode[];
}

/**
 * ★ الأنماط الحتمية وحدها.
 *
 * وكلٌّ منها يُختار ليُقلّل الإيجاب الكاذب: رفضُ عيّنةٍ سليمة يكلّف عيّنة،
 * وقبولُ عيّنةٍ تحمل بريد إنسانٍ يكلّف ثقته.
 */
const PATTERNS: ReadonlyArray<readonly [PrivacyReasonCode, RegExp]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  /**
   * هاتفٌ دوليّ أو محلّيّ طويل — سبعة أرقام فأكثر مع فواصل شائعة.
   * والحدّ الأدنى مقصود: أربعة أرقام قد تكون سنةً أو ثمنًا.
   */
  ["phone", /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{3,4}/],
  ["ip_address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ["ip_address", /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/],
  ["credit_card", /\b(?:\d[ -]?){13,19}\b/],
  // مفاتيح ورموز بصيغٍ شائعة — والقائمة تتّسع بلا تغيير في العقد
  ["secret_token", /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/],
  ["secret_token", /\bsk-or-[A-Za-z0-9_-]{12,}\b/],
  ["secret_token", /\bgsk_[A-Za-z0-9]{20,}\b/],
  ["secret_token", /\bsb_[A-Za-z0-9_-]{20,}\b/],
  ["secret_token", /\bghp_[A-Za-z0-9]{20,}\b/],
  ["secret_token", /\bAKIA[0-9A-Z]{16}\b/],
  // JWT: ثلاثة مقاطع Base64URL
  ["secret_token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/],
  ["secret_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ["secret_token", /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S{8,}/i],
  // عنوانٌ يحمل اعتمادًا في مضيفه أو سرًّا في استعلامه
  ["url_with_credentials", /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  [
    "url_with_credentials",
    /https?:\/\/\S*[?&](?:token|key|secret|access[_-]?token|api[_-]?key|password|sig|signature)=[^\s&]{8,}/i,
  ],
];

/** أقصر من هذا لا يُحكم عليه — ولا يصلح عيّنةً أصلًا */
const MIN_JUDGEABLE_LENGTH = 12;

/**
 * ★ يحكم على نصّ العيّنة — ولا يعيد منه شيئًا.
 *
 * `rejected` حين يُوجد ما نعرفه يقينًا. و`needs_review` حين لا يُوجد —
 * لأن غياب ما نبحث عنه ليس دليلَ نظافة، وهذه المرحلة لا تملك ما يُثبتها.
 * و`passed` لا تُمنح هنا إطلاقًا: تُمنح حين يُضاف مصنِّفٌ يستحقّها.
 */
export function screenPrivacy(text: string): PrivacyVerdict {
  const found = new Set<PrivacyReasonCode>();

  if (typeof text !== "string" || text.trim().length < MIN_JUDGEABLE_LENGTH) {
    return { status: "rejected", reasonCodes: ["too_short_to_judge"] };
  }

  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(text)) found.add(code);
  }

  if (found.size > 0) {
    return { status: "rejected", reasonCodes: [...found].sort() };
  }

  /**
   * ★ لا `passed` بالفحص الحتميّ وحده.
   *
   * لو مُنحت هنا لَصار البنك يقول عن كل عيّنةٍ لم تُطابق تعبيرًا نمطيًّا
   * إنها آمنة — وهو ادّعاءٌ لا يسنده شيء. والقيد في القاعدة يشترط
   * `passed` للاعتماد، فتبقى العيّنات موقوفةً حتى يوجد من يفحصها.
   */
  return { status: "needs_review", reasonCodes: [] };
}
