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

/** سيناريو يُمسك الاتصال مفتوحًا حتى أمر الإطلاق — يجعل active_sockets=1 مُثبتًا */
const HOLD_PROMPT = "سيناريو-ممسوك-مفتوح اشرح لي";

interface Counters {
  provider_calls: number;
  active_sockets: number;
  chunks_sent: number;
  released: boolean;
}

async function allCounters(api: APIRequestContext): Promise<Counters> {
  return (await api.get(`${MOCK}/${encodeURIComponent("عدادات")}`)).json();
}
async function resetCounters(api: APIRequestContext): Promise<void> {
  await api.get(`${MOCK}/${encodeURIComponent("تصفير")}`);
}
async function releaseHeld(api: APIRequestContext): Promise<void> {
  await api.get(`${MOCK}/${encodeURIComponent("إطلاق")}`);
}

/** حاجز حتمي على عدّادات المزوّد — لا تأخير تخميني */
async function untilCounters(
  api: APIRequestContext,
  pred: (c: Counters) => boolean,
  ms = 30_000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(await allCounters(api))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
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

test("و) إعادة التوليد — إعادة دخول أثناء بثّ حيّ لا تُنشئ طلبًا", async ({
  page,
  request,
}) => {
  /**
   * harness مُصحَّح (v0.7.0 RC8). ثلاثة أخطاء في الصيغة السابقة:
   *   • الحاجز كان `chunks_sent>=1` وحده، و`active_sockets` يقرأ 0 عنده — فلم
   *     يُثبت قط أن إعادة الدخول وقعت أثناء بثّ حيّ. الآن hold_open يُمسك
   *     الاتصال مفتوحًا فيصير active_sockets=1 قابلًا للإثبات.
   *   • خلط click مع dispatchEvent يولّد **نقرتين مستقلتين**، فالنداء الثاني
   *     كان مشروعًا لا خرقًا. الآن حدث واحد فقط.
   *   • القياس بالرقم الإجمالي كان يخلط طلب التجهيز. الآن بالفرق عن baseline.
   */
  const cid = await newConversation(request);

  // كل POST إلى /api/chat مع حالته — لتشخيص أي طلب متأخر
  const posts: { t: number; crid: string; regen: boolean; status?: number }[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/chat") && r.method() === "POST") {
      let crid = "?";
      let regen = false;
      try {
        const b = JSON.parse(r.postData() ?? "{}");
        crid = String(b.clientRequestId ?? "none").slice(0, 8);
        regen = b.regenerate === true;
      } catch {}
      posts.push({ t: Date.now(), crid, regen });
    }
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/chat") && r.request().method() === "POST") {
      const last = posts[posts.length - 1];
      if (last && last.status === undefined) last.status = r.status();
    }
  });

  // تجهيز: hold_open ثم إطلاقه ليكتمل التبادل (فيظهر زر إعادة التوليد)
  const seed = request.post("/api/chat", {
    data: {
      conversationId: cid,
      modelId: "ysd/free",
      message: HOLD_PROMPT,
      clientRequestId: `f-seed-${Date.now()}`,
    },
    timeout: 90_000,
  });
  await untilCounters(request, (c) => c.chunks_sent >= 1 && c.active_sockets >= 1);
  await releaseHeld(request);
  await seed;

  await page.goto(`/chat/${cid}`);
  await resetCounters(request);
  const base = await allCounters(request);
  posts.length = 0;

  const btn = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await expect(btn).toHaveCount(1);

  // ١) حدث واحد يبدأ المحاولة الأولى
  await btn.click();
  const reached = await untilCounters(
    request,
    (c) => c.provider_calls >= 1 && c.active_sockets >= 1 && c.chunks_sent >= 1,
  );
  const atBarrier = await allCounters(request);
  expect(reached, "الحاجز ببثّ حيّ").toBe(true);
  expect(atBarrier.active_sockets, "socket مفتوح فعلًا").toBe(1);
  expect(atBarrier.released).toBe(false);

  // ٢) إعادة دخول بحدث **واحد** أثناء البثّ الحيّ
  await btn.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const during = await allCounters(request);

  expect(during.provider_calls - base.provider_calls, "نداء واحد أثناء التزامن").toBe(1);
  expect(during.active_sockets, "الاتصال الأول لم يُجهض").toBe(1);
  expect(posts.filter((p) => p.regen).length, "طلب regenerate واحد").toBe(1);

  // ٣) إطلاق ← done ← تحرير القفل
  await releaseHeld(request);
  await untilCounters(request, (c) => c.active_sockets === 0);
  await page.waitForTimeout(2000);
  expect((await allCounters(request)).active_sockets).toBe(0);

  // ٤) محاولة جديدة مقصودة بعد الاكتمال — القفل لم يبق عالقًا
  await btn.click();
  await untilCounters(request, (c) => c.provider_calls - base.provider_calls >= 2);
  const after = await allCounters(request);
  expect(after.provider_calls - base.provider_calls, "محاولتان مقصودتان").toBe(2);

  const regenPosts = posts.filter((p) => p.regen);
  expect(
    new Set(regenPosts.map((p) => p.crid)).size,
    "مفتاح مختلف لكل محاولة مقصودة",
  ).toBe(regenPosts.length);

  // رسالة المستخدم باقية
  expect(
    await page.evaluate(() => document.body.innerText.includes("سيناريو-ممسوك-مفتوح")),
    "رسالة المستخدم باقية",
  ).toBe(true);

  console.log("POSTs: " + JSON.stringify(posts));
  await releaseHeld(request);
});
