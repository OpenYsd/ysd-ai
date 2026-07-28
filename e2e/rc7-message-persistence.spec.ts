import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

const STORAGE = process.env.YSD_E2E_STORAGE_STATE;
test.skip(!STORAGE || !fs.existsSync(STORAGE), "يحتاج YSD_E2E_STORAGE_STATE");
test.use({ storageState: STORAGE });

/**
 * v0.7.0 RC7 — إثبات السبب الجذري لاختفاء رسالة المساعد بعد تحديث الصفحة.
 *
 * لا يعدّل هذا الملف شيئًا؛ مهمّته جمع الأدلة التي تفصل بين الاحتمالات:
 *   أ) الرسالة أصلًا ليست في HTML الأولي (عطل خادم/استعلام).
 *   ب) موجودة في HTML ثم يحذفها hydration.
 *   ج) حالة العميل تستبدل رسائل الخادم بقائمة فارغة.
 *   د) سباق بين conversation_id وطلب قديم.
 *   هـ) إعادة تحقق أو router.refresh بعد التحميل.
 *
 * الأداة الحاسمة: MutationObserver يُركَّب **قبل** hydration عبر
 * addInitScript، فيسجّل كل لحظة تتغيّر فيها قائمة الرسائل مع الطابع الزمني.
 */

const ASSISTANT_MARK = "علامة-إثبات-البقاء";

interface MutationLog {
  t: number;
  count: number;
  hasAssistant: boolean;
  occurrences: number;
  phase: string;
}

/** يُركَّب قبل أي سكربت للصفحة — يرصد من أول عقدة تظهر في DOM */
const OBSERVER_INIT = (mark: string) => {
  const w = window as unknown as { __ysdLog: MutationLog[]; __ysdT0: number };
  w.__ysdLog = [];
  w.__ysdT0 = Date.now();

  const snapshot = (phase: string) => {
    // غلاف الرسالة في الواجهة هو div.rise — لا نضيف سمة اختبار للكود قبل إثبات السبب
    const nodes = document.querySelectorAll(".rise");
    const text = document.body?.innerText ?? "";
    // العلامة ترد مرتين: في رسالة المستخدم وفي رد المساعد. وجود واحدة فقط
    // يعني أن رد المساعد هو الذي اختفى — وهو بالضبط ما نبحث عنه.
    const occurrences = text.split(mark).length - 1;
    w.__ysdLog.push({
      t: Date.now() - w.__ysdT0,
      count: nodes.length,
      hasAssistant: occurrences >= 2,
      occurrences,
      phase,
    });
  };

  const start = () => {
    snapshot("observer_start");
    new MutationObserver(() => snapshot("mutation")).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });

  document.addEventListener("DOMContentLoaded", () => snapshot("DOMContentLoaded"));
  window.addEventListener("load", () => snapshot("load"));
};

async function readLog(page: Page): Promise<MutationLog[]> {
  return page.evaluate(
    () => (window as unknown as { __ysdLog: MutationLog[] }).__ysdLog ?? [],
  );
}

// تسلسلي: الاختبارات تتشارك محادثة واحدة أُنشئت في الأولى
test.describe.configure({ mode: "serial" });

test.describe("★ RC7: رسالة المساعد لا تختفي بعد التحديث", () => {
  let convId = "";
  let convUrl = "";

  test("١) تجهيز: رسالة user + assistant محفوظتان فعلًا", async ({ request }) => {
    // محادثة مبذورة في القاعدة مباشرة (YSD_E2E_SEEDED_CONV) — لا تحتاج مزوّدًا.
    // هذا يفصل ما نختبره (بقاء الرسالة المحفوظة عبر التحديث) عن توليد الردّ.
    const seeded = process.env.YSD_E2E_SEEDED_CONV;
    if (seeded) {
      convId = seeded;
      convUrl = `/chat/${convId}`;
      const probe = await request.get(convUrl);
      expect(probe.status()).toBe(200);
      return;
    }

    const created = await request.post("/api/conversations", {
      data: { title: "RC7 إثبات البقاء" },
    });
    expect([200, 201]).toContain(created.status());
    convId = (await created.json()).conversation.id;
    convUrl = `/chat/${convId}`;

    const res = await request.post("/api/chat", {
      data: {
        conversationId: convId,
        modelId: "ysd/free",
        message: `اكتب الجملة التالية حرفيًا ولا شيء غيرها: ${ASSISTANT_MARK}`,
        clientRequestId: `rc7-persist-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(200);
    const stream = await res.text();
    expect(stream).toContain('"type":"done"');
    const doneLine = stream.split("\n").find((l) => l.includes('"type":"done"')) ?? "";
    const assistantMessageId = JSON.parse(doneLine.replace(/^data: /, "")).assistantMessageId;
    expect(assistantMessageId, "رسالة المساعد يجب أن تُحفظ في القاعدة").toBeTruthy();
  });

  test("٢) HTML الأولي من الخادم يحوي رسالة المساعد (يفصل الاحتمال أ)", async ({
    request,
  }) => {
    const res = await request.get(convUrl);
    expect(res.status()).toBe(200);
    const html = await res.text();
    // الاحتمال (أ): لو غابت من HTML فالعطل في الخادم لا في hydration
    expect(html, "رسالة المساعد يجب أن تصل مع HTML الأولي").toContain(ASSISTANT_MARK);
  });

  for (let round = 1; round <= 5; round++) {
    test(`٣.${round}) hard reload — لا اختفاء في أي frame`, async ({ page }) => {
      await page.addInitScript(OBSERVER_INIT, ASSISTANT_MARK);
      await page.goto(convUrl, { waitUntil: "commit" });
      // نراقب أول ثانيتين بدقة
      await page.waitForTimeout(2000);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const log = await readLog(page);
      expect(log.length, "يجب أن يسجّل المراقب أحداثًا").toBeGreaterThan(0);

      // أول لحظة ظهرت فيها الرسالة
      const firstSeen = log.findIndex((e) => e.hasAssistant);
      expect(firstSeen, "الرسالة يجب أن تظهر خلال الرصد").toBeGreaterThanOrEqual(0);

      // الاحتمالان (ب) و(ج): هل اختفت بعد أن ظهرت؟
      const disappearedAt = log
        .slice(firstSeen)
        .filter((e) => !e.hasAssistant)
        .map((e) => `${e.phase}@${e.t}ms`);
      expect(
        disappearedAt,
        `اختفت رسالة المساعد بعد ظهورها عند: ${disappearedAt.join(", ")}`,
      ).toEqual([]);

      // حالة فارغة مؤقتة بعد أن صار هناك رسائل
      const firstNonEmpty = log.findIndex((e) => e.count > 0);
      if (firstNonEmpty >= 0) {
        const emptied = log
          .slice(firstNonEmpty)
          .filter((e) => e.count === 0)
          .map((e) => `${e.phase}@${e.t}ms`);
        expect(emptied, `قائمة الرسائل صارت فارغة عند: ${emptied.join(", ")}`).toEqual([]);
      }

      // بعد الاستقرار: العلامة موجودة مرتين (رسالة المستخدم + رد المساعد)
      const finalCount = await page.evaluate(
        (m) => document.body.innerText.split(m).length - 1,
        ASSISTANT_MARK,
      );
      expect(
        finalCount,
        `ظهور العلامة بعد الاستقرار=${finalCount} · السجل=${JSON.stringify(
          log.map((e) => [e.phase, e.t, e.occurrences, e.count]),
        )}`,
      ).toBeGreaterThanOrEqual(2);
    });
  }

  test("٤) مع تأخير اصطناعي على RSC (يفصل الاحتمالين د/هـ)", async ({ page }) => {
    await page.addInitScript(OBSERVER_INIT, ASSISTANT_MARK);
    // نُبطئ طلبات RSC وحدها — لو ظهر وميض فارغ فهو سباق/إعادة تحقق
    await page.route("**/chat/**", async (route) => {
      const isRsc = route.request().headers()["rsc"] !== undefined;
      if (isRsc) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto(convUrl, { waitUntil: "commit" });
    await page.waitForTimeout(3000);

    const log = await readLog(page);
    const firstSeen = log.findIndex((e) => e.hasAssistant);
    expect(firstSeen).toBeGreaterThanOrEqual(0);
    const gone = log.slice(firstSeen).filter((e) => !e.hasAssistant);
    expect(gone.map((e) => `${e.phase}@${e.t}ms`)).toEqual([]);
    const finalCount = await page.evaluate(
      (m) => document.body.innerText.split(m).length - 1,
      ASSISTANT_MARK,
    );
    expect(finalCount).toBeGreaterThanOrEqual(2);
  });

  test.afterAll(async ({ request }) => {
    if (convId) await request.delete(`/api/conversations/${convId}`);
  });
});
