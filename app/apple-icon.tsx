import { ImageResponse } from "next/og";
import { BRAND_COLORS } from "@/lib/brand";
import { MarkTile } from "@/lib/brand-image";

/**
 * أيقونة الشاشة الرئيسة على iOS — **معتمة عمدًا**.
 *
 * iOS لا يحترم الشفافية في هذه الأيقونة: يستبدلها بأسود صلب. فالخلفية
 * تُملأ بلون الهوية هنا، وإلّا ظهرت العلامة على مربّعٍ أسود لا يشبه المنتج.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND_COLORS.background,
        }}
      >
        <MarkTile size={148} />
      </div>
    ),
    size,
  );
}
