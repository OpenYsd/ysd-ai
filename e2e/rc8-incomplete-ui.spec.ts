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
  /** نبضات الإبقاء على الاتصال — تعليق SSE لا حدث نص */
  heartbeat_sent: number;
  client_aborted: number;
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


/**
 * F — إعادة التوليد، اختبار **صندوق أسود** بحتة (v0.7.0 RC8).
 *
 * لا جسر ولا hook ولا عدّاد داخل كود المنتج: Playwright يرى ما يراه المستخدم.
 * والعقد الذي يمنع إعادة الدخول هو **تعطيل الزر** أثناء التوليد — وهو سلوك
 * واجهة حقيقي، لا سيناريو أبيض الصندوق. أما التزامن الحقيقي على الخادم فله
 * اختباره المستقل بمفتاح واحد ([200,409]) ولا يحتاج واجهة أصلًا.
 *
 * ملاحظة على الأدوات: لا force:true ولا dispatchEvent على زر معطَّل — ثبت أن
 * النقر أثناء بثّ SSE مفتوح يحجب حتى استقرار الصفحة، فيصل بعد انتهاء البثّ
 * ويُقاس خطأً. الزر المعطَّل نفسه هو الإثبات.
 */
test("و) إعادة التوليد — طلب واحد، زر معطَّل، ثم محاولة جديدة بعد الاكتمال", async ({
  page,
  request,
}) => {
  const cid = await newConversation(request);

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

  // تجهيز: تبادل ممسوك ثم إطلاقه ليكتمل، فيظهر زر إعادة التوليد
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

  const regenBtn = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await expect(regenBtn).toHaveCount(1);
  await expect(regenBtn).toBeEnabled();

  // ═══ أ) ضغطة عادية واحدة ═══
  await regenBtn.click();
  const reached = await untilCounters(
    request,
    (c) =>
      c.provider_calls >= 1 &&
      c.active_sockets >= 1 &&
      c.chunks_sent >= 1 &&
      c.heartbeat_sent >= 1,
  );
  const atBarrier = await allCounters(request);
  expect(reached, "الحاجز ببثّ حيّ مع نبضة").toBe(true);
  expect(atBarrier.active_sockets).toBe(1);
  expect(atBarrier.released).toBe(false);

  /**
   * عقد الواجهة الفعلي — أقوى من مجرد `disabled`: الزر **يغيب** أثناء التوليد.
   * السبب: البثّ يُضيف رسالة مساعد مؤقتة تصير هي آخر رسالة، وصفوف البثّ لا
   * تحمل شريط أفعال. فلا وجود لزر يُنقر أصلًا، ومعه يستحيل إعادة الدخول من
   * الواجهة. (كنت أتوقّع `disabled` فصحّحت التوقّع على السلوك المرصود.)
   */
  await expect(regenBtn, "زر إعادة التوليد يغيب أثناء التوليد").toHaveCount(0);
  const stopBtn = page.getByRole("button", { name: /إيقاف|stop/i });
  await expect(stopBtn, "زر الإيقاف ظاهر").toBeVisible();

  expect(posts.filter((p) => p.regen).length, "POST واحدة").toBe(1);
  expect(new Set(posts.map((p) => p.crid)).size, "مفتاح واحد").toBe(1);
  expect(atBarrier.provider_calls - base.provider_calls).toBe(1);
  expect(atBarrier.client_aborted).toBe(0);

  // ═══ ب) الثبات أثناء النبضة ═══
  const postsAtBarrier = posts.length;
  await page.waitForTimeout(9000);
  const during = await allCounters(request);
  expect(during.active_sockets, "الاتصال باقٍ بفضل النبضة").toBe(1);
  expect(during.provider_calls - base.provider_calls, "لا نداء جديد").toBe(1);
  expect(posts.length, "لا POST تلقائية أثناء النبضة").toBe(postsAtBarrier);
  expect(during.heartbeat_sent, "النبضة تعمل").toBeGreaterThan(0);
  expect(
    await page.evaluate(() => document.body.innerText.includes("heartbeat")),
    "النبضة لا تظهر في DOM",
  ).toBe(false);

  // ═══ ج) الإطلاق والاكتمال ═══
  await releaseHeld(request);
  await untilCounters(request, (c) => c.active_sockets === 0);
  await page.waitForTimeout(2500);
  await expect(regenBtn, "الزر يعود مفعَّلًا بعد الاكتمال").toBeEnabled();
  await expect(page.locator("[data-incomplete]"), "الرد الجديد مكتمل").toHaveCount(0);

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText.split(NOTICE).length - 1, "لا تنبيه مكرر").toBe(0);
  expect(bodyText.includes("سيناريو-ممسوك-مفتوح"), "رسالة المستخدم باقية").toBe(true);

  // hard refresh لا يستدعي المزوّد
  const beforeRefresh = await allCounters(request);
  const postsBeforeRefresh = posts.length;
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const afterRefresh = await allCounters(request);
  expect(afterRefresh.provider_calls, "التحديث لا يستدعي المزوّد").toBe(
    beforeRefresh.provider_calls,
  );
  expect(posts.length, "التحديث لا يُنشئ POST").toBe(postsBeforeRefresh);
  await expect(page.locator("[data-incomplete]")).toHaveCount(0);

  // ═══ د) محاولة جديدة مقصودة بعد الاكتمال ═══
  const btn2 = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await expect(btn2).toBeEnabled();
  await btn2.click();
  await untilCounters(request, (c) => c.provider_calls - base.provider_calls >= 2);
  const after = await allCounters(request);
  expect(after.provider_calls - base.provider_calls, "محاولتان مقصودتان").toBe(2);

  const regenPosts = posts.filter((p) => p.regen);
  expect(regenPosts.length, "طلبان فقط — واحد لكل محاولة").toBe(2);
  expect(regenPosts[0]?.crid).not.toBe(regenPosts[1]?.crid);
  expect(regenPosts[0]?.status, "الأول 200").toBe(200);

  console.log("POSTs: " + JSON.stringify(posts));
  await releaseHeld(request);
});

test("ز) زر الإيقاف — يُلغي بلا حفظ رد جزئي", async ({ page, request }) => {
  const cid = await newConversation(request);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/chat") && r.method() === "POST") posts.push(String(Date.now()));
  });

  await resetCounters(request);
  // نبدأ من صفحة المحادثة ونرسل من الواجهة كي يكون زر الإيقاف في سياقه
  const seed = request.post("/api/chat", {
    data: { conversationId: cid, modelId: "ysd/free", message: HOLD_PROMPT,
      clientRequestId: `z-seed-${Date.now()}` }, timeout: 90_000 });
  await untilCounters(request, (c) => c.chunks_sent >= 1 && c.active_sockets >= 1);
  await releaseHeld(request);
  await seed;

  await page.goto(`/chat/${cid}`);
  await resetCounters(request);
  const base = await allCounters(request);

  const regenBtn = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await regenBtn.click();
  await untilCounters(
    request,
    (c) => c.active_sockets >= 1 && c.heartbeat_sent >= 1,
  );

  // زر الإيقاف الحقيقي في شريط الإدخال — لا زر الرسالة
  const stopBtn = page.getByRole("button", { name: /إيقاف|stop/i });
  await expect(stopBtn).toBeVisible();
  await stopBtn.click();
  await page.waitForTimeout(2500);

  const after = await allCounters(request);
  expect(after.client_aborted, "client_aborted = 1").toBe(1);
  expect(after.active_sockets, "الاتصال أُغلق").toBe(0);
  expect(after.provider_calls - base.provider_calls, "لا نداء ثانٍ").toBe(1);

  // لا رد جزئي محفوظ، ولا علامة نقص بسبب إيقاف المستخدم
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("[data-incomplete]"), "لا علامة نقص من الإيقاف").toHaveCount(0);
  /**
   * العقد بعد إصلاح cancel-safe (v0.7.0 RC8): الإيقاف **يستعيد** الرد السابق
   * سليمًا — لا يترك المحادثة برسالة مستخدم وحدها. فلا نفحص غياب نصّ (المزوّد
   * الوهمي حتمي فنصّ القديم والجديد متطابقان)، بل نفحص أن ردًّا واحدًا نشطًا
   * موجود وأن زر إعادة التوليد عاد — وهو ما يراه المستخدم فعلًا.
   * حفظ الرد الجزئي منفيٌّ بالقاعدة في مجموعة cancel-safe (12/12).
   */
  await expect(
    page.getByRole("button", { name: /إعادة توليد|regenerate/i }),
    "زر إعادة التوليد عاد ⇒ الرد السابق مستعاد",
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => document.body.innerText.includes("سيناريو-ممسوك-مفتوح")),
    "رسالة المستخدم باقية",
  ).toBe(true);

  // بعد التنظيف: محاولة جديدة تعمل
  const btn = page.getByRole("button", { name: /إعادة توليد|regenerate/i });
  await expect(btn).toBeEnabled();
  await btn.click();
  await untilCounters(request, (c) => c.provider_calls - base.provider_calls >= 2);
  expect((await allCounters(request)).provider_calls - base.provider_calls).toBe(2);
  await releaseHeld(request);
});
