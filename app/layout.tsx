import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { ThemeProvider, type Theme } from "@/components/theme";
import { BRAND, BRAND_COLORS } from "@/lib/brand";
import { LANDING_DESCRIPTION } from "@/lib/landing-copy";
import { publicOrigin } from "@/lib/http/origin";
import "./globals.css";

/**
 * البيانات الوصفية العامّة (v0.9.13، المرحلة 6B).
 *
 * ── ما كان ينقص ──
 *
 * كان هنا عنوانٌ ووصفٌ فقط. فمشاركةُ رابط المنتج على X أو WhatsApp تُنتج
 * رابطًا عاريًا بلا صورةٍ ولا وصف، و`favicon.ico` يردّ 404 على كل صفحة.
 *
 * ── و`metadataBase` ليست تفصيلًا ──
 *
 * بدونها تبقى روابط OG **نسبية**، ومُعاينُ الروابط لا يقرأ النسبيّ — فتغيب
 * الصورة وإن كانت مولَّدة صحيحة. والأصل من `lib/http/origin` لا من نصٍّ
 * مكتوب هنا.
 *
 * ── والقانون: لا فهرسةَ لما خلف الدخول ──
 *
 * `title.template` يجعل كل صفحةٍ تُذيّل باسم المنتج. و`robots` هنا يسمح
 * بالفهرسة عمومًا؛ والمنعُ الفعليّ لمسارات التطبيق في `app/robots.ts`
 * المشتقّ من سياسة المسارات نفسها.
 */
export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin()),
  title: {
    default: `${BRAND.name} — منصة الذكاء العربي`,
    template: `%s — ${BRAND.name}`,
  },
  description: LANDING_DESCRIPTION,
  applicationName: BRAND.name,
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  openGraph: {
    type: "website",
    siteName: BRAND.name,
    title: `${BRAND.name} — Think Deeper. Build Better.`,
    description: LANDING_DESCRIPTION,
    url: "/",
    locale: "ar_SA",
    alternateLocale: ["en_US"],
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND.name} — Think Deeper. Build Better.`,
    description: LANDING_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: BRAND_COLORS.background,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = await cookies();
  const locale: Locale = store.get("ysd-locale")?.value === "en" ? "en" : "ar";
  const theme: Theme = store.get("ysd-theme")?.value === "light" ? "light" : "dark";

  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      data-theme={theme}
      suppressHydrationWarning
    >
      <body className="text-ink antialiased">
        <ThemeProvider initialTheme={theme}>
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
