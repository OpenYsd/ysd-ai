import type { MetadataRoute } from "next";
import { BRAND, BRAND_COLORS } from "@/lib/brand";

/**
 * بيان تطبيق الويب (v0.9.13، المرحلة 6B).
 *
 * ── ما يدّعيه وما لا يدّعيه ──
 *
 * `display: standalone` يعني «إن ثبّتَه المستخدم فليفتح بلا شريط عنوان».
 * وهو **لا** يجعل المنتج تطبيقًا يعمل بلا اتصال: لا عامل خدمة هنا، ولا
 * تخزينَ مسبق. فلا يُكتب في المنتج وعدٌ بالعمل دون شبكة.
 *
 * ── والأيقونات مسارات مولَّدة ──
 *
 * تُرسم من `lib/brand` عند الطلب، فلا ملفّ ثنائيّ في المستودع يتباعد عن
 * الشعار يوم يُعدَّل. و`maskable` منفصلة عن `any` عمدًا: أندرويد يقتطع
 * الأولى بشكله، والثانية تُعرض كما هي.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: "An intelligent workspace for chat, files and projects.",
    start_url: "/",
    display: "standalone",
    theme_color: BRAND_COLORS.background,
    background_color: BRAND_COLORS.background,
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
