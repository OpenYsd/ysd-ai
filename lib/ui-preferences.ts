/**
 * تفضيلات الواجهة المحلية — سطوع مستمرّ من 0 إلى 100.
 *
 * يُحفظ في Cookie على هذا الجهاز فقط (بلا قاعدة بيانات ولا API)، فيبقى بين
 * الجلسات. ويقرؤه التخطيط الجذري على الخادم فيضع `--ui-b` على <html> قبل
 * الرسم، فلا وميض. والقيمة تحرّك الخلفيات وحدها (app/globals.css).
 *
 * الوحدة بلا "use client" لأن التخطيطات (مكوّنات خادم) تستدعيها.
 */

export const UI_BRIGHTNESS_COOKIE = "ysd-ui-brightness";
export const UI_BRIGHTNESS_MIN = 0;
export const UI_BRIGHTNESS_MAX = 100;
export const UI_BRIGHTNESS_DEFAULT = 50;

/** أي قيمة ليست عددًا صحيحًا ضمن المدى تعود إلى الافتراضي — لا تُقصّ، فالمشوّه ليس طلبًا */
export function parseUiBrightness(value: string | null | undefined): number {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return UI_BRIGHTNESS_DEFAULT;
  const n = Number(value);
  return n >= UI_BRIGHTNESS_MIN && n <= UI_BRIGHTNESS_MAX ? n : UI_BRIGHTNESS_DEFAULT;
}

/** قيمة `--ui-b` في الـCSS: من 0 إلى 1 */
export function uiBrightnessCss(value: number): string {
  const n = Math.min(UI_BRIGHTNESS_MAX, Math.max(UI_BRIGHTNESS_MIN, Math.round(value)));
  return (n / 100).toFixed(2);
}
