/**
 * واجهات الدعم وحالات العطل (v0.9.12، المرحلة 6A).
 *
 * ── لماذا تُدار المكوّنات هنا لا تُقرأ ──
 *
 * المقيس **ما يقرأه المستخدم**. وحارسُ المصدر يُثبت أن سطرًا مكتوب؛ وهذا
 * يُثبت أن الجملة تظهر على الشاشة، وباللغة التي اختارها، وأن ما لا يجوز
 * ظهوره لا يظهر.
 *
 * ── والمزوّد الحقيقيّ لا محاكاته ──
 *
 * محاكاةُ القاموس كانت ستُثبت أن المكوّن ينادي مفتاحًا — لا أن المستخدم
 * يقرأ نصًّا خاليًا من تعليمات المشغّل.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { I18nProvider, type Locale } from "@/lib/i18n";
import { ThemeProvider } from "@/components/theme";
import { ShellProvider } from "@/components/shell/shell-context";
import { SupportView } from "@/components/support/support-view";
import { StatusMessage } from "@/components/auth/status-message";
import { SettingsForm } from "@/components/settings/settings-form";
import { readSupportContact, type SupportContact } from "@/lib/public-support";

afterEach(cleanup);

const text = () => document.body.textContent ?? "";

function mountSupport(contact: SupportContact, locale: Locale = "ar") {
  return render(
    <I18nProvider initialLocale={locale}>
      <SupportView contact={contact} />
    </I18nProvider>,
  );
}

/** الإعدادات تعيش داخل هيكل التطبيق — فتُركَّب بمزوّديه كما في الإنتاج */
function mountSettings(locale: Locale) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>
        <ShellProvider>
          <SettingsForm models={[]} initialDefaultModelId={null} />
        </ShellProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const UNCONFIGURED = readSupportContact(undefined);
const CONFIGURED = readSupportContact("hello@example.com");

/* ═══════════ (١) صفحة الدعم ═══════════ */

describe("★ (١) صفحة الدعم — تقول الحقيقة عن نفسها", () => {
  it("★ ★ ★ بلا وجهةٍ مضبوطة: يُقال ذلك، ولا يُخترع عنوان", () => {
    /**
     * ★ صندوقٌ لا وجود له أسوأ من لا صندوق.
     *
     * فمن يراه يكتب شكواه ويصمت منتظرًا ردًّا لن يأتي — ويظنّ أنه أبلغ.
     */
    mountSupport(UNCONFIGURED);
    expect(document.querySelector("[data-support-pending]")).not.toBeNull();
    expect(document.querySelector("[data-support-email]")).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(text()).toContain("لم تُنشر بعد قناة تواصل عامة");
    expect(text()).not.toMatch(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it("★ ★ ★ ومع وجهةٍ مضبوطة: تُعرض ويُفتح بها بريد", () => {
    mountSupport(CONFIGURED);
    const link = document.querySelector("[data-support-email]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("mailto:hello@example.com");
    expect(link!.textContent).toBe("hello@example.com");
    expect(document.querySelector("[data-support-pending]")).toBeNull();
  });

  it("★ ★ ★ ولا تعليمَ مشغِّلٍ فيها بأي حال", () => {
    for (const contact of [UNCONFIGURED, CONFIGURED]) {
      cleanup();
      mountSupport(contact);
      const shown = text();
      for (const leak of [".env", "ANTHROPIC", "OPENROUTER", "GROQ", "Railway", "Supabase"]) {
        expect(shown, leak).not.toContain(leak);
      }
    }
  });

  it("★ ★ ★ وتحذّر من إرسال كلمة المرور", () => {
    /**
     * صفحةٌ تطلب التواصل هي أوّل ما ينتحله محتال. والتحذير هنا لا في وثيقة.
     */
    mountSupport(UNCONFIGURED);
    expect(text()).toContain("لا ترسل كلمة مرورك");
    expect(text()).toContain("لن نطلبهما منك أبدًا");
  });

  it("★ ★ ★ وتفصل الحذف الذاتيّ عن طلب حذف الحساب", () => {
    mountSupport(UNCONFIGURED);
    const shown = text();
    expect(shown).toContain("حذف محادثاتك وملفاتك بنفسك");
    expect(shown).toContain("عبر طلب يُرسل من هنا");
    expect(shown).not.toContain("يمكنك حذف حسابك بنفسك");
  });

  it("★ ★ ★ وتعمل بالإنجليزية", () => {
    mountSupport(CONFIGURED, "en");
    const shown = text();
    expect(shown).toContain("Help & support");
    expect(shown).toContain("What helps us help you");
    expect(shown).toContain("Data requests");
    expect(shown).toContain("hello@example.com");
    /** ولا يتسرّب نصٌّ عربيّ إلى واجهةٍ إنجليزية */
    expect(shown).not.toMatch(/[؀-ۿ]/);
  });

  it("★ ★ العناوين والروابط دلاليّة", () => {
    mountSupport(UNCONFIGURED);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelectorAll("h2").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('a[href="/"]')).not.toBeNull();
    expect(document.querySelector('a[href="/privacy"]')).not.toBeNull();
    /** روابطُ تنقّلٍ حقيقية لا `div` قابلٌ للنقر */
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href")).toBeTruthy();
    }
  });
});

/* ═══════════ (٢) حالة الحساب الموقوف ═══════════ */

describe("★ (٢) الإيقاف — النصّ يطلب التواصل، والرابط يجعله ممكنًا", () => {
  it("★ ★ ★ الموقوف يجد طريقًا إلى الدعم", () => {
    render(
      <I18nProvider initialLocale="ar">
        <StatusMessage kind="suspended" />
      </I18nProvider>,
    );
    expect(text()).toContain("تواصل مع إدارة المنصة");
    const link = document.querySelector("[data-status-support]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/support");
  });

  it("★ ★ والصيانة لا تحتاج دعمًا — فلا يُقحَم رابط", () => {
    /** الصيانة حالةٌ عابرة تنتهي وحدها؛ ورابطُ دعمٍ فيها ضجيج */
    render(
      <I18nProvider initialLocale="ar">
        <StatusMessage kind="maintenance" />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-status-support]")).toBeNull();
  });

  it("★ ★ وبالإنجليزية أيضًا", () => {
    render(
      <I18nProvider initialLocale="en">
        <StatusMessage kind="suspended" />
      </I18nProvider>,
    );
    expect(text()).toContain("contact support");
    expect(text()).toContain("Contact support");
  });
});

/* ═══════════ (٣) قائمة النماذج الفارغة ═══════════ */

describe("★ (٣) لا نماذج — عطلُ خدمةٍ لا تعليمُ تثبيت", () => {
  it("★ ★ ★ النصّ المعروض بلغة المنتج", () => {
    mountSettings("ar");
    const shown = text();
    expect(document.querySelector("[data-no-models]")).not.toBeNull();
    expect(shown).toContain("لا توجد نماذج متاحة الآن");
    expect(shown).toContain("فتواصل مع الدعم");
  });

  it("★ ★ ★ ولا ذكرَ لملفّ بيئةٍ ولا مفتاح مزوّد — بالعربية والإنجليزية", () => {
    for (const locale of ["ar", "en"] as const) {
      cleanup();
      mountSettings(locale);
      const shown = text();
      for (const leak of [".env", "provider key", "مفتاح موفر", "API"]) {
        expect(shown, `${locale}: ${leak}`).not.toContain(leak);
      }
    }
  });
});
