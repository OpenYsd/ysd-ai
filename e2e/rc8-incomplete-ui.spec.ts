import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * v0.7.0 RC8 — عقد عرض الرد الناقص في الواجهة (A–F).
 *
 * الحالات تُنشأ عبر **المسار الحقيقي** /api/chat مع مزوّد وهمي بسيناريوهات
 * حتمية، لا ببذر مباشر في القاعدة — كي يشمل الاختبار الخادم والواجهة معًا.
 *
 * التحقق من موضع التنبيه **بنيوي** لا بصري: نثبت أن عنصر التنبيه لا يملك
 * أيًّا من code/pre في سلسلة آبائه، وأنه ظاهر مرة واحدة لا اثنتين.
 */

const STORAGE = process.env.YSD_E2E_STORAGE_STATE;
test.skip(!STORAGE || !fs.existsSync(STORAGE), "يحتاج YSD_E2E_STORAGE_STATE");
test.use({ storageState: STORAGE });

const NOTICE = "لم يكتمل هذا الرد. يمكنك إعادة التوليد.";
const MOCK = process.env.YSD_E2E_MOCK_URL ?? "http://localhost:8096";

const created: string[] = [];

async function newConversation(api: APIRequestContext): Promise<string> {
  const r = await api.post("/api/conversations", { data: { title: "RC8 UI" } });
  expect([200, 201]).toContain(r.status());
  const id = (await r.json()).conversation.id;
  created.push(id);
  return id;
}

async function send(api: APIRequestContext, convId: string, message: string) {
  const r = await api.post("/api/chat", {
    data: {
      conversationId: convId,
      modelId: "ysd/free",
      message,
      clientRequestId: `ui-${Math.random().toString(36).slice(2)}`,
    },
    timeout: 60_000,
  });
  const raw = await r.text();
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const e = JSON.parse(line.slice(6));
      if (e.type === "text") text += e.text;
    } catch {}
  }
  return { status: r.status(), text };
}

/** عدّادات المزوّد الوهمي — لإثبات عدم استدعائه عند مجرد التحديث */
async function providerCalls(api: APIRequestContext): Promise<number> {
  const r = await api.get(`${MOCK}/${encodeURIComponent("عدادات")}`);
  return (await r.json()).provider_calls;
}

/** يثبت بنيويًا أن التنبيه خارج code/pre وظاهر مرة واحدة */
async function assertNoticeOutsideCode(page: Page, status: string) {
  const marker = page.locator(`[data-incomplete="${status}"]`);
  await expect(marker).toHaveCount(1);

  // التنبيه المرئي مرة واحدة فقط في نص الصفحة
  const occurrences = await page.evaluate(
    (n) => document.body.innerText.split(n).length - 1,
    NOTICE,
  );
  expect(occurrences, "التنبيه يظهر مرة واحدة فقط").toBe(1);

  // لا code ولا pre في سلسلة الآباء
  const ancestors = await marker.evaluate((el) => {
    const tags: string[] = [];
    let p = el.parentElement;
    while (p) {
      tags.push(p.tagName.toLowerCase());
      p = p.parentElement;
    }
    return tags;
  });
  expect(ancestors, "لا code في آباء التنبيه").not.toContain("code");
  expect(ancestors, "لا pre في آباء التنبيه").not.toContain("pre");

  // والعنصر نفسه ليس code/pre
  const tag = await marker.evaluate((el) => el.tagName.toLowerCase());
  expect(["code", "pre"]).not.toContain(tag);
}

const evenFences = (s: string) => (s.match(/```/g) ?? []).length % 2 === 0;

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL, storageState: STORAGE });
  for (const id of created) await api.delete(`/api/conversations/${id}`).catch(() => undefined);
  await api.dispose();
});

test("أ) رسالة مكتملة — بلا أي علامة نقص", async ({ page, request }) => {
  const cid = await newConversation(request);
  const { text } = await send(request, cid, "سيناريو-عادي اشرح لي");
  expect(text.length).toBeGreaterThan(10);

  await page.goto(`/chat/${cid}`);
  await expect(page.getByText(text.slice(0, 30))).toBeVisible();

  await expect(page.locator("[data-incomplete]")).toHaveCount(0);
  expect(await page.evaluate((n) => document.body.innerText.includes(n), NOTICE)).toBe(false);

  // hard refresh: النص نفسه، وبلا نداء مزوّد
  const before = await providerCalls(request);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText(text.slice(0, 30))).toBeVisible();
  await expect(page.locator("[data-incomplete]")).toHaveCount(0);
  expect(await providerCalls(request), "التحديث لا يستدعي المزوّد").toBe(before);
});

test("ب) incomplete_guard — تنبيه واحد خارج الكود", async ({ page, request }) => {
  const cid = await newConversation(request);
  const { text } = await send(request, cid, "سيناريو-متابعة-فاشلة اشرح لي");
  expect(evenFences(text), "أسيجة زوجية").toBe(true);
  expect(text).not.toContain("bajo el sol");

  await page.goto(`/chat/${cid}`);
  await assertNoticeOutsideCode(page, "incomplete_guard");
  expect(await page.evaluate(() => document.body.innerText)).not.toContain("bajo el sol");

  // زر إعادة التوليد ظاهر لأنها آخر تبادل
  await expect(page.getByRole("button", { name: /إعادة توليد|regenerate/i })).toBeVisible();

  const before = await providerCalls(request);
  await page.reload({ waitUntil: "networkidle" });
  await assertNoticeOutsideCode(page, "incomplete_guard");
  expect(await providerCalls(request), "التحديث لا يستدعي المزوّد").toBe(before);
});

test("ج) incomplete_timeout — السياج مغلق والتنبيه خارجه", async ({ page, request }) => {
  const cid = await newConversation(request);
  const { text } = await send(request, cid, "سيناريو-مهلة-أثناء-البث اكتب دالة");
  expect(evenFences(text), "السياج مغلق في النص النهائي").toBe(true);
  expect(text.indexOf(NOTICE)).toBeGreaterThan(text.lastIndexOf("```"));

  await page.goto(`/chat/${cid}`);
  await assertNoticeOutsideCode(page, "incomplete_timeout");
  await expect(page.getByRole("button", { name: /إعادة توليد|regenerate/i })).toBeVisible();

  const before = await providerCalls(request);
  await page.reload({ waitUntil: "networkidle" });
  await assertNoticeOutsideCode(page, "incomplete_timeout");
  expect(await providerCalls(request)).toBe(before);
});

test("د) incomplete_provider — لا يُعرض كمكتمل", async ({ page, request }) => {
  const cid = await newConversation(request);
  const { text } = await send(request, cid, "سيناريو-انقطاع-المزود اكتب دالة");
  expect(evenFences(text)).toBe(true);

  await page.goto(`/chat/${cid}`);
  await assertNoticeOutsideCode(page, "incomplete_provider");

  const before = await providerCalls(request);
  await page.reload({ waitUntil: "networkidle" });
  await assertNoticeOutsideCode(page, "incomplete_provider");
  expect(await providerCalls(request)).toBe(before);
});

test("هـ) رسالة ناقصة قديمة — زر إعادة التوليد للأخير فقط", async ({ page, request }) => {
  const cid = await newConversation(request);
  // تبادل ناقص أولًا
  await send(request, cid, "سيناريو-مهلة-أثناء-البث اكتب دالة");
  // ثم تبادل أحدث مكتمل
  const second = await send(request, cid, "سيناريو-عادي اشرح لي");

  await page.goto(`/chat/${cid}`);

  // العلامة القديمة باقية
  await expect(page.locator('[data-incomplete="incomplete_timeout"]')).toHaveCount(1);
  await expect(page.getByText(second.text.slice(0, 25))).toBeVisible();

  /**
   * العقد (RC8): regenerate يعيد توليد **آخر** تبادل فقط، فالزر يظهر لآخر
   * رسالة مساعد وحدها — وهي هنا المكتملة لا الناقصة القديمة. زرٌّ على الناقصة
   * كان سيعيد توليد تبادل آخر غير الذي قصده المستخدم.
   */
  const buttons = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await expect(buttons, "زر واحد فقط — للتبادل الأخير").toHaveCount(1);

  // الترتيب والحالات تبقى بعد التحديث
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator('[data-incomplete="incomplete_timeout"]')).toHaveCount(1);
  await expect(buttons).toHaveCount(1);
});

test("و) إعادة التوليد — ضغطة واحدة ونداء واحد", async ({ page, request }) => {
  const cid = await newConversation(request);
  await send(request, cid, "سيناريو-مهلة-أثناء-البث اكتب دالة");

  await page.goto(`/chat/${cid}`);
  await expect(page.locator('[data-incomplete="incomplete_timeout"]')).toHaveCount(1);

  const before = await providerCalls(request);
  const btn = page.getByRole("button", { name: /إعادة توليد|regenerate/i });

  // نقر مزدوج سريع — القفل يجب أن يمنع طلبًا ثانيًا
  await btn.click();
  await btn.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(9000);

  const after = await providerCalls(request);
  expect(after - before, "نداء مزوّد واحد لا اثنان").toBeLessThanOrEqual(1);

  // رسالة المستخدم لم تُحذف
  const userVisible = await page.evaluate(
    () => document.body.innerText.includes("سيناريو-مهلة-أثناء-البث"),
  );
  expect(userVisible, "رسالة المستخدم باقية").toBe(true);

  // التنبيه لا يتكرر
  const occ = await page.evaluate((n) => document.body.innerText.split(n).length - 1, NOTICE);
  expect(occ, "لا تكرار للتنبيه").toBeLessThanOrEqual(1);
});
