/**
 * اختبار E2E للتنسيق — يعمل عند YSD_E2E=1 مع خادم يعمل على المنفذ 3000.
 * يتحقق أن الصفحة تحمل CSS حقيقيًا مُجمّعًا (وليس مجرد HTML):
 *   1. صفحة الدخول تشير إلى ملف CSS.
 *   2. ملف CSS يرجع HTTP 200 بنوع text/css (كان يرجع 404 عند فساد .next).
 *   3. الـ CSS يحتوي utilities مُجمّعة ومتغيرات هوية YSD الفعلية.
 *   4. عناصر الصفحة تستخدم أصناف Tailwind المرتبطة بها.
 */
import { describe, it, expect } from "vitest";

const e2e = process.env.YSD_E2E === "1";
const APP = process.env.YSD_APP_URL ?? "http://localhost:3000";

describe.runIf(e2e)("تنسيق الواجهة (E2E)", () => {
  it("صفحة الدخول تحمل CSS مُجمّعًا فعليًا", async () => {
    const page = await fetch(`${APP}/login`);
    expect(page.status).toBe(200);
    const html = await page.text();

    // 1) رابط CSS موجود في الصفحة
    const match = html.match(/href="(\/_next\/static\/css\/[^"]+)"/);
    expect(match?.[1]).toBeTruthy();
    const cssUrl = `${APP}${(match?.[1] ?? "").replace(/&amp;/g, "&")}`;

    // 2) ملف CSS يرجع 200 بنوع صحيح — يكتشف فساد .next
    const cssRes = await fetch(cssUrl);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type") ?? "").toContain("text/css");

    // 3) CSS مُجمّع يحتوي هوية YSD وليس ملفًا فارغًا أو HTML
    const css = await cssRes.text();
    expect(css.length).toBeGreaterThan(5_000);
    expect(css).not.toContain("<!DOCTYPE");
    expect(css).toContain("--c-night"); // متغيرات الثيم
    expect(css).toContain(".bg-raised"); // utility مُجمّعة من tailwind.config
    expect(css).toContain(".rounded-xl"); // utility أساسية للبطاقات والحقول

    // 4) عناصر الصفحة مرتبطة بالأصناف فعلًا
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("bg-raised"); // حقول الدخول
  }, 30_000);
});

describe.runIf(!e2e)("تنسيق الواجهة (E2E) — متخطى", () => {
  it("يتخطى بدون YSD_E2E=1 وخادم يعمل", () => {
    expect(true).toBe(true);
  });
});
