/**
 * التنسيق فعليًا محمّل (v0.7.0) — لا يكفي أن تُرجع الصفحة 200.
 *
 * رُصد حيًّا: خادم `next start` محلي قديم كان يخدم HTML يشير إلى
 * `/_next/static/css/app/layout.css` (صيغة dev غير مُجزّأة) فيرد 404 بـ9 بايت
 * من نوع text/plain — الصفحة تعمل والاختبارات تمرّ، والمستخدم يرى صفحة بلا
 * تنسيق. هذه الاختبارات تمنع تكرار ذلك: تتحقق من **الملف** ومن **الأثر
 * المحسوب** على عنصر حقيقي.
 *
 * لا تحتاج جلسة — /login عامة.
 */
import { expect, test } from "@playwright/test";

test.describe("تحميل التنسيق", () => {
  test("★ ملف CSS يُخدَم فعلًا: 200 · text/css · حجم معقول", async ({ page, request }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const hrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLLinkElement).getAttribute("href") ?? ""));

    expect(hrefs.length, "يجب أن توجد ورقة أنماط واحدة على الأقل").toBeGreaterThan(0);

    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.status(), `${href} يجب أن يرد 200`).toBe(200);
      const ct = res.headers()["content-type"] ?? "";
      expect(ct, `${href} يجب أن يكون text/css لا HTML/نصًا عاديًا`).toContain("text/css");
      const body = await res.body();
      // 404 كان يرد 9 بايت — أي ملف تنسيق حقيقي أكبر بكثير
      expect(body.length, `${href} أصغر من أن يكون تنسيقًا حقيقيًا`).toBeGreaterThan(1000);
    }
  });

  test("★ الأثر المحسوب موجود — لا صفحة HTML خام", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });

    // ورقة أنماط مُطبَّقة فعلًا في المستند (لا مجرد وسم link)
    const sheetRules = await page.evaluate(() => {
      let n = 0;
      for (const s of Array.from(document.styleSheets)) {
        try {
          n += s.cssRules?.length ?? 0;
        } catch {
          /* cross-origin */
        }
      }
      return n;
    });
    expect(sheetRules, "لا قواعد CSS مطبَّقة — التنسيق لم يُحمّل").toBeGreaterThan(50);

    // الاتجاه عربي: سمة أساسية يضبطها التخطيط لا المتصفح
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // خط التطبيق مطبَّق — لا خط المتصفح الافتراضي.
    // مقيس على الحالتين: سليم = "IBM Plex Sans Arabic" · معطوب = "Times New Roman".
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont, "خط المتصفح الافتراضي — التنسيق غائب").not.toMatch(/Times New Roman/i);

    // زر الإرسال يحمل تنسيقًا فعليًا لا مظهر المتصفح الافتراضي.
    // ملاحظة: الخلفية شفافة بالتصميم (تدرّج/طبقات)، فلا تصلح للتمييز —
    // الانحناء ولون النص هما الفرق المقيس (12px/أبيض مقابل 0px/أسود).
    const btn = page.locator('button[type="submit"]').first();
    await expect(btn).toBeVisible();
    const style = await btn.evaluate((el) => {
      const c = getComputedStyle(el);
      return { radius: c.borderRadius, color: c.color };
    });
    expect(style.radius, "لا انحناء — يبدو زر HTML افتراضيًا").not.toBe("0px");
    expect(style.color, "لون نص افتراضي — التنسيق غائب").not.toBe("rgb(0, 0, 0)");
  });
});
