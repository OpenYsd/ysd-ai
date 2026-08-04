import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { relativeRedirect } from "@/lib/http/redirect";
import { SIGNOUT_TIMEOUT_MS, clearAuthCookies, withTimeout } from "@/lib/auth/signout";

/**
 * تسجيل الخروج — POST فقط لمنع CSRF عبر الروابط.
 *
 * التحويل **نسبي**: كان `new URL("/login", req.url)` يبني عنوانًا مطلقًا من
 * عنوان الطلب، فينتهي خلف وكيل Railway إلى `0.0.0.0:<PORT>`. انظر
 * lib/http/redirect.ts. (والنسبي صحيح هنا: معالجات المسارات لا تمرّ بمحوّل
 * الوسيط الذي يرفضه.)
 *
 * ولماذا يبقى مسارًا خادميًا بدل signOut في المتصفح: هنا تُمحى كوكيز الجلسة
 * على الخادم فعلًا، ونموذج POST يحمل حماية CSRF التي يفقدها زرّ يستدعي العميل.
 *
 * **والخروج لا يتعلّق على GoTrue**: نداء `signOut` محدود بمهلة قصيرة، ثم
 * تُمسح الكوكيز ويقع التحويل سواء نجح النداء أو تأخّر أو فشل. لا يُترك
 * المستخدم على هذا المسار ولا يرى صفحة خطأ.
 */
export async function POST() {
  const supabase = await createClient();

  const { timedOut } = await withTimeout(
    Promise.resolve(supabase.auth.signOut()),
    SIGNOUT_TIMEOUT_MS,
  );
  if (timedOut) {
    // عدّاد ومهلة فقط — لا توكن ولا معرّف مستخدم ولا اسم كوكي
    console.warn(`[auth] signout_timeout timeout_ms=${SIGNOUT_TIMEOUT_MS}`);
  }

  // 303 يحوّل POST إلى GET — فلا يعيد المتصفح إرسال الطلب عند التحديث
  const res = relativeRedirect("/login", { status: 303 });

  const names = (await cookies()).getAll().map((c) => c.name);
  const cleared = clearAuthCookies(res, names);
  console.log(`[auth] signout cleared_cookies=${cleared.length} timed_out=${timedOut}`);

  return res;
}
