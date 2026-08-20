import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/http/origin";
import { SITEMAP_PATHS } from "@/lib/route-policy";

/**
 * ★ يُولَّد عند الطلب لا عند البناء.
 *
 * `APP_ORIGIN` متغيّرُ وقتِ تشغيلٍ تحقنه المنصّة، ولا يصل بناءَ الصورة.
 * فتوليدٌ ساكن يجمّد أصلَ الإنتاج داخل ملفّ التجربة أيضًا — وتُنشر
 * خريطةُ موقعٍ تشير إلى نطاقٍ آخر.
 */
export const dynamic = "force-dynamic";

/**
 * خريطة الموقع (v0.9.13، المرحلة 6B).
 *
 * ── القائمة سماحٌ لا منع ──
 *
 * تُبنى من `SITEMAP_PATHS` وحدها — لا من «كل ما ليس محميًّا». فمسارٌ عامّ
 * جديد لا يدخل الفهرس إلا بقرار: حالاتُ النظام (`/suspended`, `/maintenance`)
 * ورموزُ الدعوة عامّةٌ تقنيًّا ولا معنى لفهرستها، وإدراجُها بالخطأ يكشف
 * بنية المسارات لمن يقرأ الخريطة.
 *
 * ── ولا تاريخَ مخترعًا ──
 *
 * `lastModified` وقتُ التوليد، وهو ما نعرفه فعلًا. وتثبيتُ تاريخٍ يدويّ
 * يجعله يكذب بعد أوّل تعديل.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  const now = new Date();
  return SITEMAP_PATHS.map((path) => ({
    url: path === "/" ? origin : `${origin}${path}`,
    lastModified: now,
    changeFrequency: path === "/" ? ("weekly" as const) : ("monthly" as const),
    priority: path === "/" ? 1 : 0.6,
  }));
}
