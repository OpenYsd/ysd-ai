/**
 * عناصرُ الهوية للصور المولَّدة (v0.9.13، المرحلة 6B).
 *
 * ── لماذا ملفّ ثالث ──
 *
 * `lib/brand.ts` يحمل الهندسة واللون بلا JSX (يقرأه المتصفّح والاختبار).
 * وهذا يحمل شكلَ العلامة كما يفهمه `next/og` — وهو محرّكٌ يقبل مجموعةً
 * محدودة من CSS، فلا يصلح فيه ما يصلح في المتصفّح.
 *
 * ── وقيدان يخصّان `next/og` ──
 *
 * الأول: كل `div` له أكثر من ابنٍ يحتاج `display: flex` صراحةً، وإلّا رُمي
 * خطأٌ عند التوليد لا عند البناء — أي في الإنتاج على أوّل مشاركةِ رابط.
 *
 * والثاني: التدرّجات داخل `<svg>` غيرُ مضمونة، فالتدرّج يُرسم على `div`
 * والنجمةُ مسارٌ بلونٍ صلب فوقه. وهو ما تفعله الواجهة أصلًا.
 */

import {
  BRAND_COLORS,
  BRAND_MARK_RADIUS_RATIO,
  BRAND_MARK_STAR_RATIO,
  YSD_STAR_PATH,
  YSD_STAR_VIEWBOX,
} from "@/lib/brand";

/** النجمة وحدها — مسارٌ بلونٍ صلب، بلا تدرّجٍ داخليّ ولا موردٍ بعيد */
export function StarGlyph({
  size,
  fill = BRAND_COLORS.ink,
}: {
  size: number;
  fill?: string;
}) {
  return (
    <svg width={size} height={size} viewBox={YSD_STAR_VIEWBOX} fill="none">
      <path d={YSD_STAR_PATH} fill={fill} />
    </svg>
  );
}

/**
 * مربّع العلامة — تدرّجٌ ونجمة.
 *
 * `rounded=false` للأيقونة القابلة للقناع: أندرويد يقتطعها بشكله هو،
 * فحافّةٌ مستديرة تحتها تظهر شريطًا داكنًا عند الزوايا.
 */
export function MarkTile({
  size,
  rounded = true,
  starRatio = BRAND_MARK_STAR_RATIO,
}: {
  size: number;
  rounded?: boolean;
  starRatio?: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: rounded ? Math.round(size * BRAND_MARK_RADIUS_RATIO) : 0,
        background: `linear-gradient(135deg, ${BRAND_COLORS.primary} 0%, ${BRAND_COLORS.primaryDeep} 100%)`,
      }}
    >
      <StarGlyph size={Math.round(size * starRatio)} />
    </div>
  );
}
