import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { relativePath, relativeRedirect } from "@/lib/http/redirect";

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
   * خطأ من المزوّد قبل أي تبادل (رفض المستخدم الإذن مثلًا). لا نعرض نصّه —
   * قد يحمل تفاصيل مزوّد — بل رمزًا مغلقًا تترجمه صفحة الدخول.
   */
  const providerError = searchParams.get("error");
  if (providerError) {
    const denied = providerError === "access_denied";
    return relativeRedirect(
      relativePath("/login", { reason: denied ? "oauth_cancelled" : "oauth_failed" }),
    );
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
  const raw = String(error.message ?? "");
  const reason = /invite/i.test(raw)
    ? "oauth_invite_required"
    : /consent/i.test(raw)
      ? "oauth_consent_required"
      : /registration_closed/i.test(raw)
        ? "oauth_registration_closed"
        : "oauth_failed";
  console.error(`[auth] oauth_callback_failed reason=${reason}`);
  return relativeRedirect(relativePath("/login", { reason }));
}
