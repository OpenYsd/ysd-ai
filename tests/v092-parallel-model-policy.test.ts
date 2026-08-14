/**
 * توازي `loadModelPolicy` على مستوى الطلب (v0.9.2) — **توقيتٌ لا سلوك**.
 *
 * ── القياس الذي دفع إليه ──
 *
 * بعد التوازي الداخليّ صار `model_policy_ms = 338` كلّها في `primary`
 * و`limits = 0`. فلم يبقَ ما يُقصَّر داخلها — بقي **متى تبدأ**.
 *
 * وهي لا تحتاج إلا `userId` المتاح فور إثبات الجلسة. فانتظارها في موضعها
 * كان يجعلها تجري بعد تحليل الطلب ورحلة المحادثة، وكلاهما لا يعتمد عليها.
 *
 * ── حدّ التداخل ──
 *
 * أوّل من يحتاج نتيجتها `acquireSlot` (يقرأ `policy.userTier`). فالمدى
 * المتاح هو ما بين الإطلاق وذلك الاستعمال — لا يُزاد عليه بلا تغيير ترتيب
 * حقيقيّ، وهذا ما تحرسه (B) و(I).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

const launchAt = ROUTE.indexOf("const modelPolicyPromise = loadModelPolicy(");
const awaitAt = ROUTE.indexOf("const policy = await modelPolicyPromise;");
const authGuardAt = ROUTE.indexOf('code: "auth_expired" }, 401)');
const userIdAt = ROUTE.indexOf("const userId = ctx.userId;");
const parseAt = ROUTE.indexOf("const parsed = chatRequestSchema.safeParse(");
const convAt = ROUTE.indexOf("const [{ data: conv }, { data: allowed }] = await Promise.all([");
const slotAt = ROUTE.indexOf("const slot = await acquireSlot(");
const budgetAt = ROUTE.indexOf("const budget = await reserveChatBudget({");

/* ═════════ (A–C) موضع الإطلاق والانتظار ═════════ */

describe("★ (A–C) الإطلاق والانتظار", () => {
  it("★ (A) يبدأ بعد إثبات الجلسة مباشرة", () => {
    expect(launchAt).toBeGreaterThan(0);
    expect(userIdAt).toBeGreaterThan(0);
    // ★ لا رحلة قاعدة قبل إثبات الهوية
    expect(launchAt).toBeGreaterThan(authGuardAt);
    expect(launchAt).toBeGreaterThan(userIdAt);
  });

  it("★ (B) ويسبق كل مرحلة لا تعتمد عليه", () => {
    for (const [name, idx] of [
      ["request parse", parseAt],
      ["conversation access", convAt],
      ["slot", slotAt],
      ["budget", budgetAt],
    ] as const) {
      expect(idx, name).toBeGreaterThan(0);
      expect(launchAt, name).toBeLessThan(idx);
    }
  });

  it("★ (C) الانتظار في موضع الحاجة الحاليّ — قبل أول مستهلك", () => {
    expect(awaitAt).toBeGreaterThan(launchAt);
    // ★ `acquireSlot` يقرأ policy.userTier — فالانتظار يجب أن يسبقه
    expect(awaitAt).toBeLessThan(slotAt);
    expect(ROUTE).toContain("acquireSlot(userId, requestId, policy.userTier)");
  });

  it("★ (C′) ولم يتقدّم الانتظار إلى ما قبل رحلة المحادثة", () => {
    // لو تقدّم لضاع التداخل كلّه — وهو الغرض من الرقعة
    expect(awaitAt).toBeGreaterThan(convAt);
  });
});

/* ═════════ (D–E) نداء واحد ونتيجة واحدة ═════════ */

describe("★ (D–E) لا ازدواج", () => {
  it("★ (D) نداء واحد لكل طلب", () => {
    expect((ROUTE.match(/loadModelPolicy\(/g) ?? []).length).toBe(1);
    expect((ROUTE.match(/await modelPolicyPromise/g) ?? []).length).toBe(1);
  });

  it("★ (E) النتيجة تصل كما هي — المراقب الجانبي لا يستبدل الوعد", () => {
    const between = ROUTE.slice(launchAt, awaitAt);
    expect(between).toContain("void modelPolicyPromise.then(markPolicyDone, markPolicyDone);");
    expect(between).not.toMatch(/modelPolicyPromise\s*=\s*modelPolicyPromise\.then/);
    expect(between).not.toContain("structuredClone");
    expect(ROUTE).toContain("const policy = await modelPolicyPromise;");
  });

  it("★ (E′) سِنك القياس هو نفسه المُمرَّر عند الإطلاق", () => {
    expect(ROUTE).toContain("loadModelPolicy(supabase, userId, policyTimings)");
    // ويُقرأ في السجل من المتغيّر نفسه
    expect(ROUTE).toContain("model_policy_primary_ms=${policyTimings.primaryMs}");
  });
});

/* ═════════ (F–G) دلالات الخطأ ═════════ */

describe("★ (F–G) الرفض", () => {
  it("★ (F) حارس الرفض العائم ومراقب القياس على فرع منفصل", () => {
    expect(ROUTE).toContain("void modelPolicyPromise.then(markPolicyDone, markPolicyDone);");
    // ولا يُبتلع على المسار المُنتظَر
    expect(ROUTE).not.toContain("await modelPolicyPromise.catch(");
  });

  it("★ (G) الانتظار يرمي الخطأ الأصليّ بعينه", async () => {
    const boom = new Error("policy failed");
    const p = Promise.reject(boom);
    const markDone = vi.fn();
    void p.then(markDone, markDone); // نفس النمط المستعمل في المسار
    await expect(p).rejects.toBe(boom);
    expect(markDone).toHaveBeenCalledOnce();
  });

  it("★ (G′) الحارس لا يمنع الرمي ولا يبدّل النوع", async () => {
    class PolicyError extends Error {}
    const boom = new PolicyError("x");
    const p = Promise.reject(boom);
    void p.catch(() => undefined);
    await expect(p).rejects.toBeInstanceOf(PolicyError);
  });
});

/* ═════════ (H–I) الترتيب الحسّاس ═════════ */

describe("★ (H–I) ما لم يتغيّر", () => {
  it("★ (H) claim ثم insert", () => {
    const claimAt = ROUTE.indexOf("const claim = await claimRequestDurable(");
    const insertAt = ROUTE.indexOf('.insert({ conversation_id: conversationId, role: "user"');
    expect(claimAt).toBeGreaterThan(0);
    expect(insertAt).toBeGreaterThan(0);
    expect(claimAt).toBeLessThan(insertAt);
  });

  it("★ (I) slot ثم budget، وكلاهما مُنتظَر لا مُطلَق", () => {
    expect(slotAt).toBeLessThan(budgetAt);
    expect(ROUTE).toContain("const slot = await acquireSlot(");
    expect(ROUTE).toContain("const budget = await reserveChatBudget({");
    // لم تُحوَّل أيٌّ منهما إلى وعد مُطلَق
    expect(ROUTE).not.toContain("const slotPromise = acquireSlot(");
    expect(ROUTE).not.toContain("const budgetPromise = reserveChatBudget(");
  });

  it("★ الرصد محفوظ بحقوله", () => {
    for (const f of [
      "model_policy_ms=",
      "model_policy_wait_ms=",
      "model_policy_primary_ms=",
      "model_policy_limits_ms=",
      "rate_limit_ms=",
      "request_parse_ms=",
      "app_before_provider_ms=",
      "pre_provider_other_ms=",
    ]) {
      expect(ROUTE).toContain(f);
    }
  });
});

/* ═════════ (J) التداخل بوعود مُتحكَّم بها ═════════ */

describe("★ (J) التداخل: 350 + 350", () => {
  const MS = 350;
  const trip = (ms: number, v: string) => new Promise<string>((r) => setTimeout(() => r(v), ms));

  it("★ المتسلسل (قبل الرقعة) ⇒ المجموع", async () => {
    const t0 = Date.now();
    await trip(MS, "conv"); // رحلة المحادثة
    await trip(MS, "policy"); // ثم السياسة — تبدأ بعدها
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2 * MS - 30);
  });

  it("★ المتداخل (بعد الرقعة) ⇒ الأطول وحده", async () => {
    const t0 = Date.now();
    const policy = trip(MS, "policy"); // أُطلقت مبكرًا
    const conv = await trip(MS, "conv");
    const p = await policy; // ما تبقّى من انتظارها ≈ 0
    const elapsed = Date.now() - t0;

    expect(conv).toBe("conv");
    expect(p).toBe("policy");
    // ★ التوفير ≈ 350 مل: الأطول لا المجموع
    expect(elapsed).toBeLessThan(2 * MS - 200);
  });

  /** يحاكي ما يفعله المسار: مدةٌ تُلتقط عند الاستقرار، وانتظارٌ عند الوصول */
  const measure = async (policyMs: number, beforeMs: number) => {
    let totalMs = 0;
    const t0 = Date.now();
    const policy = trip(policyMs, "policy");
    const mark = () => {
      totalMs = Date.now() - t0;
    };
    void policy.then(mark, mark);

    await trip(beforeMs, "before");

    const tWait = Date.now();
    await policy;
    return { totalMs, waitMs: Date.now() - tWait };
  };

  it("★ (A) التداخل يغطّي المدة ⇒ الكاملة ≈350 والانتظار <60", async () => {
    const { totalMs, waitMs } = await measure(MS, MS);
    // ★ المدة الكاملة محفوظة رغم التوازي — لا تنكمش
    expect(totalMs).toBeGreaterThanOrEqual(MS - 40);
    expect(totalMs).toBeLessThan(MS + 120);
    // ★ وما دفعه المسار الحرج يقارب الصفر
    expect(waitMs).toBeLessThan(60);
  });

  it("★ (B) سياسة أبطأ من سابقتها ⇒ الانتظار يعكس الباقي الحقيقيّ", async () => {
    const { totalMs, waitMs } = await measure(MS, 100);
    expect(totalMs).toBeGreaterThanOrEqual(MS - 40);
    // ★ بقي ~250 مل فعلًا — والرقم يقولها لا يُخفيها
    expect(waitMs).toBeGreaterThan(150);
    expect(waitMs).toBeLessThan(MS + 60);
    // والمجموع منطقيّ: الانتظار جزء من المدة لا يتجاوزها
    expect(waitMs).toBeLessThanOrEqual(totalMs + 40);
  });

  it("★ (C) الحساب يستعمل الانتظار وحده — لا احتساب مزدوج", () => {
    const sumBlock = ROUTE.slice(
      ROUTE.indexOf("stage.conversationAccessMs +"),
      ROUTE.indexOf("const preProviderOtherMs"),
    );
    // ★ الانتظار داخل المجموع
    expect(sumBlock).toContain("stage.modelPolicyWaitMs");
    // ★ والمدة الكاملة **خارجه** — وإلا حُسب الزمن المتداخل مرتين
    expect(sumBlock).not.toContain("stage.modelPolicyMs");
  });

  it("★ (D) الرقمان منفصلان في المصدر ولكلٍّ مصدره الزمنيّ", () => {
    // المدة تُلتقط عند الاستقرار
    expect(ROUTE).toContain("stage.modelPolicyMs = Date.now() - tPolicyStart;");
    // والانتظار عند نقطة الوصول
    expect(ROUTE).toContain("stage.modelPolicyWaitMs = Date.now() - tPolicyWait;");
    // ولا يُشتقّ أحدهما من الآخر
    expect(ROUTE).not.toContain("stage.modelPolicyMs = stage.modelPolicyWaitMs");
    // وكلاهما في السجل
    expect(ROUTE).toContain("model_policy_ms=${stage.modelPolicyMs}");
    expect(ROUTE).toContain("model_policy_wait_ms=${stage.modelPolicyWaitMs}");
  });

  it("★ التداخل محدود بأول مستهلك — لا يُزاد بلا تغيير ترتيب", () => {
    /**
     * المدى المتاح = ما بين الإطلاق و`acquireSlot`. وبالقياس الحيّ:
     * التحليل (2) + رحلة المحادثة (335) + بحث المشروع (0) ≈ 337 مل.
     * فلا يُتوقَّع توفير أكبر من ذلك مهما بكّرنا الإطلاق.
     */
    expect(launchAt).toBeLessThan(parseAt);
    expect(parseAt).toBeLessThan(convAt);
    expect(convAt).toBeLessThan(awaitAt);
    expect(awaitAt).toBeLessThan(slotAt);
  });
});
