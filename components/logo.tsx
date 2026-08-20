/**
 * شعار YSD AI — نجمة رباعية على تدرّج بنفسجي.
 *
 * ── الهندسة واللون من `lib/brand` (v0.9.13، المرحلة 6B) ──
 *
 * كانا مكتوبين هنا حرفيًّا، فكان بناءُ أيقونةِ تبويبٍ أو بطاقةٍ اجتماعية
 * يعني نسخةً ثانية من المسار — وتباعُدَ الاثنتين يوم يُعدَّل أحدهما. فصار
 * المصدر واحدًا يقرأه هذا المكوّن وكلُّ أصلٍ يُولَّد.
 *
 * ونصفُ القطر صار **نسبة** لا رقمًا ثابتًا: `rounded-[10px]` كانت تعطي
 * زاويةً صحيحة عند 32 وحدها، فتظهر العلامة عند 56 مربّعًا شبه حادّ وعند 28
 * أكثرَ استدارةً ممّا يجب.
 */

import {
  BRAND,
  BRAND_COLORS,
  BRAND_GLOW,
  BRAND_GRADIENT,
  BRAND_MARK_RADIUS_RATIO,
  BRAND_MARK_STAR_RATIO,
  YSD_STAR_PATH,
  YSD_STAR_VIEWBOX,
} from "@/lib/brand";

export function LogoMark({ size = 32 }: { size?: number }) {
  const star = Math.round(size * BRAND_MARK_STAR_RATIO);
  return (
    <div
      className="relative shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * BRAND_MARK_RADIUS_RATIO),
        background: BRAND_GRADIENT,
        boxShadow: BRAND_GLOW,
      }}
    >
      <svg
        viewBox={YSD_STAR_VIEWBOX}
        width={star}
        height={star}
        fill="none"
        aria-hidden
      >
        <path d={YSD_STAR_PATH} fill={BRAND_COLORS.ink} />
      </svg>
    </div>
  );
}

export function Logo({
  compact,
  tagline,
}: {
  compact?: boolean;
  tagline?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <LogoMark />
      {!compact && (
        <div className="leading-none">
          <div className="font-display font-bold text-[17px] tracking-wide text-ink-strong">
            {BRAND.name}
          </div>
          {tagline && <div className="text-[10px] text-ink-dim mt-1">{tagline}</div>}
        </div>
      )}
    </div>
  );
}
