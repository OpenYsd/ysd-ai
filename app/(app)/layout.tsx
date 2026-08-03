import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { AppShell } from "@/components/shell/app-shell";
import { hasAcceptedCurrentTerms } from "@/lib/auth/consent";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  // الهوية والدور من سياق الوسيط — يُسقط رحلة getUser على **كل تنقل** داخل التطبيق
  // (fallback شبكي آمن لو غاب السياق). الدور جاهز في السياق فلا نعيد جلبه.
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");
  const userId = ctx.userId;

  /**
   * بوابة الموافقة (v0.8.0). مستخدم Google يُنشأ حسابه بلا صفوف موافقة عمدًا
   * (المُحفّز يؤجّلها)، فيُحجز هنا قبل أي صفحة تطبيق حتى يقبل الشروط. مسار
   * البريد وكلمة المرور يقبلها قبل الإنشاء فيمرّ بلا أثر.
   */
  if (!(await hasAcceptedCurrentTerms(supabase, userId))) redirect("/accept-terms");

  const [{ data: profile }, { data: sub }, { data: conversations }] =
    await Promise.all([
      supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
      supabase.from("subscriptions").select("tier").eq("user_id", userId).maybeSingle(),
      supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);

  return (
    <AppShell
      userName={profile?.display_name ?? ""}
      tier={sub?.tier ?? "free"}
      conversations={conversations ?? []}
      isAdmin={ctx.role === "admin" || ctx.role === "owner"}
    >
      {children}
    </AppShell>
  );
}
