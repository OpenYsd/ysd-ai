"use client";

/** الإعدادات: المظهر واللغة (فورية عبر Cookie) + النموذج الافتراضي (قاعدة البيانات) */

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/components/theme";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { TrainingConsentToggle } from "./training-consent-toggle";

interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
}

export function SettingsForm({
  models,
  initialDefaultModelId,
}: {
  models: ModelOption[];
  initialDefaultModelId: string | null;
}) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const [defaultModelId, setDefaultModelId] = useState(initialDefaultModelId ?? "");
  const [saved, setSaved] = useState(false);

  async function persist(patch: Record<string, unknown>) {
    setSaved(false);
    const res = await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("settings")}</h1>
        {saved && <span className="text-[12px] text-emerald-400">{t("saved")}</span>}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-[560px] mx-auto space-y-5">
          {/* المظهر */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5">
            <h2 className="text-[13px] font-medium text-ink-strong mb-3">{t("theme")}</h2>
            <div className="flex gap-2">
              {(["dark", "light"] as const).map((th) => (
                <button
                  key={th}
                  onClick={() => {
                    setTheme(th);
                    void persist({ theme: th });
                  }}
                  className={`px-4 py-2 rounded-xl text-[13px] border transition-colors ${
                    theme === th
                      ? "border-primary bg-primary/15 text-ink-strong"
                      : "border-line text-ink-dim hover:bg-raised"
                  }`}
                >
                  {th === "dark" ? t("themeDark") : t("themeLight")}
                </button>
              ))}
            </div>
          </section>

          {/* اللغة */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5">
            <h2 className="text-[13px] font-medium text-ink-strong mb-3">{t("language")}</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setLocale("ar")}
                className={`px-4 py-2 rounded-xl text-[13px] border transition-colors ${
                  locale === "ar"
                    ? "border-primary bg-primary/15 text-ink-strong"
                    : "border-line text-ink-dim hover:bg-raised"
                }`}
              >
                العربية
              </button>
              <button
                onClick={() => setLocale("en")}
                className={`px-4 py-2 rounded-xl text-[13px] border transition-colors ${
                  locale === "en"
                    ? "border-primary bg-primary/15 text-ink-strong"
                    : "border-line text-ink-dim hover:bg-raised"
                }`}
              >
                English
              </button>
            </div>
          </section>

          {/* النموذج الافتراضي */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5">
            <h2 className="text-[13px] font-medium text-ink-strong mb-3">
              {t("defaultModel")}
            </h2>
            {models.length === 0 ? (
              /**
               * ★ لا تعليمَ مشغِّلٍ هنا (v0.9.12، المرحلة 6A).
               *
               * كان النصّ يطلب إضافة مفتاح مزوّد إلى ملفّ `.env` — بالعربية
               * والإنجليزية معًا. والقائمةُ تفرغ لأسبابٍ تشغيلية لا يملك
               * المستخدم منها شيئًا، فيُقال له ما يعنيه ذلك وما يفعله.
               */
              <p role="status" data-no-models="" className="text-[13px] text-ink-faint">
                {t("noModelsAvailable")}
              </p>
            ) : (
              <select
                value={defaultModelId}
                onChange={(e) => {
                  setDefaultModelId(e.target.value);
                  void persist({ defaultModelId: e.target.value || null });
                }}
                className="w-full rounded-xl bg-raised border border-line px-3 py-2.5 text-[13px] text-ink-strong focus:outline-none focus:border-primary"
              >
                <option value="">—</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {locale === "ar" ? m.nameAr : m.nameEn}
                  </option>
                ))}
              </select>
            )}
          </section>

          {/**
            * الخصوصية بعد اللغة والنموذج — قرارٌ يخصّ البيانات لا العرض،
            * فيُقرأ بعد ما يخصّ الشكل ولا يُدفن تحته.
            */}
          <TrainingConsentToggle />
        </div>
      </div>
    </>
  );
}
