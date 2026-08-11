import { beforeEach, describe, expect, it } from "vitest";
import {
  COOLDOWN_MS,
  _resetCooldowns,
  cooldownReason,
  cooldownRemainingMs,
  isCoolingDown,
  markCooldown,
  parseRetryAfterMs,
} from "../lib/ai/model-cooldown";
import { FREE_MODEL_CANDIDATES, FREE_MODEL_CHAIN } from "../lib/ai/free-models";
import { mapOpenRouterError } from "../lib/ai/openrouter";

const M = "google/gemma-4-31b-it:free";
const N = "nvidia/nemotron-3-super-120b-a12b:free";

beforeEach(() => _resetCooldowns());

describe("Retry-After", () => {
  it("429 مع Retry-After بالثواني → يُستخدم بدل الافتراضي", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    const applied = markCooldown(M, "rate_limit", parseRetryAfterMs("30"));
    expect(applied).toBe(30_000);
    expect(applied).not.toBe(COOLDOWN_MS.rate_limit);
  });

  it("429 مع Retry-After كتاريخ HTTP → يُحسب الفارق", () => {
    const now = Date.UTC(2026, 6, 17, 12, 0, 0);
    const at = new Date(now + 45_000).toUTCString();
    expect(parseRetryAfterMs(at, now)).toBeGreaterThan(43_000);
    expect(parseRetryAfterMs(at, now)).toBeLessThanOrEqual(45_000);
  });

  it("429 بلا Retry-After → 15 دقيقة", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(markCooldown(M, "rate_limit", null)).toBe(15 * 60_000);
  });

  it("Retry-After غير صالح أو ماضٍ أو صفر → يقع على الافتراضي", () => {
    for (const bad of ["abc", "", "0", "-5", "Mon, 01 Jan 1990 00:00:00 GMT"]) {
      expect(parseRetryAfterMs(bad)).toBeNull();
    }
  });

  it("Retry-After ضخم يُقصّ عند 6 ساعات (لا نثق بقيمة بلا حد)", () => {
    expect(parseRetryAfterMs("999999999")).toBe(6 * 60 * 60_000);
  });
});

describe("مدد التهدئة حسب نوع الفشل", () => {
  it("404 no_free_model → 6 ساعات (غياب بنيوي لا عابر)", () => {
    expect(markCooldown(M, "no_free_model")).toBe(6 * 60 * 60_000);
    expect(cooldownReason(M)).toBe("no_free_model");
  });

  it("5xx / timeout → دقيقتان", () => {
    expect(markCooldown(M, "provider_error")).toBe(2 * 60_000);
    expect(cooldownReason(M)).toBe("provider_error");
  });

  it("Retry-After لا يُطبَّق إلا على 429", () => {
    // حتى لو مُرّر، غياب المزوّد يبقى 6 ساعات
    expect(markCooldown(M, "no_free_model", 5_000)).toBe(6 * 60 * 60_000);
  });

  it("التهدئة الأطول تفوز — لا يُقصّرها فشل أخف لاحقًا", () => {
    markCooldown(M, "no_free_model"); // 6 ساعات
    markCooldown(M, "provider_error"); // دقيقتان
    expect(cooldownRemainingMs(M)).toBeGreaterThan(5 * 60 * 60_000);
    expect(cooldownReason(M)).toBe("no_free_model");
  });
});

describe("التخطي والعودة", () => {
  it("النموذج المهدّأ يُتخطّى", () => {
    markCooldown(M, "rate_limit");
    expect(isCoolingDown(M)).toBe(true);
    expect(isCoolingDown(N)).toBe(false); // غيره لا يتأثر
  });

  it("يعود تلقائيًا بعد انتهاء المدة — محاولة واحدة جديدة", () => {
    const t0 = Date.now();
    markCooldown(M, "provider_error", null, t0); // دقيقتان
    expect(isCoolingDown(M, t0 + 60_000)).toBe(true);
    expect(isCoolingDown(M, t0 + 121_000)).toBe(false);
    // انتهاء المدة ينظّف السجل فلا يبقى أثر
    expect(cooldownReason(M, t0 + 121_000)).toBeNull();
  });

  it("لا محاولات مكررة: نموذج فشل يبقى متخطًّى طوال المدة", () => {
    const t0 = Date.now();
    markCooldown(M, "rate_limit", null, t0);
    // عشر «طلبات» متتالية خلال المدة — كلها تتخطاه بلا إرسال
    const skipped = Array.from({ length: 10 }, (_, i) => isCoolingDown(M, t0 + i * 60_000));
    expect(skipped.every(Boolean)).toBe(true);
  });

  it("سلسلة كاملة مهدّأة → لا يبقى نموذج صالح", () => {
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "rate_limit");
    expect(FREE_MODEL_CHAIN.filter((m) => !isCoolingDown(m))).toHaveLength(0);
  });

  it("تهدئة نموذج لا تحجب بقية السلسلة", () => {
    markCooldown(FREE_MODEL_CHAIN[0]!, "no_free_model");
    const usable = FREE_MODEL_CHAIN.filter((m) => !isCoolingDown(m));
    expect(usable).toHaveLength(FREE_MODEL_CHAIN.length - 1);
  });
});

describe("تصنيف أخطاء الموفر → سبب التهدئة", () => {
  it("429 → rate_limit", () => {
    expect(mapOpenRouterError(429, "").kind).toBe("rate_limit");
  });

  it("404 → no_free_model", () => {
    expect(mapOpenRouterError(404, "").kind).toBe("no_free_model");
  });

  it("رسالة unavailable for free الصريحة → no_free_model (رُصدت حيًا)", () => {
    expect(mapOpenRouterError(404, "This model is unavailable for free").kind).toBe("no_free_model");
    expect(mapOpenRouterError(400, "unavailable_for_free").kind).toBe("no_free_model");
  });

  it("5xx → overloaded", () => {
    expect(mapOpenRouterError(503, "").kind).toBe("overloaded");
  });

  it("auth/رصيد لا يُصنّفان كعطل نموذج", () => {
    expect(mapOpenRouterError(401, "").kind).toBe("auth");
    expect(mapOpenRouterError(402, "").kind).toBe("insufficient_credit");
  });

  it("كل رسائل المستخدم عربية", () => {
    for (const s of [401, 402, 429, 404, 503, 500]) {
      expect(mapOpenRouterError(s, "").userMessage).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("سلسلة الإنتاج", () => {
  it("لا تحوي الموجّه العشوائي إطلاقًا", () => {
    expect(FREE_MODEL_CHAIN.some((m) => m.includes("openrouter/"))).toBe(false);
    expect(FREE_MODEL_CANDIDATES.some((c) => c.id.includes("openrouter/"))).toBe(false);
  });

  /**
   * الترتيب محفوظ، والسلسلة **ثلاثة** بعد إخراج `gpt-oss-120b:free`.
   *
   * الدليل طلب توليد حيّ من الإنتاج لا فهرسًا: سجلّ Railway 2026-08-11 أعاد
   * status=404 · kind=no_free_model · headers_received=true — أي أن المزوّد
   * نفسه ردّ على مفتاحنا بأن لا نقطة نهاية. (حكمٌ سابق من الفهرس العام كان
   * خاطئًا وأُلغي؛ الفهرس يعرض ما يراه مستعلِمٌ بعينه لا ما هو متاح فعلًا.)
   */
  it("الترتيب: المُختبَران أولًا ثم gpt-oss-20b — وثلاثة لا أربعة", () => {
    expect(FREE_MODEL_CHAIN[0]).toBe("google/gemma-4-31b-it:free");
    expect(FREE_MODEL_CHAIN[1]).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(FREE_MODEL_CHAIN[2]).toBe("openai/gpt-oss-20b:free");
    expect(FREE_MODEL_CHAIN).toHaveLength(3);
    expect(FREE_MODEL_CHAIN).not.toContain("openai/gpt-oss-120b:free");
  });

  it("كل النماذج مجانية (:free)", () => {
    expect(FREE_MODEL_CHAIN.every((m) => m.endsWith(":free"))).toBe(true);
  });

  it("gpt-oss-20b مُفعّل بعد اجتياز اختبار العربية (2026-07-17)", () => {
    expect(FREE_MODEL_CHAIN).toContain("openai/gpt-oss-20b:free");
    // لم يعد مرشحًا معطّلًا
    expect(FREE_MODEL_CANDIDATES.some((c) => c.id === "openai/gpt-oss-20b:free")).toBe(false);
  });

  it("★ ثلاثة مزوّدين مختلفين في السلسلة — لا تركّز على مزوّد واحد", () => {
    // Google AI Studio · Nvidia · Darkbloom — حجب مزوّد لا يُسقط الخدمة
    expect(FREE_MODEL_CHAIN.length).toBeGreaterThanOrEqual(3);
  });
});
