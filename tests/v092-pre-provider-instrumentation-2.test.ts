/**
 * تفكيك `pre_provider_other_ms` (v0.9.2، الرقعة الثانية) — **رصدٌ خالص**.
 *
 * ── ما دفع إليها ──
 *
 * الطلب الحيّ: `app_before_provider_ms = 2953` والثابت يتحقّق بالضبط
 * (155+541+806+0+384+129+138+800). فالـ800 ليست ضجيجًا بل **مرحلة حقيقية**
 * لم تُقَس — وأكبر المشتبهين `loadModelPolicy` برحلتيها المتتابعتين.
 *
 * ── وما تفعله ──
 *
 * ثلاثة قياسات جديدة، وتفكيكٌ داخليّ لسياسة النماذج. لا استعلام يتغيّر ولا
 * ترتيب ولا عقد دالة: السِنك اختياريّ، ومن لا يمرّره لا يتغيّر سلوكه بحرف.
 *
 * والحرج هنا **ألّا يُحسب شيء مرتين**: الثلاثة تُضاف إلى المجموع المعروف،
 * فينكمش الباقي بمقدار ما فُسِّر تمامًا — لا أكثر ولا أقلّ.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  emptyModelPolicyTimings,
  loadModelPolicy,
} from "@/lib/ai/model-policy";

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const POLICY = readFileSync("lib/ai/model-policy.ts", "utf8");

/* ───────── عميل مُحاكى: كل رحلة بزمن معلوم ───────── */

/** يبني عميلًا يؤخّر كل استعلام بالمقدار المطلوب */
function fakeSupabase(delays: { sub: number; models: number; limits: number }) {
  const calls: string[] = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const builder = (table: string) => {
    const ms =
      table === "subscriptions" ? delays.sub : table === "ai_models" ? delays.models : delays.limits;
    const chain = {
      select: () => chain,
      eq: () => chain,
      async maybeSingle() {
        await wait(ms);
        return table === "subscriptions"
          ? { data: { tier: "free" }, error: null }
          : { data: { max_output_tokens: 2048 }, error: null };
      },
      // `ai_models` تُنتظَر بلا maybeSingle
      then(resolve: (v: unknown) => void) {
        return wait(ms).then(() => resolve({ data: [], error: null }));
      },
    };
    calls.push(table);
    return chain;
  };

  return { client: { from: builder } as never, calls };
}

/* ══════════ (A–B) تفكيك سياسة النماذج ══════════ */

describe("★ (A–B) قياس مرحلتَي سياسة النماذج", () => {
  it("★ (A) القياس الكلّي يشمل المرحلتين كاملتين", async () => {
    const { client } = fakeSupabase({ sub: 40, models: 40, limits: 40 });
    const t = emptyModelPolicyTimings();

    const t0 = Date.now();
    await loadModelPolicy(client, "u-1", t);
    const total = Date.now() - t0;

    // الأولى متوازية (≈40) والثانية تابعة (≈40) ⇒ الكلّي ≈80 لا 120
    expect(t.primaryMs).toBeGreaterThanOrEqual(30);
    expect(t.limitsMs).toBeGreaterThanOrEqual(30);
    expect(total).toBeGreaterThanOrEqual(t.primaryMs + t.limitsMs - 20);
  });

  it("★ (B) مجموع المرحلتين لا يتجاوز الكلّي", async () => {
    const { client } = fakeSupabase({ sub: 30, models: 30, limits: 30 });
    const t = emptyModelPolicyTimings();

    const t0 = Date.now();
    await loadModelPolicy(client, "u-1", t);
    const total = Date.now() - t0;

    // ★ الجوهر: لا تداخل ولا احتساب مزدوج بين المرحلتين
    expect(t.primaryMs + t.limitsMs).toBeLessThanOrEqual(total + 5);
  });

  it("★ (B′) الرحلة الأولى متوازية فعلًا — لا مجموع الاثنتين", async () => {
    const { client } = fakeSupabase({ sub: 60, models: 60, limits: 1 });
    const t = emptyModelPolicyTimings();
    await loadModelPolicy(client, "u-1", t);
    // ★ الاشتراك والنماذج معًا ⇒ ≈60 لا 120
    expect(t.primaryMs).toBeLessThan(110);
  });
});

/* ══════════ (G) لا سلوك تغيّر ══════════ */

describe("★ (G) ناتج loadModelPolicy لم يتغيّر", () => {
  it("★ بلا سِنك: النتيجة نفسها ولا رمي", async () => {
    const { client } = fakeSupabase({ sub: 1, models: 1, limits: 1 });
    const withSink = await loadModelPolicy(client, "u-1", emptyModelPolicyTimings());
    const withoutSink = await loadModelPolicy(client, "u-1");
    expect(withoutSink).toEqual(withSink);
    expect(withoutSink.userTier).toBe("free");
    expect(withoutSink.maxOutputTokens).toBe(2048);
  });

  it("★ الاستعلامات وترتيبها كما هي", () => {
    // الرحلة الأولى ما تزال Promise.all على الجدولين
    expect(POLICY).toContain("const [subRes, modelsRes] = await Promise.all([");
    expect(POLICY).toContain('supabase.from("subscriptions").select("tier")');
    expect(POLICY).toContain('supabase.from("ai_models").select("id, min_tier, enabled")');
    // والثانية ما تزال تابعة لـuserTier
    expect(POLICY).toContain('.from("usage_limits")');
    expect(POLICY).toContain('.eq("tier", userTier)');
    // والسِنك اختياريّ — لا يكسر مستدعيًا قائمًا
    expect(POLICY).toContain("timings?: ModelPolicyTimings");
  });

  it("★ السِنك لا يُكتب إلا إن مُرِّر — ولا يغيّر مسارًا", () => {
    expect((POLICY.match(/if \(timings\)/g) ?? []).length).toBe(2);
    expect(POLICY).not.toContain("timings.primaryMs +=");
  });
});

/* ══════════ (C–D) موضع القياسين في المسار ══════════ */

describe("★ (C–D) القياسان يحيطان ما يخصّهما وحده", () => {
  it("★ (C) rate_limit_ms يقيس consumeRateLimit فقط", () => {
    const at = ROUTE.indexOf("const rl = await consumeRateLimit(");
    expect(at).toBeGreaterThan(0);
    const before = ROUTE.slice(at - 120, at);
    const after = ROUTE.slice(at, at + 260);
    expect(before).toContain("const tRl = Date.now();");
    expect(after).toContain("stage.rateLimitMs = Date.now() - tRl;");
    // ولا شيء بين المؤقّت والنداء
    expect(before.trim().endsWith("const tRl = Date.now();")).toBe(true);
  });

  it("★ (D) request_parse_ms يقيس req.json + التحقق فقط", () => {
    const at = ROUTE.indexOf("const parsed = chatRequestSchema.safeParse(");
    expect(at).toBeGreaterThan(0);
    const before = ROUTE.slice(at - 120, at);
    const after = ROUTE.slice(at, at + 220);
    expect(before).toContain("const tParse = Date.now();");
    expect(after).toContain("stage.requestParseMs = Date.now() - tParse;");
    expect(before.trim().endsWith("const tParse = Date.now();")).toBe(true);
  });

  it("★ model_policy_ms يحيط النداء وحده", () => {
    const at = ROUTE.indexOf("const policy = await loadModelPolicy(");
    const before = ROUTE.slice(at - 120, at);
    const after = ROUTE.slice(at, at + 220);
    expect(before).toContain("const tPolicy = Date.now();");
    expect(after).toContain("stage.modelPolicyMs = Date.now() - tPolicy;");
  });
});

/* ══════════ (E–F) الثابت الحسابيّ ══════════ */

describe("★ (E–F) المجموع والباقي", () => {
  it("★ (E) الباقي لا يصير سالبًا — مثبَّت بالبناء", () => {
    expect(ROUTE).toContain(
      "const preProviderOtherMs = Math.max(0, appBeforeProviderMs - knownPreProviderMs);",
    );
  });

  it("★ (E′) ولو تجاوز المعروفُ الكلَّ يبقى الباقي صفرًا", () => {
    const clamp = (total: number, known: number) => Math.max(0, total - known);
    expect(clamp(2953, 2953)).toBe(0);
    expect(clamp(100, 250)).toBe(0); // انحراف ساعة/CPU لا يُنتج رقمًا سالبًا
    expect(clamp(2953, 2153)).toBe(800);
  });

  it("★ (F) الحقول الثلاثة داخل المجموع — فينكمش الباقي بمقدارها", () => {
    const sumBlock = ROUTE.slice(
      ROUTE.indexOf("stage.conversationAccessMs +"),
      ROUTE.indexOf("const preProviderOtherMs"),
    );
    for (const f of ["stage.requestParseMs", "stage.rateLimitMs", "stage.modelPolicyMs"]) {
      expect(sumBlock).toContain(f);
    }
    // ★ ولا تفكيك السياسة داخل المجموع — وإلا حُسبت مرتين
    expect(sumBlock).not.toContain("policyTimings.primaryMs");
    expect(sumBlock).not.toContain("policyTimings.limitsMs");
  });

  it("★ (F′) الثابت يتحقّق عدديًّا على الطلب الحيّ المرصود", () => {
    // الأرقام المرصودة قبل هذه الرقعة
    const known = [155, 541, 806, 0, 384, 129, 138, 0];
    const total = 2953;
    const other = total - known.reduce((a, b) => a + b, 0);
    expect(other).toBe(800);

    // وبعدها: لو فُسِّر 500 من الـ800 فالباقي 300 — لا 800 ولا 1300
    const explained = 500;
    expect(total - (known.reduce((a, b) => a + b, 0) + explained)).toBe(300);
  });
});

/* ══════════ الخصوصية ══════════ */

describe("★ الحقول أرقام فقط", () => {
  it("★ لا محتوى ولا بيانات مستخدم في السطر الجديد", () => {
    const at = ROUTE.indexOf("`request_parse_ms=");
    const block = ROUTE.slice(at, at + 500);
    for (const bad of ["message", "userId", "prompt", "content", "email", "token", "fileName"]) {
      expect(block).not.toContain(bad);
    }
  });

  it("★ الحقول الخمسة الجديدة حاضرة في السجل", () => {
    for (const f of [
      "request_parse_ms=",
      "rate_limit_ms=",
      "model_policy_ms=",
      "model_policy_primary_ms=",
      "model_policy_limits_ms=",
    ]) {
      expect(ROUTE).toContain(f);
    }
  });

  it("★ ولا حقل قديم سقط", () => {
    for (const f of [
      "auth_ms=",
      "conversation_access_ms=",
      "project_lookup_ms=",
      "slot_ms=",
      "budget_ms=",
      "settings_ms=",
      "idempotency_claim_ms=",
      "user_message_insert_ms=",
      "context_gather_ms=",
      "source_assembly_ms=",
      "pre_provider_other_ms=",
      "app_before_provider_ms=",
      "rag_total_ms=",
    ]) {
      expect(ROUTE).toContain(f);
    }
  });
});
