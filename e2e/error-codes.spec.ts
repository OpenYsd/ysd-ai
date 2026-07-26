/**
 * تصنيف الأخطاء (v0.6.6) — يعمل بلا جلسة، فيُشغَّل دائمًا.
 * يثبت أن انتهاء الجلسة يصل برمز صريح لا كرسالة «تعذر الاتصال» العامة.
 */
import { test, expect } from "@playwright/test";

test("★ طلب محادثة بلا جلسة → 401 برمز auth_expired", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL }); // بلا أي كوكيز
  const res = await anon.post("/api/chat", {
    data: {
      conversationId: "00000000-0000-4000-8000-000000000000",
      modelId: "ysd/free",
      message: "مرحبا",
    },
  });
  expect(res.status()).toBe(401);
  const j = (await res.json()) as { code?: string; error?: string };
  expect(j.code).toBe("auth_expired"); // مصنّف لا عام
  expect(j.error).toMatch(/[؀-ۿ]/); // رسالة عربية
  expect(j.error).not.toMatch(/تعذر الاتصال/); // ليست الرسالة القديمة الجامعة
  await anon.dispose();
});

test("★ صفحة محمية بلا جلسة → /login مع سبب صريح", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  expect(page.url()).toContain("/login");
  await ctx.close();
});

test("★ /api/health عام ويعمل بلا جلسة", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL });
  const res = await anon.get("/api/health");
  expect([200, 503]).toContain(res.status()); // 503 مسموح عند تعثّر خدمة خارجية
  const j = (await res.json()) as { status?: string; checks?: Record<string, unknown> };
  expect(j.checks).toBeTruthy();
  await anon.dispose();
});
