import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  CONSECUTIVE_FAILURE_THRESHOLD,
  DEGRADED_MODEL_RATIO,
  DEGRADED_WINDOW_MS,
  FAILURE_WINDOW_MS,
  PROVIDER_LEVEL_FAILURE_CODES,
  SMART_PROBE_BUDGET_MS,
  _resetProviderHealth,
  consecutiveFailures,
  decideProviderRouting,
  degradedRemainingMs,
  isProviderDegraded,
  recordProviderSuccess,
  recordProviderTerminalFailure,
} from "@/lib/ai/provider-health";
import { _resetCooldowns, markCooldown } from "@/lib/ai/model-cooldown";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";

/**
 * التوجيه الذكي — تقليل زمن أول رمز بلا كسر النجاح القائم.
 *
 * الزمن يُمرَّر صراحةً (`now`) في كل دالة، فالاختبارات **حتمية** ولا تنتظر
 * تسعين ثانية حقيقية ولا تعتمد على دقّة الساعة.
 */

const OR = "openrouter";
const GROQ = "groq";
const T0 = 1_000_000;

beforeEach(() => {
  _resetProviderHealth();
  _resetCooldowns();
});
afterEach(() => {
  _resetProviderHealth();
  _resetCooldowns();
});

const route = (now: number, fallback: string | null = GROQ) =>
  decideProviderRouting({ primaryId: OR, fallbackId: fallback, chain: FREE_MODEL_CHAIN, now });

// ════════════════════════════════════════════════════════════
//  آلة الحالة
// ════════════════════════════════════════════════════════════

describe("آلة الحالة", () => {
  it("★ فشل واحد لا يكفي للتدهور", () => {
    recordProviderTerminalFailure(OR, "provider_unavailable", T0);
    expect(consecutiveFailures(OR)).toBe(1);
    expect(isProviderDegraded(OR, T0)).toBe(false);
    expect(route(T0).decision).toBe("healthy");
  });

  it("★ فشلان طرفيان خلال ٦٠ ثانية ⇒ DEGRADED", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "provider_unavailable", T0 + 30_000);
    expect(consecutiveFailures(OR)).toBe(CONSECUTIVE_FAILURE_THRESHOLD);
    expect(isProviderDegraded(OR, T0 + 30_000)).toBe(true);
  });

  it("★ فشلان متباعدان أكثر من النافذة ⇒ لا تدهور", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + FAILURE_WINDOW_MS + 1);
    expect(consecutiveFailures(OR)).toBe(1); // بدأ عدًّا جديدًا
    expect(isProviderDegraded(OR, T0 + FAILURE_WINDOW_MS + 1)).toBe(false);
  });

  it("★ فشل ثم نجاح ⇒ العدّاد يُصفَّر", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    expect(consecutiveFailures(OR)).toBe(1);
    recordProviderSuccess(OR, T0 + 1_000);
    expect(consecutiveFailures(OR)).toBe(0);
  });

  it("★ نجاح أثناء التدهور ⇒ عافية فورية", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    expect(isProviderDegraded(OR, T0 + 1_000)).toBe(true);

    recordProviderSuccess(OR, T0 + 2_000);
    expect(isProviderDegraded(OR, T0 + 2_000)).toBe(false);
    expect(degradedRemainingMs(OR, T0 + 2_000)).toBe(0);
  });

  it("★ الشفاء الذاتي بعد ٩٠ ثانية بلا أي طلب", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    const at = T0 + 1_000;
    expect(isProviderDegraded(OR, at + DEGRADED_WINDOW_MS - 1)).toBe(true);
    expect(isProviderDegraded(OR, at + DEGRADED_WINDOW_MS + 1)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
//  ★ الإثبات المطلوب: degradedUntil لا يتمدّد
// ════════════════════════════════════════════════════════════

describe("★ degradedUntil غير منزلق", () => {
  /**
   * ★ هذا هو الحارس الأهمّ.
   *
   * لو مدّد كل سبرٍ فاشل المدةَ لَبقي OpenRouter محبوسًا في ست ثوانٍ إلى
   * الأبد: يفشل السبر فيمدّد، فلا يحصل على فرصة كاملة أبدًا — حتى لو تعافى
   * وصار يحتاج ثماني ثوانٍ فقط. والنتيجة عكس الغرض: تهجير دائم إلى Groq.
   */
  it("★ إخفاقات سبر متكررة لا تحرّك موعد الشفاء", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    const enteredAt = T0 + 1_000;
    const expectedUntil = enteredAt + DEGRADED_WINDOW_MS;

    // القياس عند الدخول
    expect(degradedRemainingMs(OR, enteredAt)).toBe(DEGRADED_WINDOW_MS);

    // خمسة إخفاقات سبر متتالية على مدى النافذة
    const stamps = [10_000, 25_000, 45_000, 65_000, 85_000].map((d) => enteredAt + d);
    for (const at of stamps) {
      recordProviderTerminalFailure(OR, "provider_unavailable", at);
      // ★ الموعد الأصلي ثابت: المتبقي = ما بقي منه لا نافذة جديدة
      expect(degradedRemainingMs(OR, at)).toBe(expectedUntil - at);
      expect(isProviderDegraded(OR, at)).toBe(true);
    }

    // ★ وبعد التسعين ثانية الأصلية يعود سليمًا رغم كل تلك الإخفاقات
    expect(isProviderDegraded(OR, expectedUntil + 1)).toBe(false);
  });

  it("★ وبعد الشفاء يحصل على الميزانية الكاملة", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    const enteredAt = T0 + 1_000;

    // أثناء التدهور: سبر قصير
    expect(route(enteredAt + 5_000).primaryBudgetMs).toBe(SMART_PROBE_BUDGET_MS);

    // بعد الشفاء: حدود كاملة — فرصة حقيقية لو تعافى وصار أبطأ من ٦ ثوانٍ
    const healed = enteredAt + DEGRADED_WINDOW_MS + 1;
    const r = route(healed);
    expect(r.decision).toBe("healthy");
    expect(r.primaryBudgetMs).toBeUndefined();
  });

  it("★ نجاح السبر ⇒ HEALTHY فورًا لا انتظار للنافذة", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    expect(route(T0 + 2_000).decision).toBe("degraded_probe");

    recordProviderSuccess(OR, T0 + 3_000);
    const r = route(T0 + 3_000);
    expect(r.decision).toBe("healthy");
    expect(r.primaryBudgetMs).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
//  مستوى التسجيل: الطلب لا المحاولة
// ════════════════════════════════════════════════════════════

describe("التسجيل على مستوى الطلب", () => {
  /**
   * ★ طلبٌ فشلت فيه ثلاثة نماذج = فشل مزوّد **واحد**.
   *
   * المسار يستدعي التسجيل مرة لكل مزوّد بعد انتهاء سلسلته، لا داخلها.
   * وهذا الاختبار يقيس العقد نفسه؛ ويليه حارس بنيوي على موضع الاستدعاء.
   */
  it("★ استدعاء واحد لكل طلب ⇒ العدّاد يزيد واحدًا", () => {
    recordProviderTerminalFailure(OR, "provider_unavailable", T0);
    expect(consecutiveFailures(OR)).toBe(1);
    expect(isProviderDegraded(OR, T0)).toBe(false);
  });

  it("★ طلبان طرفيان خلال ٦٠ ثانية ⇒ DEGRADED", () => {
    recordProviderTerminalFailure(OR, "provider_unavailable", T0);
    expect(isProviderDegraded(OR, T0)).toBe(false);
    recordProviderTerminalFailure(OR, "provider_unavailable", T0 + 20_000);
    expect(isProviderDegraded(OR, T0 + 20_000)).toBe(true);
  });

  it("★ حارس بنيوي: التسجيل خارج حلقة النماذج وداخل حلقة المزوّدين", () => {
    const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
    // استدعاء واحد لكل نوع — لا تسجيل داخل حلقة المحاولات
    expect((ROUTE.match(/recordProviderTerminalFailure\(/g) ?? []).length).toBe(1);
    expect((ROUTE.match(/recordProviderSuccess\(/g) ?? []).length).toBe(1);
    // ويقع بعد انتهاء بثّ المزوّد (حيث يُحسم gotText)
    const gotTextIdx = ROUTE.indexOf("const gotText = assistantText.trim().length > 0;");
    const recordIdx = ROUTE.indexOf("recordProviderSuccess(active.id)");
    expect(gotTextIdx).toBeGreaterThan(0);
    expect(recordIdx).toBeGreaterThan(gotTextIdx);
  });
});

// ════════════════════════════════════════════════════════════
//  نسبة التهدئة — إشارة مستقلة
// ════════════════════════════════════════════════════════════

describe("نسبة النماذج المهدّأة", () => {
  it("★ ٢ من ٣ مهدّأة ⇒ DEGRADED ولو كان العدّاد صفرًا", () => {
    markCooldown(FREE_MODEL_CHAIN[0]!, "provider_error", null, T0);
    markCooldown(FREE_MODEL_CHAIN[1]!, "provider_error", null, T0);

    expect(consecutiveFailures(OR)).toBe(0);
    const r = route(T0 + 1_000);
    expect(r.cooledRatio).toBeGreaterThanOrEqual(DEGRADED_MODEL_RATIO);
    expect(r.decision).toBe("degraded_probe");
    expect(r.primaryBudgetMs).toBe(SMART_PROBE_BUDGET_MS);
  });

  it("★ واحد من ٣ مهدّأ ⇒ يبقى صحيًّا", () => {
    markCooldown(FREE_MODEL_CHAIN[0]!, "provider_error", null, T0);
    expect(route(T0 + 1_000).decision).toBe("healthy");
  });

  it("★ انقضاء التهدئة يُعيد الحالة صحية تلقائيًا", () => {
    markCooldown(FREE_MODEL_CHAIN[0]!, "provider_error", null, T0);
    markCooldown(FREE_MODEL_CHAIN[1]!, "provider_error", null, T0);
    expect(route(T0 + 1_000).decision).toBe("degraded_probe");
    // بعد انقضاء الدقيقتين
    expect(route(T0 + 3 * 60_000).decision).toBe("healthy");
  });
});

// ════════════════════════════════════════════════════════════
//  صحة الاحتياط
// ════════════════════════════════════════════════════════════

describe("صحة Groq", () => {
  it("★ Groq متدهور ⇒ OpenRouter يأخذ حدوده كاملة لا ٦ ثوانٍ", () => {
    // OpenRouter متدهور أيضًا
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);
    // وGroq كذلك
    recordProviderTerminalFailure(GROQ, "provider_unavailable", T0);
    recordProviderTerminalFailure(GROQ, "provider_unavailable", T0 + 1_000);

    const r = route(T0 + 2_000);
    // ★ لا نُقصّر الوحيد الموثوق لصالح مزوّد لا نثق به
    expect(r.decision).toBe("healthy");
    expect(r.primaryBudgetMs).toBeUndefined();
    // ويبقى الاحتياط آخر الترتيب — لا نخسر ما كان قائمًا
    expect(r.order).toEqual([OR, GROQ]);
  });

  it("★ Groq غير مُهيّأ ⇒ OpenRouter كامل ووحده", () => {
    recordProviderTerminalFailure(OR, "timeout", T0);
    recordProviderTerminalFailure(OR, "timeout", T0 + 1_000);

    const r = route(T0 + 2_000, null);
    expect(r.decision).toBe("healthy");
    expect(r.primaryBudgetMs).toBeUndefined();
    expect(r.order).toEqual([OR]);
  });

  /**
   * ★ خطأ الطلب لا يُلوّث صحة المزوّد.
   *
   * سياق أطول من الحدّ أو مدخل غير مدعوم يفشل عند الجميع، فلا يقول شيئًا
   * عن صحة أحد. ولو عُدّ فشلًا لَتدهور مزوّد سليم بسبب طلبات المستخدم.
   */
  it("★ أخطاء الطلب لا تُسجَّل ضد أي مزوّد", () => {
    for (const code of ["unknown", "quality_guard", "auth_expired"]) {
      recordProviderTerminalFailure(GROQ, code, T0);
      recordProviderTerminalFailure(GROQ, code, T0 + 1_000);
    }
    expect(consecutiveFailures(GROQ)).toBe(0);
    expect(isProviderDegraded(GROQ, T0 + 1_000)).toBe(false);
  });

  it("★ قائمة أخطاء المزوّد مغلقة وصريحة", () => {
    expect([...PROVIDER_LEVEL_FAILURE_CODES].sort()).toEqual([
      "network_error",
      "provider_unavailable",
      "rate_limit",
      "timeout",
    ]);
  });

  it("★ رمز غائب أو فارغ لا يُسجَّل", () => {
    recordProviderTerminalFailure(OR, null, T0);
    recordProviderTerminalFailure(OR, "", T0);
    expect(consecutiveFailures(OR)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
//  الثابت الأهمّ: لا حالة بصفر مزوّدين
// ════════════════════════════════════════════════════════════

describe("★ لا حالة تُنتج صفر مزوّدين", () => {
  it("★ كل التباديل تُنتج مزوّدًا واحدًا على الأقل", () => {
    const perms = [
      () => {},
      () => {
        recordProviderTerminalFailure(OR, "timeout", T0);
        recordProviderTerminalFailure(OR, "timeout", T0 + 1);
      },
      () => {
        recordProviderTerminalFailure(GROQ, "timeout", T0);
        recordProviderTerminalFailure(GROQ, "timeout", T0 + 1);
      },
      () => {
        for (const id of [OR, GROQ]) {
          recordProviderTerminalFailure(id, "timeout", T0);
          recordProviderTerminalFailure(id, "timeout", T0 + 1);
        }
      },
      () => {
        for (const m of FREE_MODEL_CHAIN) markCooldown(m, "no_free_model", null, T0);
      },
      () => {
        for (const m of FREE_MODEL_CHAIN) markCooldown(m, "no_free_model", null, T0);
        recordProviderTerminalFailure(GROQ, "timeout", T0);
        recordProviderTerminalFailure(GROQ, "timeout", T0 + 1);
      },
    ];

    for (const fb of [GROQ, null]) {
      for (const setup of perms) {
        _resetProviderHealth();
        _resetCooldowns();
        setup();
        const r = route(T0 + 2_000, fb);
        expect(r.order.length).toBeGreaterThanOrEqual(1);
        // ولا يُقصَّر الأساسي إلا حين يكون الاحتياط صالحًا فعلًا
        if (r.primaryBudgetMs !== undefined) {
          expect(r.order.length).toBe(2);
          expect(isProviderDegraded(GROQ, T0 + 2_000)).toBe(false);
        }
      }
    }
  });

  it("★ تخطّي OpenRouter لا يقع إلا والاحتياط صالح", () => {
    for (const m of FREE_MODEL_CHAIN) markCooldown(m, "no_free_model", null, T0);
    // بوابة السبر مفتوحة ⇒ لا تخطٍّ (OpenRouter قد يسبر)
    const open = route(T0 + 1_000);
    expect(open.decision).not.toBe("skip_openrouter");

    // وحين يتدهور Groq مع تهدئة الجميع ⇒ لا تخطٍّ أيضًا
    recordProviderTerminalFailure(GROQ, "timeout", T0);
    recordProviderTerminalFailure(GROQ, "timeout", T0 + 1);
    const r = route(T0 + 2_000);
    expect(r.order).toContain(OR);
    expect(r.primaryBudgetMs).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
//  عدم الانحدار
// ════════════════════════════════════════════════════════════

describe("عدم الانحدار", () => {
  it("★ الحالة الصحية تُنتج السلوك السابق حرفيًا", () => {
    const r = route(T0);
    expect(r.decision).toBe("healthy");
    expect(r.order).toEqual([OR, GROQ]);
    expect(r.primaryBudgetMs).toBeUndefined(); // حدود كاملة
  });

  it("★ الحدود والثوابت لم تُمسّ", () => {
    const OPENROUTER = readFileSync("lib/ai/openrouter.ts", "utf8");
    const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
    expect(OPENROUTER).toContain("export const FIRST_BYTE_TIMEOUT_MS = 20_000;");
    expect(OPENROUTER).toContain("export const PROVIDER_TIMEOUT_MS = 25_000;");
    expect(OPENROUTER).toContain("export const CHAIN_BUDGET_MS = 45_000;");
    expect(ROUTE).toContain("const TOTAL_REQUEST_BUDGET_MS = 110_000;");
    expect(ROUTE).toContain("const PROVIDER_FALLBACK_BUDGET_MS = 65_000;");
  });

  it("★ القيم المعتمدة كما أُقرّت", () => {
    expect(SMART_PROBE_BUDGET_MS).toBe(6_000);
    expect(DEGRADED_WINDOW_MS).toBe(90_000);
    expect(FAILURE_WINDOW_MS).toBe(60_000);
    expect(CONSECUTIVE_FAILURE_THRESHOLD).toBe(2);
    expect(DEGRADED_MODEL_RATIO).toBeCloseTo(2 / 3, 10);
  });

  it("★ السجل يحمل القرار بلا أي بيانات مستخدم", () => {
    const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
    const line = ROUTE.slice(
      ROUTE.indexOf("routing_decision=${routing.decision}") - 200,
      ROUTE.indexOf("routing_decision=${routing.decision}") + 300,
    );
    expect(line).toContain("provider_order=");
    expect(line).toContain("cooled_ratio=");
    for (const bad of ["userText", "assistantText", "message", "prompt"]) {
      expect(line).not.toContain(bad);
    }
  });

  it("★ الحالة لا تحمل أي محتوى — أرقام ورموز فقط", () => {
    const SRC = readFileSync("lib/ai/provider-health.ts", "utf8");
    for (const bad of ["messages", "prompt", "userId", "content", "assistantText"]) {
      expect(SRC).not.toContain(bad);
    }
  });
});
