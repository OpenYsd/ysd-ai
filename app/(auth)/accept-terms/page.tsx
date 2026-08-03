import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { hasAcceptedCurrentTerms } from "@/lib/auth/consent";
import { AcceptTermsForm } from "@/components/auth/accept-terms-form";

export const dynamic = "force-dynamic";

/**
 * قبول الشروط بعد أول دخول عبر Google.
 *
 * تسجيل Google يُنشئ الحساب بلا موافقة (لا فرصة لقبولها قبل العودة من
 * المزوّد)، فيُحجز المستخدم هنا قبل أي صفحة تطبيق. ومن قبِلها فعلًا — أي كل
 * مستخدمي البريد وكلمة المرور — يمرّ مباشرة إلى /chat فلا يرى هذه الصفحة.
 */
export default async function AcceptTermsPage() {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");

  if (await hasAcceptedCurrentTerms(supabase, ctx.userId)) redirect("/chat");

  const { data: setting } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "terms_version")
    .maybeSingle();

  return <AcceptTermsForm version={typeof setting?.value === "string" ? setting.value : ""} />;
}
