import { redirect } from "next/navigation";
import Link from "next/link";
import { getAdminContext } from "@/lib/admin/guard";
import { cookies } from "next/headers";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { ThemeProvider, type Theme } from "@/components/theme";
import { AdminNav } from "@/components/admin/admin-nav";

/**
 * حماية لوحة الإدارة على مستوى الخادم (طبقة موثوقة، لا تعتمد على الرابط).
 * middleware يحمي أيضًا؛ هنا التحقق الخادمي الأخير قبل عرض أي شيء.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat"); // غير مصرح → لا لوحة

  const store = await cookies();
  const locale: Locale = store.get("ysd-locale")?.value === "en" ? "en" : "ar";
  const theme: Theme = store.get("ysd-theme")?.value === "light" ? "light" : "dark";

  return (
    <ThemeProvider initialTheme={theme}>
      <I18nProvider initialLocale={locale}>
        <div className="min-h-dvh flex flex-col md:flex-row">
          <AdminNav isOwner={ctx.isOwner} />
          <main className="flex-1 min-w-0">
            <div className="px-4 md:px-6 py-3 border-b border-line/50 flex items-center gap-2">
              <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-primary/15 text-primary-glow border border-primary/30">
                {ctx.isOwner ? "owner" : "admin"}
              </span>
              <Link href="/chat" className="text-[12.5px] text-ink-dim hover:text-ink ms-auto">
                ← العودة للتطبيق
              </Link>
            </div>
            {children}
          </main>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}
