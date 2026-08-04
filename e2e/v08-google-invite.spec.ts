/**
 * تدفّق «التسجيل باستخدام Google بدعوة» في المتصفح (v0.8.0).
 *
 * يعمل بلا جلسة، ولا يلمس Google الحقيقي: ما يُختبر هنا هو **بوابة الواجهة** —
 * أن زرّ Google لا يوجد قبل نجاح التحقق، وأنه يوجد بعده. وهذا بالضبط ما لا
 * يثبته اختبار وحدة: المكوّن قد يكون سليمًا وتركيبه في الصفحة خاطئًا.
 *
 * والتحقق يُرفض هنا فعلًا (كود وهمي)، فلا يُنشأ تصريح ولا تُمسّ دعوة أحد.
 */
import { test, expect } from "@playwright/test";

test("★ /register: لا زرّ Google عامًّا، بل مدخل الدعوة", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/register", { waitUntil: "domcontentloaded" });

  // المدخل ظاهر
  await expect(page.getByRole("button", { name: "التسجيل باستخدام Google بدعوة" })).toBeVisible({
    timeout: 15_000,
  });

  // وزرّ Google العام غائب قبل أي تحقق
  await expect(page.getByRole("button", { name: "المتابعة باستخدام Google" })).toHaveCount(0);

  await ctx.close();
});

test("★ الزر لا يظهر قبل التحقق، ولا يظهر عند رفض الكود", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/register", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "التسجيل باستخدام Google بدعوة" }).click();

  await page.getByPlaceholder("كود الدعوة").last().fill("DEFINITELY-NOT-A-REAL-CODE");
  await page.getByPlaceholder("بريد Google").fill("nobody@example.com");

  // ما زال غائبًا قبل الضغط
  await expect(page.getByRole("button", { name: "المتابعة باستخدام Google" })).toHaveCount(0);

  await page.getByRole("button", { name: "تحقّق وتابع" }).click();

  // الكود وهمي ⇒ رفض، والزر يبقى غائبًا
  await expect(
    page.getByText("كود الدعوة أو البريد غير صالح. تأكّد منهما ثم أعد المحاولة."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "المتابعة باستخدام Google" })).toHaveCount(0);
  await expect(page.getByText("تم التحقق من الدعوة")).toHaveCount(0);

  await ctx.close();
});

test("★ المسار لا يسرّب الكود ولا البريد في شريط العنوان", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/register", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "التسجيل باستخدام Google بدعوة" }).click();
  await page.getByPlaceholder("كود الدعوة").last().fill("SECRETCODE-123");
  await page.getByPlaceholder("بريد Google").fill("private@example.com");
  await page.getByRole("button", { name: "تحقّق وتابع" }).click();
  await page.waitForTimeout(1500);

  for (const leak of ["SECRETCODE", "private", "example.com", "@"]) {
    expect(page.url(), `تسرّب «${leak}»`).not.toContain(leak);
  }

  /** ولا في التخزين المحلي: التصريح يعيش في القاعدة وحدها */
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  for (const leak of ["SECRETCODE", "private@example.com"]) {
    expect(stored, `تسرّب «${leak}» في التخزين`).not.toContain(leak);
  }

  await ctx.close();
});

test("★ رسالة اختلاف البريد تُعرض على /login", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/login?reason=oauth_email_mismatch", { waitUntil: "domcontentloaded" });

  await expect(
    page.getByText("حساب Google المختار لا يطابق البريد المرتبط بالدعوة."),
  ).toBeVisible({ timeout: 15_000 });

  await ctx.close();
});

test("★ رابط العودة يبقى نظيفًا بلا جزء خام", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();

  const RAW =
    "#error=server_error&error_code=unexpected_failure" +
    "&error_description=Database%20error%20saving%20new%20user&state=abc123";
  await page.goto(
    `/auth/callback?error=server_error&error_description=invite_required_or_invalid${RAW}`,
    { waitUntil: "domcontentloaded" },
  );

  await expect.poll(() => new URL(page.url()).hash, { timeout: 15_000 }).toBe("");
  const url = new URL(page.url());
  expect(url.pathname).toBe("/login");
  expect([...url.searchParams.keys()]).toEqual(["reason"]);
  for (const leak of ["error_description", "provider_error", "state=", "Database", "SQLSTATE"]) {
    expect(page.url(), leak).not.toContain(leak);
  }

  await ctx.close();
});

test("★ /login ما زال يحمل زرّ Google لأصحاب الحسابات القائمة", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "المتابعة باستخدام Google" })).toBeVisible({
    timeout: 15_000,
  });
  await ctx.close();
});
