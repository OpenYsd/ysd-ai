"use client";

/**
 * صفحة الدعم العامّة (v0.9.12، المرحلة 6A).
 *
 * ── وجهةٌ واحدة تصل من الخادم ──
 *
 * لا تقرأ هذه الواجهة البيئة ولا تبني عنوانًا: تستقبل ما قرأه
 * `lib/public-support` وتعرضه. فمصدر الوجهة واحد، وتغييره يومًا يقع في
 * ملفٍّ واحد.
 *
 * ── وحين لا تُضبط وجهة ──
 *
 * يُقال ذلك صراحةً. ولا يُخترع عنوان: من يكتب إلى صندوقٍ لا وجود له يظنّ
 * أنه أُبلِغ، ولا يُبلَّغ أحد.
 */

import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import type { SupportContact } from "@/lib/public-support";

export function SupportView({ contact }: { contact: SupportContact }) {
  const { t } = useI18n();

  return (
    <div className="space-y-5 text-start">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-ink-strong">{t("supportTitle")}</h1>
        <p className="text-[13px] text-ink-dim leading-relaxed">{t("supportIntro")}</p>
      </header>

      {/* ═══ قناة التواصل ═══ */}
      <section className="space-y-2" data-support-channel="">
        <h2 className="text-[13.5px] font-medium text-ink-strong">
          {t("supportChannelTitle")}
        </h2>
        {contact.configured && contact.mailto && contact.email ? (
          <a
            href={contact.mailto}
            dir="ltr"
            data-support-email=""
            className="inline-block rounded-lg border border-line bg-raised px-3 py-2 text-[13px]
                       text-primary-glow hover:brightness-125 transition-all
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
          >
            {contact.email}
          </a>
        ) : (
          <p
            data-support-pending=""
            className="text-[13px] text-ink-faint leading-relaxed"
          >
            {t("supportChannelPending")}
          </p>
        )}
      </section>

      {/* ═══ ما الذي يفيد ذكره ═══ */}
      <section className="space-y-2">
        <h2 className="text-[13.5px] font-medium text-ink-strong">
          {t("supportIncludeTitle")}
        </h2>
        <ul className="space-y-1.5 text-[13px] text-ink-dim leading-relaxed list-disc ms-5">
          <li>{t("supportIncludeWhat")}</li>
          <li>{t("supportIncludeWhen")}</li>
          <li>{t("supportIncludeWhere")}</li>
        </ul>
        <p className="text-[12.5px] text-amber-300/90 leading-relaxed">
          {t("supportNoSecrets")}
        </p>
      </section>

      {/* ═══ طلبات البيانات ═══ */}
      <section className="space-y-2">
        <h2 className="text-[13.5px] font-medium text-ink-strong">
          {t("supportDataTitle")}
        </h2>
        <p className="text-[13px] text-ink-dim leading-relaxed">{t("supportDataBody")}</p>
      </section>

      <div className="flex items-center justify-between pt-1 text-[12.5px]">
        <Link
          href="/"
          className="text-ink-dim hover:text-ink transition-colors rounded
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
        >
          {t("supportBack")}
        </Link>
        <Link
          href="/privacy"
          className="text-primary-glow hover:brightness-125 transition-all rounded
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
        >
          {t("privacyLink")}
        </Link>
      </div>
    </div>
  );
}
