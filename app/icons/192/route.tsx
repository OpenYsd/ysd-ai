import { ImageResponse } from "next/og";
import { MarkTile } from "@/lib/brand-image";

/** أيقونة PWA 192×192 — يشير إليها `app/manifest.ts` */
export const runtime = "nodejs";

export function GET() {
  return new ImageResponse(<MarkTile size={192} />, { width: 192, height: 192 });
}
