/**
 * حدّ تفويض الجهاز — **يُنفَّذ لا يُقرأ** (v0.9.14، المرحلة 6C).
 *
 * ── لماذا ملفٌّ مستقلّ ──
 *
 * كشفت طفرةٌ أن الحارس النصّي لا يكفي هنا: لفَفتُ نداء الحدّ في دالّةٍ ميتة
 * وأبقيتُ `const rate = { allowed: true }` — فبقي اسم الدالّة في الملفّ،
 * ومرّ حارسٌ يبحث عن الاسم. أي أن التفتيش يُثبت أن نداءً **مكتوب**، لا أن
 * قرارَه **يُنفَّذ**.
 *
 * فيُدار المسار هنا فعلًا: يُمنَح ويُمنَع، ويُقاس ما يردّه في الحالتين.
 *
 * ── ولا شبكة ولا قاعدة ──
 *
 * الحدّ والمخزن مُموَّهان. والمقيس سلوكُ المسار لا سلوكُ Supabase.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  allowed: true,
  calls: [] as { bucket: string; value: string; limit: number; window: number }[],
  created: 0,
};

vi.mock("@/lib/rate-limit-keyed", () => ({
  consumeKeyedRate: async (
    bucket: string,
    value: string,
    limit: number,
    window: number,
  ) => {
    state.calls.push({ bucket, value, limit, window });
    return { allowed: state.allowed, backend: "distributed" as const };
  },
}));

vi.mock("@/lib/browser/device-store", () => ({
  createDeviceAuthorization: async () => {
    state.created += 1;
    return {
      deviceCode: "device-code-value",
      record: {
        userCode: "ABCD-EFGH",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      storage: "memory" as const,
    };
  },
}));

const { POST } = await import("../app/api/browser/v1/auth/device/route");
const { BROWSER_CLIENT_ID } = await import("../lib/browser/schema");

/** جسمٌ صالح بحسب المخطّط الحقيقيّ — لا نسخةٌ منه تنحرف عنه */
function validBody() {
  return {
    client_id: BROWSER_CLIENT_ID,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256" as const,
    state: "s".repeat(16),
  };
}

function request(ip: string) {
  return new Request("https://ysd.test/api/browser/v1/auth/device", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(validBody()),
  }) as never;
}

beforeEach(() => {
  state.allowed = true;
  state.calls = [];
  state.created = 0;
});

describe("★ حدّ تفويض الجهاز — مسارٌ عامّ يكتب حالة", () => {
  it("★ ★ ★ تحت الحدّ ⇒ يمرّ ويُنشئ التفويض", async () => {
    const res = await POST(request("203.0.113.9"));
    expect(res.status).toBe(200);
    expect(state.created).toBe(1);
    const body = (await res.json()) as { user_code?: string };
    expect(body.user_code).toBe("ABCD-EFGH");
  });

  it("★ ★ ★ وفوق الحدّ ⇒ 429 و**لا يُنشأ شيء**", async () => {
    /**
     * ★ هذا ما لم يكن الحارس النصّي يراه.
     *
     * نداءٌ مكتوبٌ يُهمَل قراره يترك المسار مفتوحًا كما كان — والفرق لا يظهر
     * إلا حين يُدار المسار ويُقاس ما يفعله.
     */
    state.allowed = false;
    const res = await POST(request("203.0.113.9"));
    expect(res.status).toBe(429);
    expect(state.created).toBe(0);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("rate_limited");
  });

  it("★ ★ ★ ويحمل الردُّ `Retry-After`", async () => {
    state.allowed = false;
    const res = await POST(request("203.0.113.9"));
    const retry = res.headers.get("Retry-After");
    expect(retry).not.toBeNull();
    expect(Number(retry)).toBeGreaterThan(0);
  });

  it("★ ★ ★ والحدّ يُستهلك **قبل** أي عمل", async () => {
    /** استهلاكٌ بعد الإنشاء يعني أن كل طلبٍ مرفوض كتب صفًّا قبل رفضه */
    state.allowed = false;
    await POST(request("203.0.113.9"));
    expect(state.calls).toHaveLength(1);
    expect(state.created).toBe(0);
  });

  it("★ ★ ★ والمفتاح عنوانُ العميل لا شيءٌ يختاره", async () => {
    /**
     * ★ `client_id` يكتبه من ينادي.
     *
     * ومفتاحٌ مبنيّ عليه يجعل المهاجم يختار دلوَه بنفسه — أي لا حدّ.
     */
    await POST(request("203.0.113.9"));
    const call = state.calls[0]!;
    expect(call.value).toBe("203.0.113.9");
    expect(call.value).not.toContain(BROWSER_CLIENT_ID);
    expect(call.bucket).toMatch(/^[a-z][a-z0-9_-]{2,31}$/);
    expect(call.limit).toBeGreaterThan(0);
    expect(call.limit).toBeLessThanOrEqual(60);
    expect(call.window).toBeGreaterThanOrEqual(60);
  });

  it("★ ★ ★ وعنوانان ⇒ دلوان منفصلان", async () => {
    await POST(request("203.0.113.9"));
    await POST(request("198.51.100.4"));
    expect(state.calls.map((c) => c.value)).toEqual(["203.0.113.9", "198.51.100.4"]);
  });

  it("★ ★ ★ ولا يُصدَّق `x-forwarded-for` حين تُكتب `x-real-ip`", async () => {
    /**
     * `x-forwarded-for` تُلحَق لا تُستبدل، فيسارُها بيد العميل. والوكيل
     * يكتب `x-real-ip` ويستبدلها — فهي المصدر متى وُجدت.
     */
    const req = new Request("https://ysd.test/api/browser/v1/auth/device", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4, 203.0.113.9",
        "x-real-ip": "203.0.113.9",
      },
      body: JSON.stringify(validBody()),
    }) as never;
    await POST(req);
    expect(state.calls[0]!.value).toBe("203.0.113.9");
  });

  it("★ ★ محاولاتٌ متتابعة تُستهلك واحدةً واحدة", async () => {
    for (let i = 0; i < 4; i += 1) await POST(request("203.0.113.9"));
    expect(state.calls).toHaveLength(4);
    for (const c of state.calls) expect(c.value).toBe("203.0.113.9");
  });
});
