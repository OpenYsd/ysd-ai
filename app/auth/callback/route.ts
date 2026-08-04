import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { relativeRedirect } from "@/lib/http/redirect";
import {
  classifyOAuthCallbackError,
  classifyOAuthFailure,
  loginRedirectPath,
  refineWithPendingInvite,
} from "@/lib/auth/oauth-error";
import { GOOGLE_SIGNUP_PENDING_COOKIE, pendingCookie } from "@/lib/auth/google-invite";

/**
 * نقطة رجوع المصادقة: روابط البريد (تأكيد الحساب / استعادة كلمة المرور)
 * و**تدفّق OAuth** (Google). تبادل الكود بجلسة ثم التوجيه للوجهة.
 *
 * التحويل **نسبي دائمًا**: كان يُبنى من `new URL(req.url).origin`، وخلف وكيل
 * Railway ينتهي ذلك إلى عنوان الربط الداخلي (`0.0.0.0` والمنفذ المحقون) فيصل
 * المستخدم إلى عنوان لا وجود له. انظر lib/http/redirect.ts.
 *
 * ورابط العودة يُبنى من الصفر عبر `loginRedirectPath`: لا يُنقل إليه `error`
 * ولا `error_code` ولا `error_description` ولا أي نصّ خام من Supabase — بل
 * `reason` وحده من مجموعة مغلقة.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chat";
  // مسارات داخلية فقط — منع open redirect
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/chat";

  /**
   * خطأ من المزوّد قبل أي تبادل: رفض المستخدم الإذن، أو رفضت بوابة
   * `handle_new_user` إنشاءه. الحالة الثانية لا تفشل بالضرورة في التبادل —
   * GoTrue قد يعيدنا هنا مباشرةً — وغالبًا يحجب سببها خلف وصف عام، فنستعين
   * بإعداد `allow_registration` لفكّ الالتباس.
   */
  /**
   * علامة «كان في تدفّق الدعوة» — كوكي خادمي قصير الأجل، لا بريد فيه ولا كود.
   * تُقرأ مرة واحدة وتُمسح مع كل عودة، نجحت أو فشلت، فلا تبقى فتُفسِّر فشلًا
   * لاحقًا بعد أسبوع على أنه اختلاف بريد.
   */
  const pendingInvite = req.cookies.get(GOOGLE_SIGNUP_PENDING_COOKIE)?.value === "1";
  const clearPending = pendingInvite
    ? { "Set-Cookie": pendingCookie("", 0) }
    : undefined;

  const providerError = searchParams.get("error");
  if (providerError) {
    const reason = refineWithPendingInvite(
      classifyOAuthCallbackError({
        error: providerError,
        errorCode: searchParams.get("error_code"),
        errorDescription: searchParams.get("error_description"),
        allowRegistration: await readAllowRegistration(),
      }),
      pendingInvite,
    );
    console.error(`[auth] oauth_provider_error reason=${reason} pending=${pendingInvite}`);
    return relativeRedirect(loginRedirectPath(reason), { headers: clearPending });
  }

  if (!code) {
    return relativeRedirect(loginRedirectPath("oauth_failed"), { headers: clearPending });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) return relativeRedirect(safeNext, { headers: clearPending });

  /**
   * فشل التبادل. أكثر أسبابه شيوعًا عندنا **ليس** عطلًا تقنيًا: بوابة
   * `handle_new_user` ترفض إنشاء مستخدم جديد بلا دعوة أو بلا موافقة، فيفشل
   * الإدراج في auth.users ومعه التبادل. أي أن دخول Google **لا يتجاوز** نظام
   * الدعوة — وهو المطلوب — لكن المستخدم يستحق سببًا مفهومًا.
   *
   * نصنّف من رسالة Supabase دون عرضها: قد تحمل اسم الدالة أو رمز SQLSTATE.
   */
  const reason = refineWithPendingInvite(classifyOAuthFailure(error.message), pendingInvite);
  console.error(`[auth] oauth_callback_failed reason=${reason} pending=${pendingInvite}`);
  return relativeRedirect(loginRedirectPath(reason), { headers: clearPending });
}

/**
 * `allow_registration` من إعدادات المنصّة.
 *
 * يُعيد `null` عند أي تعذّر — انقطاع، أو منع RLS، أو غياب المفتاح، أو قيمة
 * بغير الشكل المتوقّع. و`null` **ليست false**: الأولى «لا أعرف» فتُبقي التصنيف
 * عامًّا، والثانية «التسجيل مغلق» فتسمح بتفسير الوصف العام رفضَ دعوة.
 */
async function readAllowRegistration(): Promise<boolean | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "allow_registration")
      .maybeSingle();
    if (error) return null;
    const value = data?.value;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  } catch {
    return null;
  }
}
