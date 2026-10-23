"use client";

/** الإعدادات: المظهر واللغة (فورية عبر Cookie) + النموذج الافتراضي (قاعدة البيانات) */

import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/components/theme";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { UI_BRIGHTNESS_MAX, UI_BRIGHTNESS_MIN } from "@/lib/ui-preferences";
import { TrainingConsentToggle } from "./training-consent-toggle";
import { DataControls } from "./data-controls";
import { SettingsNoResults, SettingsSection } from "./settings-search";

interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
}

export function SettingsForm({
  models,
  initialDefaultModelId,
  children,
}: {
  models: ModelOption[];
  initialDefaultModelId: string | null;
  children?: React.ReactNode;
}) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme, brightness, setBrightness } = useTheme();
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
      {/* على الجوال: زرّ القائمة وحده — العنوان الكبير في الصفحة */}
      <header className="md:hidden flex items-center px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 md:py-12">
        <div className="max-w-[720px] mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-[26px] md:text-[30px] font-semibold text-ink-strong">{t("settings")}</h1>
            {saved && <span className="text-[12px] text-emerald-400">{t("saved")}</span>}
          </div>
          <SettingsNoResults />

          {/* المظهر */}
          <SettingsSection id="appearance">
            <SettingsGroup title={t("theme")}>
              <SettingsRow title={t("themeMode")}>
                <Segmented
                  label={t("themeMode")}
                  value={theme}
                  options={[
                    { value: "dark", label: t("themeDark") },
                    { value: "light", label: t("themeLight") },
                  ]}
                  onChange={(th) => {
                    setTheme(th);
                    void persist({ theme: th });
                  }}
                />
              </SettingsRow>
              {/* سطوع الواجهة: مستمرّ، محلي على هذا الجهاز (Cookie)، بلا قاعدة بيانات */}
              <SettingsRow
                title={<label htmlFor="ui-brightness">{t("uiBrightness")}</label>}
                hint={t("uiBrightnessHint")}
              >
                <div className="flex items-center gap-3 w-full sm:w-60">
                  <input
                    id="ui-brightness"
                    type="range"
                    min={UI_BRIGHTNESS_MIN}
                    max={UI_BRIGHTNESS_MAX}
                    step={1}
                    value={brightness}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    aria-valuetext={`${brightness}%`}
                    style={{ "--range-fill": `${brightness}%` } as React.CSSProperties}
                    className="ysd-range flex-1 min-w-0"
                  />
                  <span className="w-10 text-end text-[12.5px] text-ink-dim tabular-nums" aria-hidden="true">
                    {brightness}%
                  </span>
                </div>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>

          {/* اللغة */}
          {/* قسمٌ من صفٍّ واحد: الصفّ يحمل الاسم، فلا عنوان فوقه يكرّره */}
          <SettingsSection id="language">
            <SettingsGroup>
              <SettingsRow title={t("language")}>
                <Segmented
                  label={t("language")}
                  value={locale}
                  options={[
                    { value: "ar", label: "العربية" },
                    { value: "en", label: "English" },
                  ]}
                  onChange={setLocale}
                />
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>

          {/* النموذج الافتراضي */}
          <SettingsSection id="defaultModel">
            <SettingsGroup>
              <SettingsRow title={<label htmlFor="default-model">{t("defaultModel")}</label>}>
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
                    id="default-model"
                    value={defaultModelId}
                    onChange={(e) => {
                      setDefaultModelId(e.target.value);
                      void persist({ defaultModelId: e.target.value || null });
                    }}
                    className="w-full sm:w-60 rounded-lg bg-raised border border-line px-3 py-2 text-[13px] text-ink-strong focus:outline-none focus:border-primary"
                  >
                    <option value="">—</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {locale === "ar" ? m.nameAr : m.nameEn}
                      </option>
                    ))}
                  </select>
                )}
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>

          {/**
            * الخصوصية بعد اللغة والنموذج — قرارٌ يخصّ البيانات لا العرض،
            * فيُقرأ بعد ما يخصّ الشكل ولا يُدفن تحته.
            */}
          <SettingsSection id="training">
            <TrainingConsentToggle />
          </SettingsSection>

          {/*
            ضوابط البيانات بجوار إذن المساهمة عمدًا: كلاهما قرارٌ عن
            بياناتك، وتفريقُهما بين صفحتين يجعل أحدهما يُنسى.
          */}
          <SettingsSection id="data">
            <DataControls />
          </SettingsSection>

          {/* أقسامٌ إضافية من الصفحة (المحرك المحلي واقترانه) داخل المنطقة نفسها القابلة للتمرير */}
          {children}
        </div>
      </div>
    </>
  );
}

/** مجموعة إعدادات: عنوانٌ (اختياري) فوق بطاقةٍ صفوفها مفصولة بخطوط */
function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section>
      {title && <h2 className="mb-2.5 text-[14px] font-semibold text-ink-strong">{title}</h2>}
      <div className="rounded-2xl border border-line/70 bg-surface/60 divide-y divide-line/60">{children}</div>
    </section>
  );
}

/** صفّ إعداد: الاسم والوصف في البداية، والتحكّم في النهاية (ويلتفّ تحته على الشاشات الضيقة) */
function SettingsRow({ title, hint, children }: { title: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink-strong">{title}</div>
        {hint && <p className="mt-0.5 text-[12px] text-ink-faint">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** اختيارٌ من خيارين أو ثلاثة — أزرار متجاورة، والمختار معلَن بـaria-pressed */
function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-night/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-3.5 py-1.5 rounded-md text-[12.5px] transition-colors ${
            value === o.value ? "bg-raised text-ink-strong shadow-sm" : "text-ink-dim hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
