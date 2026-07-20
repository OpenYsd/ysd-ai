/**
 * الإكمال الفارغ (v0.6.5 RC6) — نموذج يُنهي البثّ بلا نص للمستخدم.
 *
 * رُصد حيًّا مرتين: `gpt-oss-20b` أنهى البثّ بلا أي delta.content، فمرّ النص
 * الفارغ عبر الحارسَين (لا شيء ليُخالف) وسُلّم كرسالة مساعد فارغة بعد 89 ثانية.
 * النماذج التي تُفكّر داخليًا قد تستنفد ميزانية التوليد قبل إنتاج إجابة.
 *
 * القاعدة: الرد الفارغ **فشل محاولة** لا نجاحًا — لا يُعرض، ولا يُحفظ، ولا
 * يُمرَّر إلى الحارسَين، ويُهدَّأ النموذج دقيقتين حتى لا يتكرر في كل طلب.
 *
 * لا يعتمد على `@/` ليبقى قابلًا للاستيراد في اختبارات vitest.
 */

import { type DetectedEntity, detectEntities } from "./entity-aliases";

/** رسالة عامة حين يتعذّر الحصول على نص صالح من كل النماذج */
export const NO_COMPLETION_MESSAGE =
  "تعذر الحصول على رد مكتمل حاليًا. حاول مرة أخرى بعد قليل.";

/** هل النص فارغ فعليًا؟ (فراغ أو مسافات/أسطر فقط) */
export function isEmptyCompletion(text: string | undefined | null): boolean {
  return !text || text.trim().length === 0;
}

/** صور «القناع الأبيض» — تُستعمل لصياغة الاعتراف بدقة حين يُذكر العنصر */
const WHITE_MASK_FORMS = [/white\s*mask/i, /القناع\s*الأبيض/, /القناع\s*الابيض/];

/**
 * رسالة الاعتراف عند تعذّر أي نص صالح.
 * إن عُرف اسم اللعبة/المنتج من طبقة الـaliases، تُذكر صراحةً فلا يُطلب من
 * المستخدم توضيح الاسم مرة أخرى، ولا يُخترع موقع ولا خطوة.
 */
export function buildNoCompletionMessage(userText: string): string {
  const entities: DetectedEntity[] = detectEntities(userText);
  const first = entities[0];
  if (!first) return NO_COMPLETION_MESSAGE;

  const mentionsWhiteMask = WHITE_MASK_FORMS.some((re) => re.test(userText));
  const item = mentionsWhiteMask ? "White Mask" : null;

  return item
    ? `عرفت أنك تقصد ${first.canonical}، لكني غير متأكد من الخطوات الدقيقة للحصول على ${item}، ولا أبغى أعطيك معلومة خاطئة.`
    : `عرفت أنك تقصد ${first.canonical}، لكني غير متأكد من الخطوات الدقيقة، ولا أبغى أعطيك معلومة خاطئة.`;
}
