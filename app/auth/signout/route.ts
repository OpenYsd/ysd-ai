import { createClient } from "@/lib/supabase/server";
import { relativeRedirect } from "@/lib/http/redirect";

/**
 * تسجيل الخروج — POST فقط لمنع CSRF عبر الروابط.
 *
 * التحويل صار **نسبيًا**: كان `new URL("/login", req.url)` يبني عنوانًا مطلقًا
 * من عنوان الطلب، فينتهي خلف وكيل Railway إلى `0.0.0.0:<PORT>` — وهو سبب
 * خروج المستخدم إلى صفحة لا تُفتح. انظر lib/http/redirect.ts.
 *
 * ولماذا يبقى مسارًا خادميًا بدل signOut في المتصفح: هنا تُمحى كوكيز الجلسة
 * على الخادم فعلًا، ونموذج POST يحمل حماية CSRF التي يفقدها زرّ يستدعي العميل.
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // 303 يحوّل POST إلى GET — فلا يعيد المتصفح إرسال الطلب عند التحديث
  return relativeRedirect("/login", { status: 303 });
}
