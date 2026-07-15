"use client";

import { useI18n } from "@/lib/i18n";

export function BetaIntro() {
  const { t } = useI18n();
  return (
    <div>
      <h1 className="text-lg font-semibold text-ink-strong mb-2">{t("betaTitle")}</h1>
      <p className="text-[13px] text-ink-dim leading-relaxed">{t("betaIntro")}</p>
    </div>
  );
}
