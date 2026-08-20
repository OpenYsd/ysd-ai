import { ImageResponse } from "next/og";
import { BRAND_COLORS, MASKABLE_SAFE_RATIO } from "@/lib/brand";
import { StarGlyph } from "@/lib/brand-image";

/**
 * أيقونة قابلة للقناع (maskable) 512×512.
 *
 * أندرويد يقتطعها بشكله — دائرة أو مربّعٍ مستدير أو قطرة — ولا يضمن إلا
 * الثمانين بالمئة الوسطى. فالخلفية تمتدّ إلى الحافّة بلا استدارة، والنجمة
 * تُصغَّر إلى منطقة الأمان حتى لا تُقصّ أطرافُها على جهازٍ دون آخر.
 */
export const runtime = "nodejs";

const SIZE = 512;

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `linear-gradient(135deg, ${BRAND_COLORS.primary} 0%, ${BRAND_COLORS.primaryDeep} 100%)`,
        }}
      >
        <StarGlyph size={Math.round(SIZE * MASKABLE_SAFE_RATIO)} />
      </div>
    ),
    { width: SIZE, height: SIZE },
  );
}
