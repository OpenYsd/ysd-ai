import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/http/origin";
import { PROTECTED_PREFIXES } from "@/lib/route-policy";

/**
 * ★ يُولَّد عند الطلب لا عند البناء.
 *
 * `APP_ORIGIN` متغيّرُ وقتِ تشغيلٍ تحقنه المنصّة، ولا يصل بناءَ الصورة.
 * فتوليدٌ ساكن يجمّد أصلَ الإنتاج داخل ملفّ التجربة أيضًا — وتُنشر
 * خريطةُ موقعٍ تشير إلى نطاقٍ آخر.
 */
export const dynamic = "force-dynamic";

/**
 * سياسة الزواحف (v0.9.13، المرحلة 6B).
 *
 * ── لماذا تُشتقّ من `PROTECTED_PREFIXES` ──
 *
 * قائمةٌ ثانية مكتوبة يدويًّا هنا تعني أن تُضاف صفحةٌ محميّة يومًا فتبقى
 * خارج المنع — لا لأن أحدًا قرّر، بل لأن أحدًا نسي موضعًا ثانيًا. والاشتقاق
 * يجعل السطحين شيئًا واحدًا: ما يحرسه الوسيط هو ما يمنعه الزاحف.
 *
 * ── وما لا يفعله هذا الملفّ ──
 *
 * `robots.txt` **ليس حراسة**: زاحفٌ سيّئ النية يتجاهله، والحمايةُ الحقيقية
 * في الوسيط وطبقات التطبيق. غرضُه أن تُفهرَس صفحات المنتج والوثائق وحدها،
 * فلا يظهر في نتائج البحث صفحاتُ تحويلٍ إلى تسجيل الدخول.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", ...PROTECTED_PREFIXES.map((p) => `${p}/`), ...PROTECTED_PREFIXES],
    },
    sitemap: `${publicOrigin()}/sitemap.xml`,
    host: publicOrigin(),
  };
}
