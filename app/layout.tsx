import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { ThemeProvider, type Theme } from "@/components/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "YSD AI — منصة الذكاء العربي",
  description: "منصة ذكاء اصطناعي احترافية من YSD AI Studio",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0D0918",
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
