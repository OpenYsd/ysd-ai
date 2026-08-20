/**
 * صفحة 404 (v0.9.12، المرحلة 6A).
 *
 * ── لماذا لا فحص جلسة هنا ──
 *
 * رابطٌ خاطئ لا يستحق رحلةً إلى المصادقة. والوجهة الآمنة `/` وهي تقرّر
 * بنفسها: من له جلسة يمضي إلى المحادثة، ومن لا جلسة له إلى الدخول. فلا
 * منطق جلسةٍ في هذه الصفحة أصلًا، ولا رحلةَ قاعدةٍ على مسارٍ لا وجود له.
 *
 * ── واللغة من نفس مصدر التخطيط الجذريّ ──
 *
 * كوكي `ysd-locale` — لا مصدرٌ ثانٍ قد ينحرف عنه، ولا قراءةٌ في المتصفّح
 * تُظهر نصًّا عربيًّا لحظةً ثم تبدّله.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { LogoMark } from "@/components/logo";
import { failureText, normalizeFailureLocale } from "@/lib/failure-copy";
import { SUPPORT_PATH } from "@/lib/public-support";

export default async function NotFound() {
  const store = await cookies();
  const locale = normalizeFailureLocale(store.get("ysd-locale")?.value);

  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="flex justify-center mb-6">
          <LogoMark size={44} />
        </div>

        <p className="text-[34px] font-display font-bold text-primary-glow leading-none mb-3">
          404
        </p>

        <h1 className="text-lg font-semibold text-ink-strong mb-2">
          {failureText("notFoundTitle", locale)}
        </h1>

        <p className="text-[13px] text-ink-dim leading-relaxed mb-6">
          {failureText("notFoundBody", locale)}
        </p>

        <Link
          href="/"
          className="block w-full rounded-xl py-3 text-sm font-medium text-white transition-all
                     hover:brightness-110 focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-primary-glow"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          {failureText("goHome", locale)}
        </Link>

        <Link
          href={SUPPORT_PATH}
          className="inline-block mt-4 text-[12.5px] text-ink-dim hover:text-ink transition-colors
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow rounded"
        >
          {failureText("goSupport", locale)}
        </Link>
      </div>
    </main>
  );
}
