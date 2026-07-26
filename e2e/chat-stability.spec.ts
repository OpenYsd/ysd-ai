/**
 * استقرار المحادثة (v0.6.6 RC2) — عبر مسار الإنتاج /api/chat.
 * تحتاج جلسة: YSD_E2E_STORAGE_STATE. تتخطّى نفسها بوضوح إن غابت.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";

const STORAGE = process.env.YSD_E2E_STORAGE_STATE;

test.skip(!STORAGE || !fs.existsSync(STORAGE), "يحتاج YSD_E2E_STORAGE_STATE");
test.use({ storageState: STORAGE });

/** ينشئ محادثة ويعيد معرّفها (مع إعادة محاولة — Supabase يتذبذب) */
async function newConversation(api: APIRequestContext): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const r = await api.post("/api/conversations", { data: {} });
    if (r.ok()) {
      const j = (await r.json()) as { conversation?: { id?: string } };
      if (j.conversation?.id) return j.conversation.id;
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error("تعذّر إنشاء محادثة");
}

/** يقرأ بثّ SSE ويجمع أحداثه */
async function readStream(body: string) {
  const events: { type: string; text?: string; code?: string }[] = [];
  for (const chunk of body.split("\n\n")) {
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      /* جزء ناقص */
    }
  }
  return events;
}
const textOf = (evs: { type: string; text?: string }[]) =>
  evs.filter((e) => e.type === "text").map((e) => e.text).join("");

const created: string[] = [];

test.afterAll(async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL, storageState: STORAGE });
  for (const id of created) await api.delete(`/api/conversations/${id}`).catch(() => undefined);
  await api.dispose();
});

test("★ النقر المزدوج: طلبان متوازيان بنفس المعرّف → رسالة واحدة", async ({ request }) => {
  const convId = await newConversation(request);
  created.push(convId);
  const data = {
    conversationId: convId,
    modelId: "ysd/free",
    message: "اكتب جملة قصيرة عن البحر.",
    clientRequestId: `e2e-double-${Date.now()}`,
  };
  const [a, b] = await Promise.all([
    request.post("/api/chat", { data }),
    request.post("/api/chat", { data }),
  ]);
  const statuses = [a.status(), b.status()].sort();
  expect(statuses).toEqual([200, 409]); // واحد يمرّ وواحد يُرفض كمكرر

  const dup = a.status() === 409 ? a : b;
  expect((await dup.json()).code).toBe("duplicate_request");
});

test("★ إعادة الاتصال بنفس client_request_id → لا رسالة ثانية", async ({ request }) => {
  const convId = await newConversation(request);
  created.push(convId);
  const data = {
    conversationId: convId,
    modelId: "ysd/free",
    message: "اكتب جملة قصيرة عن الجبال.",
    clientRequestId: `e2e-reconnect-${Date.now()}`,
  };
  const first = await request.post("/api/chat", { data });
  expect(first.status()).toBe(200);
  await first.body();

  const again = await request.post("/api/chat", { data }); // إعادة الاتصال
  expect(again.status()).toBe(409);
});

test("★ «جوجو» الملتبسة → سؤال توضيح بلا نداء مزوّد", async ({ request }) => {
  const convId = await newConversation(request);
  created.push(convId);
  const res = await request.post("/api/chat", {
    data: {
      conversationId: convId,
      modelId: "ysd/free",
      message: "عطني معلومات عن جوجو",
      clientRequestId: `e2e-jojo-${Date.now()}`,
    },
  });
  expect(res.status()).toBe(200);
  const text = textOf(await readStream(await res.text()));
  expect(text).toContain("تقصد");
  expect(text).toContain("JoJo's Bizarre Adventure");
});

test("★ Jujutsu Kaisen بلا خلط ولا قائمة مقطوعة ولا عبارة جودة زائدة", async ({ request }) => {
  const convId = await newConversation(request);
  created.push(convId);
  const res = await request.post("/api/chat", {
    data: {
      conversationId: convId,
      modelId: "ysd/free",
      message: "ايش رايك في انمي جوجيتسو كايسن؟",
      clientRequestId: `e2e-jjk-${Date.now()}`,
    },
  });
  expect(res.status()).toBe(200);
  const text = textOf(await readStream(await res.text()));

  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/JoJo|بيزار|Bizarre/i); // بلا خلط
  expect(text).not.toMatch(/^\s*\d+[.)]\s*$/m); // بلا رقم قائمة منفرد
  if (/[.!?؟…]\s*$/.test(text.trim())) {
    expect(text).not.toContain("توقفت هنا للحفاظ على جودة الرد"); // بلا عبارة زائدة
  }
});

test("★ White Mask: الوضع المحمي يردّ فورًا بلا نداء مزوّد", async ({ request }) => {
  for (let i = 0; i < 2; i++) {
    const convId = await newConversation(request);
    created.push(convId);
    const res = await request.post("/api/chat", {
      data: {
        conversationId: convId,
        modelId: "ysd/free",
        message: "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟",
        clientRequestId: `e2e-wm-${i}-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(200);
    const text = textOf(await readStream(await res.text()));
    expect(text).toContain("Elden Ring");
    expect(text).toContain("White Mask");
    expect(text).not.toMatch(/Siofra|Mountaintops|Dragon-?Burnt/i); // بلا مواقع مختلقة
  }
});

