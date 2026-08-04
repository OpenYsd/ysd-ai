/**
 * جزء العنوان الموروث من OAuth (v0.8.0) — **إثبات متصفّحي لا خادمي**.
 *
 * لماذا هنا لا في vitest: ما بعد `#` لا يغادر المتصفح إطلاقًا. لا ترويسة تحمله
 * ولا سجلّ يراه ولا استجابة تذكره. كل فحوصنا الخادمية كانت تقرأ رابطًا نظيفًا
 * بينما شريط عنوان المستخدم متّسخ — صادقةً وناقصة في آنٍ واحد. المتصفح وحده
 * يستطيع أن يشهد.
 *
 * يعمل بلا جلسة، فيُشغَّل دائمًا.
 */
import { test, expect } from "@playwright/test";

/** الوارد الخام كما رُصد حيًّا: خطأ في الاستعلام **وفي الجزء** معًا */
const RAW_FRAGMENT =
  "#error=server_error&error_code=unexpected_failure" +
  "&error_description=Database%20error%20saving%20new%20user" +
  "&provider_error=boom&state=abc123";

const RAW_QUERY =
  "error=server_error&error_code=unexpected_failure" +
  "&error_description=Database%20error%20saving%20new%20user" +
  "&provider_error=boom&state=abc123";

const LEAKS = [
  "error=",
  "error_code",
  "error_description",
  "provider_error",
  "state=",
  "Database",
  "database",
  "SQLSTATE",
  "server_error",
  "unexpected_failure",
];

test("★ الجزء الموروث يُمحى — الرابط النهائي reason وحده", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();

  // المتصفح هو من يورّث الجزء عبر التحويل — لهذا نمرّ بنقطة الرجوع فعلًا
  await page.goto(`/auth/callback?${RAW_QUERY}${RAW_FRAGMENT}`, {
    waitUntil: "domcontentloaded",
  });

  // المكوّن يمسح في useEffect بعد الترطيب — ننتظر النتيجة لا مدّةً ثابتة
  await expect
    .poll(() => new URL(page.url()).hash, { timeout: 15_000 })
    .toBe("");

  const url = new URL(page.url());
  expect(url.pathname).toBe("/login");
  expect(url.hash).toBe(""); // لا #oauth-clean ولا الجزء الخام
  expect(url.search).toBe("?reason=oauth_invite_required");
  expect([...url.searchParams.keys()]).toEqual(["reason"]);

  // الرابط كاملًا — الشكل الحرفي المطلوب
  expect(`${url.pathname}${url.search}${url.hash}`).toBe("/login?reason=oauth_invite_required");

  for (const leak of LEAKS) {
    expect(page.url(), `تسرّب «${leak}» في الرابط`).not.toContain(leak);
  }

  await ctx.close();
});

test("★ الرسالة العربية ما زالت ظاهرة بعد المسح", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto(`/auth/callback?${RAW_QUERY}${RAW_FRAGMENT}`, {
    waitUntil: "domcontentloaded",
  });

  /**
   * الرسالة تُقرأ من `search` لا من الجزء — فمسح الجزء يجب ألّا يمسّها. هذا
   * الاختبار هو ما يمنع «إصلاحًا» ينظّف الرابط بإعادة تحميلٍ يمحو الرسالة معه.
   */
  await expect(
    page.getByText("هذا الحساب غير مسجل أو لا يملك دعوة صالحة. استخدم حسابًا مسجلًا أو اطلب دعوة."),
  ).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => new URL(page.url()).hash).toBe("");

  // ولا نصّ تقني في الصفحة نفسها
  const body = (await page.textContent("body")) ?? "";
  for (const bad of ["Database error", "SQLSTATE", "server_error", "unexpected_failure"]) {
    expect(body, `«${bad}» ظاهر للمستخدم`).not.toContain(bad);
  }

  await ctx.close();
});

test("★ زيارة /login بجزء خام مباشرةً تُمحى أيضًا", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();

  // بلا تحويل: المسح لا يعتمد على مرورٍ بنقطة الرجوع
  await page.goto(`/login?reason=oauth_failed${RAW_FRAGMENT}`, { waitUntil: "domcontentloaded" });

  await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe("");
  expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(
    "/login?reason=oauth_failed",
  );

  await ctx.close();
});

test("★ زرّ الرجوع لا يعيد العنوان المتّسخ", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();

  await page.goto("/terms", { waitUntil: "domcontentloaded" });
  await page.goto(`/login?reason=oauth_failed${RAW_FRAGMENT}`, { waitUntil: "domcontentloaded" });
  await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe("");

  /**
   * `replaceState` يستبدل المدخل الحالي، فالرجوع يقود إلى /terms مباشرةً.
   * لو استُعمل `pushState` لعاد المستخدم إلى العنوان المتّسخ — إصلاحٌ يُبطله
   * زرٌّ واحد.
   */
  await page.goBack({ waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).pathname).toBe("/terms");
  expect(page.url()).not.toContain("error");

  await ctx.close();
});

test("★ /login بلا جزء لا يتأثّر", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/login?reason=session_expired", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("انتهت جلستك. سجّل الدخول من جديد.")).toBeVisible({
    timeout: 15_000,
  });
  expect(page.url()).toContain("?reason=session_expired");
  await ctx.close();
});
