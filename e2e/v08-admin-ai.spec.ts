/**
 * /admin/ai — تحقق متصفّح حقيقي (v0.8.0).
 *
 * يفترض تشغيل التطبيق على 4840 ومزوّدًا وهميًا على 8097، وأن حساب الجلسة
 * مُرقّى admin مؤقتًا (يهيّئه سكربت التكامل). لا مزوّد حقيقي إطلاقًا.
 */
import fs from "node:fs";
import { expect, test } from "@playwright/test";

const APP = process.env.YSD_E2E_BASE_URL ?? "http://localhost:4840";
const STORAGE = process.env.YSD_E2E_STORAGE_STATE;
test.skip(!STORAGE || !fs.existsSync(STORAGE), "يحتاج YSD_E2E_STORAGE_STATE");
test.use({ storageState: STORAGE });

test.describe("★ لوحة إدارة الذكاء الاصطناعي", () => {
  test("★ الصفحة تعرض العناصر المطلوبة بلا أي سرّ", async ({ page }) => {
    /** كل طلبات المتصفح — لإثبات أن المزوّد لا يُنادى من العميل */
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.goto(`${APP}/admin/ai`, { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { name: "إدارة الذكاء الاصطناعي" })).toBeVisible();
    await expect(page.getByText("OpenRouter").first()).toBeVisible();
    await expect(page.getByText("9Router").first()).toBeVisible();
    await expect(page.getByText("المزوّد الافتراضي")).toBeVisible();
    await expect(page.getByText("النموذج الافتراضي")).toBeVisible();
    await expect(page.getByText("النماذج المسموحة")).toBeVisible();

    // RTL
    const dir = await page.locator("[dir='rtl']").first().getAttribute("dir");
    expect(dir).toBe("rtl");

    // ── لا حقول أسرار ─────────────────────────────────────────────────
    expect(await page.locator("input[type='password']").count()).toBe(0);
    for (const name of ["apiKey", "api_key", "baseUrl", "base_url", "token", "authorization"]) {
      expect(await page.locator(`input[name='${name}']`).count()).toBe(0);
    }
    // الحقول الوحيدة المسموحة: مربّعات اختيار القائمة المسموحة
    const inputs = page.locator("input");
    for (let i = 0; i < (await inputs.count()); i++) {
      expect(await inputs.nth(i).getAttribute("type")).toBe("checkbox");
    }

    // ── فحص النصّ وHTML وسمات العناصر وscript وRSC ─────────────────────
    const bodyText = await page.locator("body").innerText();
    const html = await page.content();
    const scripts = await page.locator("script").allTextContents();
    const rsc = await page.evaluate(() =>
      JSON.stringify((globalThis as { __next_f?: unknown }).__next_f ?? []),
    );
    const haystack = [bodyText, html, scripts.join("\n"), rsc].join("\n");

    for (const forbidden of [
      "mock-key-not-real",
      "127.0.0.1:8097",
      "NINE_ROUTER_API_KEY",
      "NINE_ROUTER_BASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "Authorization:",
      "Bearer ",
    ]) {
      expect(haystack, `تسريب: ${forbidden}`).not.toContain(forbidden);
    }
    // لا stack trace ولا رسالة مزوّد خام
    expect(bodyText).not.toMatch(/\bat\s+\w+\s*\(/);
    expect(bodyText).not.toContain("سرّ-داخلي");

    // ── المزوّد يُنادى من الخادم وحده ──────────────────────────────────
    const toMock = requests.filter((u) => u.includes("8097") || u.includes("20128"));
    expect(toMock, "المتصفح اتصل بالمزوّد مباشرة").toEqual([]);

    /**
     * أي مضيف مزوّد ذكاء اصطناعي ممنوع من المتصفح — نداء المزوّد خادميّ بحت.
     *
     * الصيغة الأولى منعت **كل** طلب خارج التطبيق فسقطت على خطوط Google التي
     * يحمّلها التطبيق أصلًا. الخطوط ليست نداء مزوّد، ومنعها هنا يخلط شرطين
     * مختلفين ويجعل الاختبار يسقط على سلوك سليم — التأكيد يجب أن يقيس عقده هو.
     */
    const providerHosts = ["openrouter.ai", "anthropic.com", "openai.com", "9router"];
    const toProvider = requests.filter((u) => providerHosts.some((h) => u.includes(h)));
    expect(toProvider, `المتصفح نادى مزوّدًا: ${toProvider.join(", ")}`).toEqual([]);

    // كل طلبات XHR/fetch تذهب إلى التطبيق وحده (الخطوط أصول ساكنة لا استدعاءات)
    const apiCalls = requests.filter((u) => u.includes("/api/"));
    expect(apiCalls.every((u) => u.startsWith(APP)), `نداء API خارج التطبيق`).toBe(true);
  });

  test("★ اختبار الاتصال يعرض حالة آمنة", async ({ page }) => {
    await page.goto(`${APP}/admin/ai`, { waitUntil: "networkidle" });
    const btn = page.getByRole("button", { name: "اختبار الاتصال" }).first();
    await btn.click();
    // الحالة تظهر كنصّ مترجَم من مجموعة مغلقة
    await expect(
      page.getByText(/متصل|غير مصرح|لا توجد نماذج|تعذر الاتصال|غير مفعّل/).first(),
    ).toBeVisible({ timeout: 15_000 });
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("8097");
    expect(body).not.toContain("سرّ-داخلي");
  });

  test("★ الحفظ ينجح ويصمد بعد تحديث قسري", async ({ page }) => {
    await page.goto(`${APP}/admin/ai`, { waitUntil: "networkidle" });

    // اختر 9Router مزوّدًا افتراضيًا
    await page.getByRole("button", { name: "9Router", exact: true }).first().click();
    await expect(page.getByText("حُفظ.")).toBeVisible({ timeout: 15_000 });

    // تحديث قسري — القيمة تبقى
    await page.reload({ waitUntil: "networkidle" });
    const chosen = page.getByRole("button", { name: "9Router", exact: true }).first();
    await expect(chosen).toHaveClass(/border-primary/);
  });
});
