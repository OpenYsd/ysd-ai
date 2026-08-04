import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { relativePath, relativeRedirect } from "@/lib/http/redirect";
import { classifyOAuthFailure } from "@/lib/auth/oauth-error";

/**
 * نقطة رجوع المصادقة: روابط البريد (تأكيد الحساب / استعادة كلمة المرور)
 * و**تدفّق OAuth** (Google). تبادل الكود بجلسة ثم التوجيه للوجهة.
 *
 * التحويل **نسبي دائمًا**: كان يُبنى من `new URL(req.url).origin`، وخلف وكيل
 * Railway ينتهي ذلك إلى عنوان الربط الداخلي (`0.0.0.0` والمنفذ المحقون) فيصل
 * المستخدم إلى عنوان لا وجود له. انظر lib/http/redirect.ts.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chat";
  // مسارات داخلية فقط — منع open redirect
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/chat";

  /**
   * خطأ من المزوّد قبل أي تبادل — رفض المستخدم الإذن، أو رفضت بوابة
   * `handle_new_user` إنشاءه. الحالة الثانية لا تفشل بالضرورة في التبادل:
   * GoTrue قد يعيدنا هنا مباشرةً بـ`error` و`error_description`.
   *
   * فيُصنَّف الوصف — ولا يُعرَض ولا يُمرَّر — كي يفهم مستخدم Google غير
   * المسجَّل سببه الحقيقي بدل «تعذّر الدخول». الوصف قد يحمل «Database error
   * saving new user» أو اسم الدالة أو SQLSTATE؛ لا شيء من ذلك يبلغ المتصفح.
   */
  const providerError = searchParams.get("error");
  if (providerError) {
    const reason =
      providerError === "access_denied"
        ? "oauth_cancelled"
        : classifyOAuthFailure(searchParams.get("error_description"));
    console.error(`[auth] oauth_provider_error reason=${reason}`);
    return relativeRedirect(relativePath("/login", { reason }));
  }

  if (!code) return relativeRedirect(relativePath("/login", { reason: "oauth_failed" }));

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) return relativeRedirect(safeNext);

  /**
   * فشل التبادل. أكثر أسبابه شيوعًا عندنا **ليس** عطلًا تقنيًا: بوابة
   * `handle_new_user` ترفض إنشاء مستخدم جديد بلا تذكرة دعوة أو بلا موافقة،
   * فيفشل الإدراج في auth.users ومعه التبادل. أي أن دخول Google **لا يتجاوز**
   * نظام الدعوة — وهو المطلوب — لكن المستخدم يستحق سببًا مفهومًا بدل
   * «تعذّر الدخول».
   *
   * نصنّف من رسالة Supabase دون عرضها: الرسالة قد تحمل اسم الدالة أو رمز
   * SQLSTATE، ولا شيء من ذلك يخرج إلى المتصفح.
   */
  const reason = classifyOAuthFailure(error.message);
  console.error(`[auth] oauth_callback_failed reason=${reason}`);
  return relativeRedirect(relativePath("/login", { reason }));
}
