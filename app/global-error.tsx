"use client";

/**
 * حدُّ الخطأ الجذريّ (v0.9.12، المرحلة 6A) — **يقوم وحده**.
 *
 * ── لماذا يملك `html` و`body` ──
 *
 * هذا الحدّ يُرسم حين يسقط التخطيط الجذريّ نفسه، فيحلّ محلّه. ولا وجود
 * لـ`<html>` ولا `<body>` غير ما يكتبه هنا.
 *
 * ── ولماذا أنماطٌ سطريّة لا أصنافُ Tailwind ──
 *
 * `app/globals.css` يستورده التخطيط الجذريّ. وإن سقط ذلك التخطيط فلا ورقة
 * أنماط ولا متغيّرات لون — وأي `className` يصير حرفًا بلا أثر. فصفحةٌ
 * تعتمد عليها تظهر نصًّا أبيض عاريًا على أبيض.
 *
 * ولذلك: لا `globals.css`، ولا `tailwind`، ولا `LogoMark` (وهو يستعمل
 * أصنافًا)، ولا `next/link` (الموجّه قد يكون في الحال التي أسقطت الجذر).
 * العلامة رُسمت هنا بأنماطٍ سطريّة، والتنقّل بوسمِ `a` عاديّ.
 *
 * وما يبقى من اعتماد: `lib/failure-copy` — وحدة بيانات بلا استيرادٍ واحد.
 */

import { useState } from "react";
import { failureText, normalizeFailureLocale, failureDir, type FailureLocale } from "@/lib/failure-copy";

/** لوحة الوضع الداكن حرفيًّا — لا متغيّرات CSS، فلا ورقة أنماط تحملها */
const NIGHT = "#0d0918";
const INK_STRONG = "#f2eeff";
const INK_DIM = "#8b7fb8";
const MARK_FILL = "#f2eeff";

export default function GlobalError({
  reset,
}: {
  /** يمرّرها Next — تُستقبَل ولا تُقرأ: لا رسالة، ولا `digest`، ولا مكدّس */
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /**
   * ★ اللغة من الوثيقة القائمة قبل أن تُستبدَل.
   *
   * المُهيّئ الكسول يجري في أوّل رسم — و`document` حينها ما يزال يحمل
   * ما كتبه الخادم. و`try/catch` لأن صفحةً تُظهر الانهيار لا يجوز أن
   * تنهار وهي تقرأ سمة.
   */
  const [locale] = useState<FailureLocale>(() => {
    try {
      if (typeof document === "undefined") return "ar";
      return normalizeFailureLocale(document.documentElement.lang);
    } catch {
      return "ar";
    }
  });
  const dir = failureDir(locale);

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 16px",
          background: NIGHT,
          color: INK_STRONG,
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Tahoma, Arial, sans-serif',
        }}
      >
        <div style={{ width: "100%", maxWidth: 384, textAlign: "center" }}>
          <div
            style={{
              width: 44,
              height: 44,
              margin: "0 auto 24px",
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg,#7C5CFF 0%,#4E2ED4 100%)",
            }}
          >
            <svg viewBox="0 0 24 24" width={25} height={25} fill="none" aria-hidden="true">
              <path
                d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z"
                fill={MARK_FILL}
              />
            </svg>
          </div>

          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
            {failureText("errorTitle", locale)}
          </h1>

          <p
            role="alert"
            style={{ fontSize: 13, lineHeight: 1.8, color: INK_DIM, margin: "0 0 24px" }}
          >
            {failureText("errorBody", locale)}
          </p>

          <button
            type="button"
            onClick={() => reset()}
            style={{
              width: "100%",
              padding: "12px 0",
              fontSize: 14,
              fontWeight: 500,
              color: "#ffffff",
              border: "none",
              borderRadius: 12,
              cursor: "pointer",
              background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)",
              fontFamily: "inherit",
            }}
          >
            {failureText("retry", locale)}
          </button>

          {/*
            وسمُ `a` عاديّ **عمدًا** — لا `next/link`.

            القاعدة العامّة صحيحة: التنقّل الداخليّ بـ`Link` أسرع لأنه لا يعيد
            تحميل التطبيق. وهنا بالضبط ما لا نريده: هذا الحدّ يُرسم لأن الجذر
            سقط، والموجّه جزءٌ ممّا سقط. فالمطلوب **إعادة تحميلٍ كاملة** تبني
            التطبيق من جديد، لا تنقّلٌ داخل شجرةٍ منهارة.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/"
            style={{
              display: "inline-block",
              marginTop: 16,
              fontSize: 12.5,
              color: INK_DIM,
              textDecoration: "none",
            }}
          >
            {failureText("goHome", locale)}
          </a>
        </div>
      </body>
    </html>
  );
}
