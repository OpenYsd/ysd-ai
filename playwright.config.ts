import { defineConfig, devices } from "@playwright/test";

/**
 * اختبارات المتصفح (v0.6.6 RC2).
 *
 * تعمل على نسخة **قيد التشغيل** (الحاوية عادةً على 3300) ولا تُشغّل خادمًا
 * بنفسها: البناء داخل الحاوية هو ما نريد اختباره لا خادم تطوير مختلف.
 *   YSD_E2E_BASE_URL=http://localhost:3300 npm run test:e2e
 *
 * الاختبارات التي تحتاج جلسة تقرأ حالة تخزين من ملف خارج المستودع:
 *   YSD_E2E_STORAGE_STATE=<path to storageState.json>
 * وتتخطّى نفسها بوضوح إن غاب — فلا تفشل بلا سبب ولا تكسر جلسة أحد.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.YSD_E2E_BASE_URL ?? "http://localhost:3300",
    locale: "ar",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
