import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getCachedSettings } from "@/lib/settings";
import { INTERNAL_HEADERS } from "@/lib/auth/request-context";
import { deriveRegistrationMode } from "@/lib/auth/registration-mode";
import { LandingView } from "@/components/landing/landing-view";

export const dynamic = "force-dynamic";

/**
 * الجذر `/` — صفحة تعريف عامّة (v0.9.13، المرحلة 6B).
 *
 * ── ما كان هنا ──
 *
 * `redirect(user ? "/chat" : "/login")` — سبعةُ أسطر. فمن يسمع باسم YSD
 * يصل إلى نموذج تسجيل دخولٍ لا يقول له ما هذا ولا لماذا. ولم يكن في المنتج
 * ما يشرحه لغير المسجَّلين إطلاقًا.
 *
 * ── ولماذا لا تحويل للمسجَّل أيضًا ──
 *
 * صفحة التعريف وجهةٌ مشروعة لمن يملك حسابًا: يفتحها ليشاركها، أو ليقرأ
 * الخصوصية، أو ليصل إلى الدعم. وتحويلُه قسرًا إلى `/chat` يجعل رابط المنتج
 * غير قابل للمشاركة بين المستخدمين أنفسهم. فيُعرض له زرُّ «افتح YSD» بدلًا
 * من ذلك، والقرار له.
 *
 * ── والهوية من ترويسة الوسيط لا من رحلة ──
 *
 * الوسيط يختم `x-ysd-user-id` بعد تحقّقٍ فعليّ، وقراءتُها هنا مجّانية.
 * و`getUser()` كانت رحلةَ شبكةٍ على صفحةٍ يفتحها زائرٌ مجهول غالبًا — ثمنٌ
 * على كل زيارةٍ مقابل معلومةٍ حاضرة أصلًا.
 */
export default async function Home() {
  const requestHeaders = await headers();
  const authed = Boolean(requestHeaders.get(INTERNAL_HEADERS.userId));

  /**
   * وضع التسجيل من الإعدادات — من كاش 30 ثانية لا من رحلةٍ في كل زيارة.
   * ولو تعذّرت القراءة يسقط إلى «بالدعوة فقط»: أضيقُ الاحتمالات، فلا يُرسَل
   * أحدٌ إلى تسجيلٍ مفتوحٍ ليس مفتوحًا.
   */
  let registrationMode: ReturnType<typeof deriveRegistrationMode> = "invite_only";
  try {
    const supabase = await createClient();
    const settings = await getCachedSettings(supabase);
    registrationMode = deriveRegistrationMode(
      settings.require_invite as boolean | undefined,
      settings.allow_registration as boolean | undefined,
    );
  } catch {
    /* يبقى invite_only — الفشل مغلق */
  }

  return <LandingView authed={authed} registrationMode={registrationMode} />;
}
