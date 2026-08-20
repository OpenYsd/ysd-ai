import { ImageResponse } from "next/og";
import { MarkTile } from "@/lib/brand-image";

/** أيقونة PWA 512×512 — يشير إليها `app/manifest.ts` */
export const runtime = "nodejs";

export function GET() {
  return new ImageResponse(<MarkTile size={512} />, { width: 512, height: 512 });
}
