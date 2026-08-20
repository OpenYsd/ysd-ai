"use client";

/**
 * حدُّ خطأ التطبيق (v0.9.12، المرحلة 6A).
 *
 * ── ما لا يُعرض ──
 *
 * `error.message` و`error.digest` وأثر المكدّس. المستخدم لا يملك أن يفعل
 * بأيٍّ منها شيئًا، وكلّها تصف داخل النظام لمن ليس من أهله: اسم وحدة، أو
 * جملة استعلام، أو نصّ مزوّد. والوسيطة تُستقبَل — لأن Next يمرّرها —
 * **ولا تُفكَّك**: ما لا يُقرأ لا يُعرض بالخطأ يومًا.
 *
 * ── ولماذا لا `useI18n` هنا ──
 *
 * `useI18n` ترمي بلا مزوّد. وصفحةُ خطأٍ ترمي هي نفسها لا تعرض شيئًا —
 * يرى المستخدم بياضًا بدل تفسير. فاللغة تُقرأ من `document.documentElement`
 * الذي يكتبه التخطيط الجذريّ قبل الرسم، والنصوص من وحدةٍ بلا استيراد.
 *
 * والتخطيط الجذريّ **قائمٌ** هنا (هذا الحدّ ابنٌ له)، فأصناف Tailwind
 * تعمل. أما `global-error` فيحلّ محلّه — ولذلك أنماطه سطريّة كلّها.
 */

import { useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { failureText, readDocumentLocale, type FailureLocale } from "@/lib/failure-copy";
import { SUPPORT_PATH } from "@/lib/public-support";

export default function AppError({
  reset,
}: {
  /** يمرّرها Next — تُستقبَل ولا تُقرأ */
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /**
   * ★ تُقرأ مرّة عند التركيب — لا في كل رسم.
   *
   * `useState` بمُهيّئٍ كسول: يجري في المتصفّح حيث `document` موجود، ولا
   * يجري أثناء أي رسمٍ خادميّ. والدالّة نفسها لا ترمي في أي حال.
   */
  const [locale] = useState<FailureLocale>(() => readDocumentLocale());

  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="flex justify-center mb-6">
          <LogoMark size={44} />
        </div>

        <h1 className="text-lg font-semibold text-ink-strong mb-2">
          {failureText("errorTitle", locale)}
        </h1>

        {/* role="alert" لا aria-live: المحتوى حاضرٌ عند التركيب لا لاحقًا */}
        <p role="alert" className="text-[13px] text-ink-dim leading-relaxed mb-6">
          {failureText("errorBody", locale)}
        </p>

        <button
          type="button"
          onClick={() => reset()}
          className="w-full rounded-xl py-3 text-sm font-medium text-white transition-all
                     hover:brightness-110 focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-primary-glow"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          {failureText("retry", locale)}
        </button>

        <div className="flex items-center justify-center gap-4 pt-4 text-[12.5px]">
          <Link
            href="/"
            className="text-ink-dim hover:text-ink transition-colors
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow rounded"
          >
            {failureText("goHome", locale)}
          </Link>
          <Link
            href={SUPPORT_PATH}
            className="text-primary-glow hover:brightness-125 transition-all
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow rounded"
          >
            {failureText("goSupport", locale)}
          </Link>
        </div>
      </div>
    </main>
  );
}
