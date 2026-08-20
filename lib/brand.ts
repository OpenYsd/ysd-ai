/**
 * هوية YSD AI — **مصدرٌ واحد للهندسة واللون** (v0.9.13، المرحلة 6B).
 *
 * ── لماذا وحدة ──
 *
 * النجمة كانت مرسومة في `components/logo.tsx` وحده. وبناءُ أيقونةٍ وبطاقةٍ
 * اجتماعية وأيقوناتِ تطبيقٍ من نسخةٍ ثانية من المسار يعني أن تتباعد الاثنتان
 * يوم يُعدَّل أحدهما — فيصير للمنتج شعاران: واحدٌ في الواجهة وآخر في تبويب
 * المتصفّح، ولا يُنبّه أحدٌ إلى ذلك.
 *
 * فالمسار هنا، ويقرأه كلٌّ من: مكوّن الشعار، وأيقونة SVG الساكنة (يحرس
 * تطابقَها اختبار)، وكلُّ صورةٍ تُولَّد بـ`next/og`.
 *
 * ── وبلا استيرادٍ واحد ──
 *
 * تُقرأ من الخادم (مسارات الصور) ومن المتصفّح (مكوّن الشعار) ومن الاختبار.
 * فأي اعتمادٍ هنا يسري إلى الثلاثة.
 */

/**
 * ★ هندسة النجمة الرباعية — كما هي في `components/logo.tsx` حرفًا بحرف.
 *
 * لوحة `0 0 24 24`. وأربعة رؤوس عند المنتصفين مع خصورٍ عند `9.5/14.5`:
 * نسبةٌ تُبقي الشكل مقروءًا عند 16px، حيث تذوب النجوم النحيلة.
 */
export const YSD_STAR_VIEWBOX = "0 0 24 24";
export const YSD_STAR_PATH =
  "M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z";

/** لوحة الهوية المعتمدة — قيمٌ حرفية لأن الصور تُولَّد خارج CSS */
export const BRAND_COLORS = {
  /** بداية التدرّج */
  primary: "#7C5CFF",
  /** نهايته */
  primaryDeep: "#4E2ED4",
  /** خلفية الفضاء العميق */
  background: "#0D0918",
  /** سطحٌ مرتفع قليلًا */
  surface: "#151029",
  /** النصّ الأساسي — وهو أيضًا لون النجمة على التدرّج */
  ink: "#F2EEFF",
  /** نصٌّ خافت */
  inkMuted: "#A8A3C7",
} as const;

/** التدرّج القُطريّ الموحّد — نفس الزاوية في CSS وفي الصور المولَّدة */
export const BRAND_GRADIENT = `linear-gradient(135deg,${BRAND_COLORS.primary} 0%,${BRAND_COLORS.primaryDeep} 100%)`;

/** توهّجُ العلامة — ظلٌّ بنفسجيّ خفيف لا هالةٌ صاخبة */
export const BRAND_GLOW = "0 0 18px rgba(124,92,255,.35)";

export const BRAND = {
  name: "YSD AI",
  /**
   * ★ شعارٌ بصريّ لا ادّعاء.
   *
   * «SUPPORTIVE WISDOM» سطرُ هوية يظهر في القفل البصريّ والتذييل والبطاقة
   * الاجتماعية. وليس وصفًا لقدرةٍ ولا وعدًا بنتيجة — ولذلك يبقى خافتًا،
   * ولا يُكتب حيث يُقرأ كمواصفة.
   */
  tagline: "SUPPORTIVE WISDOM",
  taglineAr: "منصة الذكاء العربي",
} as const;

/**
 * ★ نصفُ قطر الزاوية نسبةً لا رقمًا ثابتًا.
 *
 * العلامة تُرسم عند 28 و32 و44 و48 و56 و180 و512 — ونصفُ قطرٍ ثابت يجعلها
 * مربّعًا حادًّا في الكبير ودائرةً في الصغير.
 */
export const BRAND_MARK_RADIUS_RATIO = 10 / 32;

/** حجمُ النجمة داخل المربّع — نفس النسبة المستعملة في المكوّن */
export const BRAND_MARK_STAR_RATIO = 0.56;

/**
 * ★ منطقةُ الأمان للأيقونة القابلة للقناع (maskable).
 *
 * أندرويد يقتطع الأيقونة بأشكالٍ مختلفة — دائرة، مربّعٌ مستدير، قطرة.
 * والمضمون وحده ما يقع داخل ٨٠٪ الوسطى. فالنجمة تُصغَّر إلى هذه النسبة
 * وتُملأ الخلفية حتى الحافة، وإلا قُصَّت أطرافُها على بعض الأجهزة.
 */
export const MASKABLE_SAFE_RATIO = 0.6;

/**
 * يبني SVG كاملًا للعلامة — نصٌّ خالص بلا نصّ برمجيّ ولا موردٍ بعيد.
 *
 * `opaque` يملأ الخلفية بالتدرّج (للأيقونات التي لا تقبل الشفافية: أيقونة
 * Apple تستبدل الشفافية بأسود، والقابلةُ للقناع تحتاج حافّةً ممتلئة).
 */
export function buildMarkSvg({
  size = 512,
  opaque = true,
  starRatio = BRAND_MARK_STAR_RATIO,
  rounded = true,
}: {
  size?: number;
  opaque?: boolean;
  starRatio?: number;
  rounded?: boolean;
} = {}): string {
  const radius = rounded ? Math.round(size * BRAND_MARK_RADIUS_RATIO) : 0;
  const star = size * starRatio;
  const offset = (size - star) / 2;
  const scale = star / 24;
  const bg = opaque
    ? `<rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>`
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${BRAND.name}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${BRAND_COLORS.primary}"/>`,
    `<stop offset="1" stop-color="${BRAND_COLORS.primaryDeep}"/>`,
    `</linearGradient></defs>`,
    bg,
    `<g transform="translate(${offset} ${offset}) scale(${scale})">`,
    `<path d="${YSD_STAR_PATH}" fill="${opaque ? BRAND_COLORS.ink : BRAND_COLORS.primary}"/>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
