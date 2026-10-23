"use client";

/**
 * إعدادات منظّمة وقابلة للبحث: فهرسٌ واحد لكل الأقسام بكلماتها بالعربية والإنجليزية،
 * وحقلٌ واحد يرشّحها. القسم الذي لا يطابق يُخفى كاملًا، ولا يتغيّر داخله شيء.
 *
 * المزوّد في الهيكل (AppShell): فحقل البحث وقائمة الأقسام في اللوحة الجانبية،
 * والأقسام نفسها في الصفحة — والاثنان يقرآن الاستعلام نفسه.
 */

import { createContext, useContext, useState } from "react";
import { Database, Languages, Search, ShieldCheck, Sparkles, SunMoon, type LucideIcon } from "lucide-react";
import { useI18n, type DictKey } from "@/lib/i18n";
import { normalizeForSearch } from "@/lib/platform/search";

export const SETTINGS_INDEX = {
  appearance: ["المظهر", "Theme", "داكن", "Dark", "فاتح", "Light", "سطوع الواجهة", "Brightness"],
  language: ["اللغة", "Language", "العربية", "English"],
  defaultModel: ["النموذج الافتراضي", "Default model"],
  training: ["الخصوصية وتحسين YSD", "Privacy", "Training", "تحسين"],
  data: ["البيانات والخصوصية", "Data & privacy", "حذف الحساب", "Delete account"],
  localEngine: ["YSD Local Engine", "المحرك المحلي", "Local"],
  pairing: ["اقتران YSD Local Engine", "Pairing", "اقتران"],
} as const satisfies Record<string, readonly string[]>;

export type SettingsSectionId = keyof typeof SETTINGS_INDEX;

export function settingsSectionMatches(id: SettingsSectionId, query: string): boolean {
  const q = normalizeForSearch(query);
  return !q || SETTINGS_INDEX[id].some((term) => normalizeForSearch(term).includes(q));
}

const SearchContext = createContext<{ query: string; setQuery: (q: string) => void } | null>(null);

export function SettingsSearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState("");
  return <SearchContext.Provider value={{ query, setQuery }}>{children}</SearchContext.Provider>;
}

export function SettingsSearchInput() {
  const { t } = useI18n();
  const ctx = useContext(SearchContext);
  if (!ctx) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2">
      <Search size={13} className="text-ink-faint shrink-0" aria-hidden="true" />
      <input
        type="search"
        value={ctx.query}
        onChange={(e) => ctx.setQuery(e.target.value)}
        placeholder={t("settingsSearchPlaceholder")}
        aria-label={t("settingsSearchPlaceholder")}
        className="bg-transparent w-full text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
      />
    </div>
  );
}

/** يُخفي القسم كاملًا حين لا يطابق البحث */
export function SettingsSection({ id, children }: { id: SettingsSectionId; children: React.ReactNode }) {
  const ctx = useContext(SearchContext);
  if (ctx && !settingsSectionMatches(id, ctx.query)) return null;
  return (
    <div data-settings-section={id} className="scroll-mt-6">
      {children}
    </div>
  );
}

/**
 * أقسام الإعدادات الثابتة في اللوحة الجانبية. أقسام المحرك المحلي واقترانه لا تُدرج:
 * تظهر برايةٍ قد تكون مطفأة، ورابطٌ إلى قسمٍ غائب زرٌّ لا يفعل شيئًا.
 */
type SettingsNavLabel = Extract<
  DictKey,
  "theme" | "language" | "defaultModel" | "trainingConsentSection" | "dataControlsTitle"
>;

const SETTINGS_NAV: readonly { id: SettingsSectionId; icon: LucideIcon; label: SettingsNavLabel }[] = [
  { id: "appearance", icon: SunMoon, label: "theme" },
  { id: "language", icon: Languages, label: "language" },
  { id: "defaultModel", icon: Sparkles, label: "defaultModel" },
  { id: "training", icon: ShieldCheck, label: "trainingConsentSection" },
  { id: "data", icon: Database, label: "dataControlsTitle" },
];

export function SettingsNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const ctx = useContext(SearchContext);
  if (!ctx) return null;
  const items = SETTINGS_NAV.filter((n) => settingsSectionMatches(n.id, ctx.query));

  const go = (id: SettingsSectionId) => {
    ctx.setQuery("");
    onNavigate?.();
    // بعد أن يُعاد عرض الأقسام المخفية بالبحث
    requestAnimationFrame(() =>
      document.querySelector(`[data-settings-section="${id}"]`)?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
    );
  };

  return (
    <nav aria-label={t("settingsSections")}>
      <ul className="space-y-0.5">
        {items.map(({ id, icon: Icon, label }) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => go(id)}
              className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] text-ink hover:bg-raised/70 transition-colors"
            >
              <Icon size={15} aria-hidden="true" className="text-ink-dim shrink-0" />
              <span className="truncate">{t(label)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** «لا إعداد مطابق» — حين لا يطابق أيّ قسم في الفهرس */
export function SettingsNoResults() {
  const { t } = useI18n();
  const ctx = useContext(SearchContext);
  if (!ctx || !ctx.query.trim()) return null;
  const any = (Object.keys(SETTINGS_INDEX) as SettingsSectionId[]).some((id) => settingsSectionMatches(id, ctx.query));
  if (any) return null;
  return (
    <p role="status" className="text-center text-[13px] text-ink-faint py-6">
      {t("settingsNoResults")}
    </p>
  );
}
