"use client";

/**
 * نموذج قبول الشروط — البوّابة قبل دخول التطبيق.
 *
 * لا يمكن تخطّيه: تخطيط التطبيق يعيد التحويل إلى هنا ما دامت صفوف الموافقة
 * غائبة أو بنسخةٍ قديمة، فحتى من كتب /chat في شريط العنوان يعود. والقبول
 * يُسجَّل خادميًا بنسخة الوثيقة من الإعدادات لا من العميل.
 *
 * ── ما تغيّر في المرحلة 6E ──
 *
 * صار يُعرَض لكل مستخدم لا لمستخدمي Google وحدهم: ارتفع إصدار الحزمة
 * القانونية لأن سياسة الخصوصية صارت تُفصح عن المساهمة الاختيارية في تحسين
 * YSD — ومن وافق على نصّ يوليو وافق على وثيقةٍ لا تذكرها.
 *
 * ونصُّه صار بلغتين: شاشةٌ تطلب موافقةً على وثيقةٍ ثم تكتب بلغةٍ لا يقرؤها
 * صاحبها تطلب توقيعًا على ما لا يُفهم.
 *
 * ── وقبولُ الشروط ليس إذنًا بالتدريب ──
 *
 * لا يُرسل هذا النموذج شيئًا إلا إلى `/api/consent`، وذلك المسار يكتب في
 * `user_consents` وحدها. ولا يمسّ `training_consents` ولا يُنشئ مرشّحًا ولا
 * يُعيد إذنًا سُحب. نظامان منفصلان، ويحرس الفصلَ اختبار.
 */

import { useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthError } from "@/components/auth/fields";

export function AcceptTermsForm({ version }: { version: string }) {
  const { t } = useI18n();
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    if (!agree || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/consent", { method: "POST" });
      if (!r.ok) {
        setError(t("acceptTermsFailed"));
        setLoading(false);
        return;
      }
      // تحويل كامل لا router.push: التخطيط يقرأ الموافقة على الخادم، ونريد
      // طلبًا جديدًا يراها بدل تنقّل عميل يعتمد على ذاكرة الموجّه
      window.location.assign("/chat");
    } catch {
      setError(t("acceptTermsFailed"));
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-strong">{t("acceptTermsTitle")}</h1>
        <p className="mt-1.5 text-[13px] text-ink-dim leading-relaxed">
          {t("acceptTermsIntro")}
        </p>
      </div>

      {/*
        ★ ملخّصٌ إعلاميّ — والوثيقتان هما النصّ المُلزِم.

        فسطرٌ ودود لا يُغني عن قراءة ما يُوقَّع عليه، وقولُ ذلك صراحةً أصدق
        من تركِ القارئ يظنّ أن الملخّص هو العقد.
      */}
      <div
        data-what-changed=""
        className="rounded-xl border border-primary/25 bg-primary/[0.07] px-4 py-3"
      >
        <p className="text-[12.5px] leading-relaxed text-ink">{t("acceptTermsWhatChanged")}</p>
        <p className="mt-1.5 text-[11.5px] text-ink-faint">{t("acceptTermsAuthoritative")}</p>
      </div>

      <label className="flex items-start gap-2 text-[12.5px] text-ink-dim leading-relaxed cursor-pointer">
        <input
          type="checkbox"
          checked={agree}
          onChange={(e) => setAgree(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          {t("acceptTermsAgreePrefix")}{" "}
          <Link href="/terms" target="_blank" className="text-primary-glow hover:underline">
            {t("termsLink")}
          </Link>
          {" · "}
          <Link href="/privacy" target="_blank" className="text-primary-glow hover:underline">
            {t("privacyLink")}
          </Link>
          {version && (
            <span data-legal-version={version} className="text-ink-faint">
              {" "}
              — {version}
            </span>
          )}
        </span>
      </label>

      {error && <AuthError>{error}</AuthError>}

      {/* type=button صراحةً: AuthButton افتراضه submit، ولا نموذج هنا */}
      <AuthButton type="button" disabled={!agree || loading} onClick={onAccept}>
        {loading ? t("acceptTermsSaving") : t("acceptTermsButton")}
      </AuthButton>

      <form action="/auth/signout" method="post" className="pt-1 text-center">
        <button
          type="submit"
          className="text-[12.5px] text-ink-faint hover:text-ink transition-colors
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow rounded"
        >
          {t("logout")}
        </button>
      </form>
    </div>
  );
}
