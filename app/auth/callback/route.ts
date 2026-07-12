import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * نقطة رجوع روابط البريد (تأكيد الحساب / استعادة كلمة المرور):
 * تبادل الكود بجلسة ثم التوجيه للوجهة المطلوبة.
 */
export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chat";
  // نسمح بالمسارات الداخلية فقط — منع open redirect
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/chat";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${safeNext}`);
  }
  return NextResponse.redirect(`${origin}/login`);
}
