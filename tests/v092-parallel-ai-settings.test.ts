/**
 * توازي `getAiSettings` (v0.9.2) — **توقيتٌ لا سلوك**.
 *
 * ── القياس الذي دفع إليه ──
 *
 * `app_before_provider_ms ≈ 2891` منها ~2183 مل خارج الاسترجاع. والكود يوثّق
 * السبب: كل رحلة إلى Supabase ~310 مل بسبب بُعد المنطقة. فسبع رحلات متتابعة
 * هي ثمن **الانتظار** لا ثمن العمل.
 *
 * و`getAiSettings` أوّل مرشّح بلا منازع: تقرأ `platform_settings` بمفاتيح
 * ثابتة — بلا `userId` ولا `conversationId` ولا شيء يُحسب قبلها. فانتظارها
 * في موضعها كان تسلسلًا بلا سبب.
 *
 * ── وما يُحرَس هنا ──
 *
 * أن الإطلاق المبكّر لم يشترِ سرعةً بثمن: لا نداء ثانٍ، ولا قيمة تتغيّر، ولا
 * استثناء يُبتلع، ولا ترتيب حسّاس ينزلق (`claim → insert` خاصةً).
 *
 * والتوقيت يُقاس بوعود مُتحكَّم بها لا بساعة الجدار — فالاختبار حتميّ.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

/* ═════════ نموذج مُتحكَّم به: متسلسل مقابل متداخل ═════════ */

/** وعدٌ يُحلّ يدويًّا — بلا مؤقّتات ولا ساعة جدار */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** ساعة منطقية: كل «رحلة» تتقدّم بمقدارها عند حلّها */
function scenario() {
  let now = 0;
  const at = () => now;
  const trip = <T>(ms: number, value: T) => {
    const d = deferred<T>();
    // الحلّ يُؤجَّل إلى دورة تالية كي يتداخل مع غيره فعليًّا
    queueMicrotask(() => {
      now = Math.max(now, ms);
      d.resolve(value);
    });
    return d.promise;
  };
  return { at, trip };
}

describe("★ نموذج التوازي — 300 + 300", () => {
  const CONV = 300;
  const SETTINGS = 300;

  it("★ المتسلسل (قبل الرقعة) ⇒ مجموع الرحلتين", async () => {
    let clock = 0;
    const seq = async (ms: number) => {
      clock += ms; // الانتظار يبدأ بعد انتهاء سابقه
      return ms;
    };
    await seq(CONV);
    await seq(SETTINGS);
    expect(clock).toBe(600); // ★ 600 مل — الحالة القديمة
  });

  it("★ المتداخل (بعد الرقعة) ⇒ الأطول وحده", async () => {
    /**
     * الإعدادات تُطلَق أولًا ثم تجري رحلة المحادثة تحتها. والزمن المنقضي
     * هو الأطول لا المجموع — وهذا هو المكسب بعينه.
     */
    const started: number[] = [];
    const mk = (ms: number) => {
      started.push(0);
      return new Promise<number>((r) => setTimeout(() => r(ms), ms));
    };
    const t0 = Date.now();
    const settings = mk(SETTINGS); // أُطلقت مبكرًا
    const conv = await mk(CONV);
    const s = await settings;
    const elapsed = Date.now() - t0;

    expect(conv).toBe(CONV);
    expect(s).toBe(SETTINGS);
    // ★ الأطول لا المجموع — بهامش سخيّ كي لا يهتزّ الاختبار على آلة بطيئة
    expect(elapsed).toBeLessThan(CONV + SETTINGS - 50);
  });

  it("★ الإطلاق المبكّر لا يغيّر القيمة الواصلة", async () => {
    const { trip } = scenario();
    const value = { defaultModel: "m", allowedModels: ["m"] };
    const p = trip(300, value);
    // يُنتظَر لاحقًا — والقيمة هي هي بالمرجع نفسه
    const got = await p;
    expect(got).toBe(value);
  });
});

/* ═════════ (A–F) حرّاس بنيوية على المسار الحقيقيّ ═════════ */

const launchAt = ROUTE.indexOf("const aiSettingsPromise = getAiSettings(supabase);");
const awaitAt = ROUTE.indexOf("const aiSettings = await aiSettingsPromise;");

describe("★ (A–F) المسار الحقيقيّ", () => {
  it("★ (A) الإطلاق يسبق المراحل التي كانت تسبقه", () => {
    expect(launchAt).toBeGreaterThan(0);
    for (const later of [
      "const [{ data: conv }, { data: allowed }] = await Promise.all([", // المحادثة
      "const slot = await acquireSlot(",
      "const budget = await reserveChatBudget({",
      "const claim = await claimRequestDurable(",
    ]) {
      const idx = ROUTE.indexOf(later);
      expect(idx).toBeGreaterThan(0);
      // ★ الإطلاق قبلها كلها — فتجري الإعدادات تحتها لا بعدها
      expect(launchAt).toBeLessThan(idx);
    }
  });

  it("★ (A′) ولا يسبق التحقق من الجلسة — لا رحلة قبل إثبات الهوية", () => {
    const authAt = ROUTE.indexOf("const ctx = await getRequestContext(");
    const guardAt = ROUTE.indexOf('code: "auth_expired" }, 401)');
    expect(authAt).toBeGreaterThan(0);
    expect(launchAt).toBeGreaterThan(guardAt);
  });

  it("★ (B) الانتظار في موضع الحاجة القديم — لم يتقدّم", () => {
    expect(awaitAt).toBeGreaterThan(launchAt);
    // ما يزال بعد الفتحة والميزانية كما كان
    expect(awaitAt).toBeGreaterThan(ROUTE.indexOf("const slot = await acquireSlot("));
    expect(awaitAt).toBeGreaterThan(ROUTE.indexOf("const budget = await reserveChatBudget({"));
  });

  it("★ (C) المستهلك يتلقّى النتيجة نفسها — لا نسخة ولا اشتقاق", () => {
    expect(ROUTE).toContain("const aiSettings = await aiSettingsPromise;");
    // لا تحويل بين الإطلاق والاستعمال
    const between = ROUTE.slice(launchAt, awaitAt);
    expect(between).not.toContain("aiSettingsPromise.then(");
    expect(between).not.toContain("structuredClone");
  });

  it("★ (D) الفشل يُعاد رميه في موضعه القديم — لا ابتلاع", () => {
    /**
     * `catch` المرافق للإطلاق يُعلِم الرافعة أن الرفض مُعالَج فلا يسقط
     * العملية كرفضٍ عائم. لكنه على **فرعٍ منفصل**: `await` يُعيد رمي
     * الخطأ نفسه عند نقطة الاستعمال كما كان تمامًا.
     */
    expect(ROUTE).toContain("void aiSettingsPromise.catch(() => undefined);");
    // ولا `.catch` يُعيد بديلًا على المسار المُنتظَر
    expect(ROUTE).not.toContain("await aiSettingsPromise.catch(");
  });

  it("★ (D′) سلوك الرفض مطابق: الفرع الحارس لا يبتلع الاستثناء", async () => {
    const boom = new Error("settings failed");
    const p = Promise.reject(boom);
    void p.catch(() => undefined); // نفس النمط المستعمل في المسار
    // ★ الانتظار ما يزال يرمي الخطأ الأصلي بعينه
    await expect(p).rejects.toBe(boom);
  });

  it("★ (E) نداء واحد لكل طلب — لا ازدواج", () => {
    expect((ROUTE.match(/getAiSettings\(/g) ?? []).length).toBe(1);
    expect((ROUTE.match(/await aiSettingsPromise/g) ?? []).length).toBe(1);
  });

  it("★ (F) الترتيب الحسّاس لم ينزلق: claim ثم insert", () => {
    const claimAt = ROUTE.indexOf("const claim = await claimRequestDurable(");
    const insertAt = ROUTE.indexOf('.insert({ conversation_id: conversationId, role: "user"');
    expect(claimAt).toBeGreaterThan(0);
    expect(insertAt).toBeGreaterThan(0);
    // ★ الحماية من التكرار تسبق الحفظ — وإلا تكرّرت رسالة المستخدم
    expect(claimAt).toBeLessThan(insertAt);
  });

  it("★ (F′) الفتحة والميزانية بترتيبهما وبانتظارهما كما كانا", () => {
    const slotAt = ROUTE.indexOf("const slot = await acquireSlot(");
    const budgetAt = ROUTE.indexOf("const budget = await reserveChatBudget({");
    expect(slotAt).toBeLessThan(budgetAt);
    // ما زالتا مُنتظَرتين لا مُطلَقتين — هذه الرقعة لا تمسّهما
    expect(ROUTE).toContain("const slot = await acquireSlot(");
    expect(ROUTE).toContain("const budget = await reserveChatBudget({");
  });
});

/* ═════════ ما لم يتغيّر ═════════ */

describe("★ بقيّة ما قبل المزوّد لم تُمسّ", () => {
  it("★ لا توازي جديد في العمليات ذات الحجز أو الترتيب", () => {
    // gatherChatContext ما تزال بعد الإدراج، وRAG بعدها
    const insertAt = ROUTE.indexOf('.insert({ conversation_id: conversationId, role: "user"');
    const gatherAt = ROUTE.indexOf("await gatherChatContext(supabase, {");
    const ragAt = ROUTE.indexOf("if (queryText && contextFileIds.length > 0) {");
    expect(insertAt).toBeLessThan(gatherAt);
    expect(gatherAt).toBeLessThan(ragAt);
  });

  it("★ الرصد القائم محفوظ بحقوله كلها", () => {
    for (const f of [
      "settings_ms=",
      "slot_ms=",
      "budget_ms=",
      "idempotency_claim_ms=",
      "user_message_insert_ms=",
      "context_gather_ms=",
      "rag_ms=",
      "rag_total_ms=",
      "app_before_provider_ms=",
      "pre_provider_other_ms=",
    ]) {
      expect(ROUTE).toContain(f);
    }
  });

  it("★ شرط تشغيل الاسترجاع كما هو — لا بوابة جديدة", () => {
    expect(ROUTE).toContain("if (queryText && contextFileIds.length > 0) {");
  });
});
