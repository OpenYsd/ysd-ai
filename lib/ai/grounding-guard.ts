/**
 * حارس الإسناد (v0.6.5 RC7) — يمنع التفاصيل المتخصصة غير الموثقة.
 *
 * رُصد حيًّا على RC6: سُئل عن القناع الأبيض في Elden Ring فأجاب بثقة تامة أنه
 * في «Siofra River» خلف جدار مكسور، بخمس خطوات مرقّمة — كلها مختلقة. حارس عدم
 * اليقين لم يمسكه لأنه يشترط وجود **تحفّظ**، وهذا الرد بلا تحفّظ إطلاقًا.
 *
 * القاعدة: معرفة النموذج الداخلية **ليست مصدرًا موثوقًا** للتفاصيل المتخصصة.
 * في الوضع المحمي وحده: تفاصيل عالية المخاطر بلا إسناد = لا تُعرض أصلًا.
 * ولا تحذير عام يمرّر التفاصيل — المنع قبل العرض لا بعده.
 *
 * لا يعتمد على `@/` ليبقى قابلًا للاستيراد في اختبارات vitest.
 */

import {
  ambiguousCandidates,
  buildClarifyQuestion,
  confidentEntities,
  detectEntities,
  normalizeForMatch,
} from "./entity-aliases";

/** مصدر الإسناد — «none» يعني معرفة النموذج وحدها، وهي غير كافية */
export type GroundingSource = "rag" | "knowledge_base" | "tool" | "user_context" | "none";

export interface Grounding {
  source: GroundingSource;
  /** معرّف المصدر الموثوق (قاعدة معرفة/أداة) — للتسجيل الآمن لا للعرض */
  sourceId?: string;
}

/** أنماط التفاصيل عالية المخاطر (عدا أسماء العلم اللاتينية — تُعالَج بحدة) */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /^\s*\d+[.)]\s+\S/m, // خطوات مرقّمة
  /اذهب|اتجه|اتّجه|توجه|توجّه|انتقل|ابحث\s+عن|استخدم|افتح|ارتدِ|ارتديه|اهزم/, // تعليمات متتابعة
  /منطقة|موقع|الخريطة|شمال|جنوب|شرق|غرب/, // مواقع ومناطق
  /\d/, // أرقام ونسب ومدد
  /تحتاج\s+إلى|يشترط|المتطلبات|الشرط|المستوى\s+المطلوب/, // متطلبات وشروط
];

/** اسم علم لاتيني مركّب (مكان/عنصر/شخصية) */
const LATIN_PROPER = /\b[A-Z][a-z]+(?:[ \-]+(?:of|the|de|la|del)\b)*[ \-]+[A-Z][a-z]+/g;

/**
 * أسماء العلم التي وردت في سؤال المستخدم (أو عُرفت من طبقة الـaliases) ليست
 * اختلاقًا — المستخدم نفسه ذكرها. غيرها في رد غير مُسنَد يُعدّ عالي المخاطر.
 */
function unsourcedProperNouns(reply: string, userText: string): string[] {
  const userNorm = normalizeForMatch(userText);
  const known = new Set(
    detectEntities(userText).map((e) => normalizeForMatch(e.canonical)),
  );
  const out: string[] = [];
  for (const m of reply.match(LATIN_PROPER) ?? []) {
    const n = normalizeForMatch(m);
    if (known.has(n) || userNorm.includes(n)) continue;
    out.push(m);
  }
  return out;
}

/** هل يحمل الرد تفاصيل متخصصة عالية المخاطر من ناحية الدقة؟ */
export function hasHighRiskDetails(reply: string, userText = ""): boolean {
  const stripped = reply.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  if (HIGH_RISK_PATTERNS.some((re) => re.test(stripped))) return true;
  return unsourcedProperNouns(stripped, userText).length > 0;
}

/**
 * المخالفة = تفاصيل عالية المخاطر بلا أي مصدر موثوق.
 * يُستدعى في الوضع المحمي فقط؛ الأسئلة العامة والإبداعية لا تمرّ به إطلاقًا.
 */
export function violatesGrounding(
  reply: string,
  userText: string,
  grounding: Grounding,
): { violated: boolean; reason?: string } {
  if (grounding.source !== "none") return { violated: false }; // مُسنَد → يمر
  if (!hasHighRiskDetails(reply, userText)) return { violated: false };
  return { violated: true, reason: "unsourced_specifics" };
}

/**
 * إسناد من سياق المستخدم نفسه: أن يكون قد قدّم خطوات أو أحال إلى مصدر صراحةً.
 * ضيّق عمدًا — مجرد ذكر اسم عنصر في السؤال ليس إسنادًا، وإلا لسقط الحارس كله.
 */
export function detectUserGrounding(userText: string): boolean {
  return (
    /^\s*\d+[.)]\s+\S/m.test(userText) ||
    /المصدر\s*:|حسب\s+الدليل|من\s+الموقع\s+الرسمي|نسخت\s+لك/.test(userText)
  );
}

/** توجيه إعادة التوليد الوحيدة عند سقوط الحارس */
export const STRICT_GROUNDING_SUFFIX =
  "\n\nتنبيه صارم: لا تذكر مواقع أو خطوات أو أرقامًا أو أسماء دقيقة غير موثقة. اعترف بعدم التأكد باختصار.";

/**
 * الرسالة الآمنة عند استمرار التفاصيل غير الموثقة — تذكر الكيان المعروف صراحةً
 * فلا يُطلب من المستخدم توضيح الاسم، وبلا أي موقع أو خطوة.
 */
const WHITE_MASK_FORMS = [/white\s*mask/i, /القناع\s*الأبيض/, /القناع\s*الابيض/];

export function buildUnsourcedMessage(userText: string): string {
  // التباس في الاسم (جوجو/جوجيتسو مثلًا) → سؤال توضيح مختصر بدل التخمين
  const ambiguous = ambiguousCandidates(userText);
  if (ambiguous.length > 0) return buildClarifyQuestion(ambiguous);

  const first = confidentEntities(userText)[0];
  if (!first) {
    return "لست متأكدًا من التفاصيل الدقيقة، ولا أبغى أعطيك معلومة خاطئة.";
  }
  const item = WHITE_MASK_FORMS.some((re) => re.test(userText)) ? "White Mask" : null;
  return item
    ? `عرفت أنك تقصد ${first.canonical}، لكني غير متأكد من خطوات الحصول على ${item}، ولا أبغى أعطيك معلومة خاطئة.`
    : `عرفت أنك تقصد ${first.canonical}، لكني غير متأكد من الخطوات الدقيقة، ولا أبغى أعطيك معلومة خاطئة.`;
}
