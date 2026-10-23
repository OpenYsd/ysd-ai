/**
 * الإعدادات المنظّمة القابلة للبحث، ومنزلق سطوع الواجهة.
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - حقلٌ واحد (في لوحة الهيكل) يرشّح الأقسام بالعربية والإنجليزية، ورسالة صريحة حين لا يطابق شيء.
 *   - الإعدادات صفوفٌ معلنة الحالة: الوضع واللغة أزرارٌ بـaria-pressed.
 *   - المنزلق يغيّر --ui-b على <html> والـCookie فورًا، بلا أي طلب إلى الخادم.
 *
 * يُستبدل ما يخرج عن الموضوع فقط: زرّ القائمة وقسمان يطلبان API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));
vi.mock("@/components/settings/training-consent-toggle", () => ({
  TrainingConsentToggle: () => <section>الخصوصية وتحسين YSD</section>,
}));
vi.mock("@/components/settings/data-controls", () => ({
  DataControls: () => <section>البيانات والخصوصية</section>,
}));

import { SettingsForm } from "@/components/settings/settings-form";
import {
  SettingsSearchInput,
  SettingsSearchProvider,
  SettingsSection,
  settingsSectionMatches,
} from "@/components/settings/settings-search";
import { ThemeProvider } from "@/components/theme";
import { I18nProvider } from "@/lib/i18n";

function renderSettings(initialBrightness?: number) {
  return render(
    <ThemeProvider initialTheme="dark" initialBrightness={initialBrightness}>
      <I18nProvider initialLocale="ar">
        <SettingsSearchProvider>
          {/* في التطبيق يعرضه الهيكل في اللوحة الجانبية */}
          <SettingsSearchInput />
          <SettingsForm models={[]} initialDefaultModelId={null}>
            <SettingsSection id="pairing">
              <section>اقتران YSD Local Engine</section>
            </SettingsSection>
          </SettingsForm>
        </SettingsSearchProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const sections = () =>
  [...document.querySelectorAll("[data-settings-section]")].map((e) => e.getAttribute("data-settings-section"));

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
  vi.stubGlobal("fetch", fetchSpy);
  document.documentElement.style.removeProperty("--ui-b");
  document.cookie = "ysd-ui-brightness=;path=/;max-age=0";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("البحث في الإعدادات", () => {
  it("مطابقة الفهرس بالعربية والإنجليزية وبلا همزة", () => {
    expect(settingsSectionMatches("language", "اللغه")).toBe(true);
    expect(settingsSectionMatches("language", "english")).toBe(true);
    expect(settingsSectionMatches("appearance", "سطوع")).toBe(true);
    expect(settingsSectionMatches("appearance", "brightness")).toBe(true);
    expect(settingsSectionMatches("data", "حذف")).toBe(true);
    expect(settingsSectionMatches("language", "سطوع")).toBe(false);
    expect(settingsSectionMatches("language", "")).toBe(true);
  });

  it("كل الأقسام ظاهرة بلا بحث، والكتابة تُبقي المطابق وحده", () => {
    renderSettings();
    expect(sections()).toEqual(["appearance", "language", "defaultModel", "training", "data", "pairing"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "ابحث في الإعدادات" }), { target: { value: "اللغة" } });
    expect(sections()).toEqual(["language"]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "pairing" } });
    expect(sections()).toEqual(["pairing"]);
  });

  it("لا مطابقة ⇒ رسالة صريحة ولا قسم", () => {
    renderSettings();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(sections()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("لا إعداد مطابق");
  });
});

describe("منزلق سطوع الواجهة", () => {
  it("يبدأ من قيمة الخادم، ومُسمّى، وقيمته مقروءة", () => {
    renderSettings(30);
    const slider = screen.getByRole("slider", { name: "سطوع الواجهة" }) as HTMLInputElement;
    expect(slider.value).toBe("30");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.getAttribute("aria-valuetext")).toBe("30%");
  });

  it("التحريك يغيّر --ui-b والـCookie فورًا، بلا أي طلب إلى الخادم", () => {
    renderSettings();
    const slider = screen.getByRole("slider", { name: "سطوع الواجهة" });
    fireEvent.change(slider, { target: { value: "72" } });
    expect(document.documentElement.style.getPropertyValue("--ui-b")).toBe("0.72");
    expect(document.cookie).toContain("ysd-ui-brightness=72");
    expect(slider.getAttribute("aria-valuetext")).toBe("72%");
    fireEvent.change(slider, { target: { value: "0" } });
    expect(document.documentElement.style.getPropertyValue("--ui-b")).toBe("0.00");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("الجزء المملوء يتبع القيمة (--range-fill)", () => {
    renderSettings(40);
    const slider = screen.getByRole("slider", { name: "سطوع الواجهة" }) as HTMLInputElement;
    expect(slider.style.getPropertyValue("--range-fill")).toBe("40%");
    fireEvent.change(slider, { target: { value: "85" } });
    expect(slider.style.getPropertyValue("--range-fill")).toBe("85%");
  });
});

describe("صفوف الإعدادات", () => {
  it("الوضع واللغة أزرارٌ معلنة الحالة", () => {
    renderSettings();
    const mode = screen.getByRole("group", { name: "الوضع" });
    const dark = within(mode).getByRole("button", { name: "داكن" });
    const light = within(mode).getByRole("button", { name: "فاتح" });
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(light.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(light);
    expect(light.getAttribute("aria-pressed")).toBe("true");
    const lang = screen.getByRole("group", { name: "اللغة" });
    expect(within(lang).getByRole("button", { name: "العربية" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("عنوانٌ كبير واحد، ولا يتكرّر اسم القسم فوق صفٍّ يحمله", () => {
    renderSettings();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("الإعدادات");
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2).toContain("المظهر");
    expect(h2).not.toContain("اللغة");
  });
});
