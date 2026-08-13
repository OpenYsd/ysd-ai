/**
 * توازي قراءة `usage_limits` (v0.9.2) — **توقيتٌ لا دلالة**.
 *
 * ── القياس الذي دفع إليه ──
 *
 * `model_policy_ms=273` منها `primary=145` و`limits=128`. فرحلة الحدود كانت
 * **تابعة**: تنتظر `userTier` من الأولى ثم تسأل `.eq("tier", userTier)`.
 * ثمنها 128 مل على المسار الحرج لأجل صفٍّ واحد من جدول ثابت صغير.
 *
 * ── ولماذا التكافؤ تامّ لا تقريبيّ ──
 *
 * `tier` **مفتاح أساسيّ** في `usage_limits` (من الترحيل). فصفٌّ واحد لكل
 * طبقة، ولا تكرار ممكن، ولا ترتيب يؤثّر. فجلبُ الجدول كاملًا ثم انتقاء
 * الصفّ محليًّا يُعطي **عين** ما كان يُعطيه الفلتر.
 *
 * ── وما يُحرَس هنا ──
 *
 * أن الناتج مطابق في كل الحالات (طبقات مدفوعة، اشتراك غائب، حدود مفقودة)،
 * وأن الرحلات الثلاث تبدأ معًا، وأن لا رحلة ثانية بقيت بعد معرفة الطبقة.
 */

import { describe, it, expect } from "vitest";

import { loadModelPolicy, emptyModelPolicyTimings } from "@/lib/ai/model-policy";

/* ───────── عميل مُحاكى: يسجّل الجداول وتوقيت بدء كل استعلام ───────── */

interface FakeOpts {
  tier?: string | null;
  /** صفوف الحدود كما تُعيدها القاعدة — `tier` مفتاح أساسيّ */
  limits?: { tier: string; max_output_tokens: unknown }[];
  models?: { id: string; min_tier: string; enabled: boolean }[];
  delays?: { sub?: number; models?: number; limits?: number };
}

function fakeSupabase(opts: FakeOpts = {}) {
  const started: { table: string; at: number }[] = [];
  const counts: Record<string, number> = {};
  const t0 = Date.now();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const d = opts.delays ?? {};

  const from = (table: string) => {
    started.push({ table, at: Date.now() - t0 });
    counts[table] = (counts[table] ?? 0) + 1;

    const ms =
      table === "subscriptions" ? (d.sub ?? 0)
      : table === "ai_models" ? (d.models ?? 0)
      : (d.limits ?? 0);

    const payload = () =>
      table === "subscriptions"
        ? { data: opts.tier === null ? null : { tier: opts.tier ?? "free" }, error: null }
        : table === "ai_models"
          ? { data: opts.models ?? [], error: null }
          : { data: opts.limits ?? [], error: null };

    const chain = {
      select: () => chain,
      eq: () => chain,
      async maybeSingle() {
        await wait(ms);
        return payload();
      },
      // الاستعلام بلا maybeSingle يُنتظَر مباشرةً
      then(res: (v: unknown) => void) {
        return wait(ms).then(() => res(payload()));
      },
    };
    return chain;
  };

  return { client: { from } as never, started, counts };
}

const LIMITS = [
  { tier: "free", max_output_tokens: 1024 },
  { tier: "pro", max_output_tokens: 4096 },
  { tier: "business", max_output_tokens: 8192 },
];

/* ══════════ (A–D) تكافؤ الناتج في كل الحالات ══════════ */

describe("★ (A–D) الناتج مطابق", () => {
  it("★ (A) الطبقة المجانية — نفس الحدّ", async () => {
    const { client } = fakeSupabase({ tier: "free", limits: LIMITS });
    const p = await loadModelPolicy(client, "u-1");
    expect(p.userTier).toBe("free");
    expect(p.maxOutputTokens).toBe(1024);
  });

  it("★ (B) الطبقات المدفوعة — كلٌّ بحدّها، لا افتراض free", async () => {
    for (const [tier, expected] of [
      ["pro", 4096],
      ["business", 8192],
    ] as const) {
      const { client } = fakeSupabase({ tier, limits: LIMITS });
      const p = await loadModelPolicy(client, "u-1");
      expect(p.userTier).toBe(tier);
      // ★ الانتقاء بـuserTier أيًّا كان — وهذا ما يكسره أي تبسيط إلى free
      expect(p.maxOutputTokens).toBe(expected);
    }
  });

  it("★ (C) اشتراك غائب ⇒ free كما كان", async () => {
    const { client } = fakeSupabase({ tier: null, limits: LIMITS });
    const p = await loadModelPolicy(client, "u-1");
    expect(p.userTier).toBe("free");
    expect(p.maxOutputTokens).toBe(1024);
  });

  it("★ (D) حدود مفقودة أو غير صالحة ⇒ نفس الاحتياط القديم", async () => {
    const cases: FakeOpts["limits"][] = [
      [], // الجدول فارغ
      [{ tier: "pro", max_output_tokens: 4096 }], // لا صفّ لطبقة المستخدم
      [{ tier: "free", max_output_tokens: null }], // قيمة فارغة
      [{ tier: "free", max_output_tokens: 0 }], // صفر — مرفوض كما كان
      [{ tier: "free", max_output_tokens: -5 }], // سالب
      [{ tier: "free", max_output_tokens: "1024" }], // نصّ لا رقم
    ];
    const baseline = (await loadModelPolicy(fakeSupabase({ tier: "free", limits: [] }).client, "u"))
      .maxOutputTokens;
    for (const limits of cases) {
      const { client } = fakeSupabase({ tier: "free", limits });
      const p = await loadModelPolicy(client, "u-1");
      expect(p.maxOutputTokens).toBe(baseline);
      expect(p.userTier).toBe("free");
    }
  });

  it("★ (H) صفوف النماذج تمرّ كما هي", async () => {
    const models = [
      { id: "a/b", min_tier: "free", enabled: true },
      { id: "c/d", min_tier: "pro", enabled: false },
    ];
    const { client } = fakeSupabase({ tier: "pro", limits: LIMITS, models });
    const p = await loadModelPolicy(client, "u-1");
    expect(p.models).toEqual(models);
    expect(p.maxOutputTokens).toBe(4096);
  });
});

/* ══════════ (E–G) بنية الرحلات ══════════ */

describe("★ (E–G) ثلاث رحلات متوازية، ولا رابعة", () => {
  it("★ (E) الثلاثة تبدأ قبل انتظار أيٍّ منها", async () => {
    const { client, started } = fakeSupabase({
      tier: "free",
      limits: LIMITS,
      delays: { sub: 60, models: 60, limits: 60 },
    });
    await loadModelPolicy(client, "u-1");

    expect(started.map((s) => s.table).sort()).toEqual([
      "ai_models",
      "subscriptions",
      "usage_limits",
    ]);
    // ★ كلها انطلقت في اللحظة نفسها تقريبًا — لا واحدة تنتظر سابقتها
    const last = Math.max(...started.map((s) => s.at));
    expect(last).toBeLessThan(40);
  });

  it("★ (F) لا رحلة إلى القاعدة بعد معرفة الطبقة", async () => {
    const { client, started } = fakeSupabase({
      tier: "pro",
      limits: LIMITS,
      delays: { sub: 60, models: 1, limits: 1 },
    });
    await loadModelPolicy(client, "u-1");

    // الاشتراك أبطأ الثلاثة؛ فلو بقيت رحلة تابعة لبدأت بعد ~60 مل
    const afterTier = started.filter((s) => s.at >= 45);
    expect(afterTier).toHaveLength(0);
    expect(started).toHaveLength(3);
  });

  it("★ (G) استعلام واحد فقط على usage_limits", async () => {
    const { client, counts } = fakeSupabase({ tier: "free", limits: LIMITS });
    await loadModelPolicy(client, "u-1");
    expect(counts["usage_limits"]).toBe(1);
    expect(counts["subscriptions"]).toBe(1);
    expect(counts["ai_models"]).toBe(1);
  });
});

/* ══════════ (I) المكسب الزمنيّ ══════════ */

describe("★ (I) التوقيت: 150×3", () => {
  it("★ الأطول وحده لا المجموع", async () => {
    const { client } = fakeSupabase({
      tier: "free",
      limits: LIMITS,
      delays: { sub: 150, models: 150, limits: 150 },
    });
    const t = emptyModelPolicyTimings();

    const t0 = Date.now();
    await loadModelPolicy(client, "u-1", t);
    const total = Date.now() - t0;

    // ★ التصميم القديم: 150 (متوازية) + 150 (تابعة) ≈ 300
    // ★ الجديد: الثلاث معًا ≈ 150
    expect(total).toBeLessThan(260);
    expect(t.primaryMs).toBeGreaterThanOrEqual(130);
    // ★ والحدود لم تعد رحلة — انتقاء في الذاكرة
    expect(t.limitsMs).toBeLessThan(20);
  });

  it("★ القياس صادق: limitsMs يقيس الانتقاء لا يُصفَّر بالثابت", async () => {
    const { client } = fakeSupabase({ tier: "free", limits: LIMITS });
    const t = emptyModelPolicyTimings();
    await loadModelPolicy(client, "u-1", t);
    // رقم حقيقيّ مقيس ≥ 0 — لا ثابت مكتوب يدويًّا
    expect(t.limitsMs).toBeGreaterThanOrEqual(0);
    expect(t.limitsMs).toBeLessThan(20);
    expect(t.primaryMs).toBeGreaterThanOrEqual(0);
  });
});

/* ══════════ حرّاس المصدر ══════════ */

describe("★ حرّاس بنيوية", () => {
  it("★ لا فلتر tier على القاعدة، ولا انتظار ثانٍ", async () => {
    const { readFileSync } = await import("node:fs");
    const SRC = readFileSync("lib/ai/model-policy.ts", "utf8");
    /**
     * تُجرَّد التعليقات قبل الفحص: الشرح يذكر السلوك القديم عمدًا ليُفهم
     * سبب التغيير، فحارسٌ يقرأ التعليق كشيفرة يمنع التوثيق لا الانحدار.
     */
    const CODE = SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

    // الجلب بلا فلترة — والانتقاء محليّ
    expect(CODE).toContain('supabase.from("usage_limits").select("tier, max_output_tokens")');
    expect(CODE).not.toContain('.eq("tier", userTier)');
    expect(CODE).toContain(".find((r) => r.tier === userTier)");

    // انتظار واحد فقط في الدالة كلها
    const fn = SRC.slice(SRC.indexOf("export async function loadModelPolicy"));
    expect((fn.match(/await /g) ?? []).length).toBe(1);
  });

  it("★ الاحتياط والدلالات لم تُمسّ", async () => {
    const { readFileSync } = await import("node:fs");
    const SRC = readFileSync("lib/ai/model-policy.ts", "utf8");
    expect(SRC).toContain('(subRes.data?.tier ?? "free") as PlanTier');
    expect(SRC).toContain("typeof raw === \"number\" && raw > 0 ? raw : FALLBACK_MAX_OUTPUT_TOKENS");
  });
});
