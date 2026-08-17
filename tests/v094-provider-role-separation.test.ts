/**
 * فصل **الظهور** عن **أهليّة الاحتياط** (v0.9.3، الرقعة الأولى).
 *
 * ── الخلط الذي فُكّ ──
 *
 * كان السجلّ يختار الاحتياط بـ`userSelectable === false` — أي «كل مخفيّ
 * احتياطٌ». وذلك خلطُ قرارَين مختلفين: الإخفاء قرار **عرض**، والاحتياط قرار
 * **دور**.
 *
 * وأثره خطرٌ صامت لا نظريّ: أيّ مزوّد يُخفى لسببٍ آخر — نموذج المنصّة مثلًا —
 * كان يصير مرشّحًا للاحتياط بلا أن يقصد أحد، فيتلقّى طلبات مزوّد آخر. ولا
 * يظهر ذلك في أي اختبار لأن الشرط «صحيح» شكلًا.
 *
 * ── والخاصيتان تصفان طرفَي العلاقة ──
 *
 *   `fallbackPolicy`   — على الأساسيّ: أيُسمح بالخروج منه؟
 *   `fallbackEligible` — على البديل: أيصلح أصلًا لأن يكون ذلك الغير؟
 *
 * فلا تُشتقّ إحداهما من الأخرى، وهذا ما تحرسه هذه المجموعة.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { AIProviderAdapter, ModelInfo } from "@/lib/ai/types";
import {
  getFallbackProvider,
  isFallbackCandidate,
  listModelOptions,
} from "@/lib/ai/registry";
import { GroqProvider } from "@/lib/ai/groq";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { YSDProvider, YSD_PROVIDER_ID } from "@/lib/ai/ysd";

const original = process.env.YSD_PROVIDER_ENABLED;
beforeEach(() => {
  delete process.env.YSD_PROVIDER_ENABLED;
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
});

/** مزوّد نظريّ بأدنى عقد — لفحص التباديل بلا لمس مزوّد حقيقيّ */
function stub(over: Partial<AIProviderAdapter> & { id: string }): AIProviderAdapter {
  return {
    displayName: over.id,
    isConfigured: () => true,
    listModels: (): ModelInfo[] => [],
    async *streamChat() {
      /* لا يُستعمل */
    },
    ...over,
  } as AIProviderAdapter;
}

/* ═══════════ (١) المفهومان منفصلان ═══════════ */

describe("★ (١) الظهور ≠ الأهليّة", () => {
  it("★ كل التباديل الأربعة: الأهليّة وحدها تحكم", () => {
    const cases = [
      { userSelectable: false, fallbackEligible: true, expected: true },
      { userSelectable: false, fallbackEligible: false, expected: false },
      { userSelectable: true, fallbackEligible: true, expected: true },
      { userSelectable: true, fallbackEligible: false, expected: false },
    ] as const;

    for (const c of cases) {
      const p = stub({
        id: `s-${c.userSelectable}-${c.fallbackEligible}`,
        userSelectable: c.userSelectable,
        fallbackEligible: c.fallbackEligible,
      });
      expect(isFallbackCandidate(p), p.id).toBe(c.expected);
    }
  });

  it("★ (٤) إخفاء مزوّد لا يجعله احتياطًا", () => {
    /**
     * هذا هو العطل المستقبليّ الذي جاءت الرقعة لمنعه: مزوّد يُخفى لسبب
     * لا علاقة له بالاحتياط — فيصير احتياطًا بالخطأ.
     */
    const hidden = stub({ id: "hidden", userSelectable: false });
    expect(hidden.fallbackEligible).toBeUndefined();
    expect(isFallbackCandidate(hidden)).toBe(false);
  });

  it("★ والافتراض آمن: الغياب يعني «لا»", () => {
    expect(isFallbackCandidate(stub({ id: "bare" }))).toBe(false);
    expect(isFallbackCandidate(stub({ id: "explicit-false", fallbackEligible: false }))).toBe(false);
  });

  it("★ والتهيئة شرطٌ ثانٍ لا يُغني عنه الإعلان", () => {
    const declaredButUnconfigured = stub({
      id: "declared",
      fallbackEligible: true,
      isConfigured: () => false,
    });
    expect(declaredButUnconfigured.fallbackEligible).toBe(true);
    expect(isFallbackCandidate(declaredButUnconfigured)).toBe(false);
  });
});

/* ═══════════ (٢–٣) إعلانات المزوّدين الحقيقيين ═══════════ */

describe("★ (٢–٣) من يعلن ماذا", () => {
  it("★ (٢) Groq: مخفيّ ومؤهَّل", () => {
    const g = new GroqProvider();
    expect(g.userSelectable).toBe(false);
    expect(g.fallbackEligible).toBe(true);
  });

  it("★ (٣) YSD: ظاهر وغير مؤهَّل", () => {
    const y = new YSDProvider();
    expect(y.userSelectable).toBe(true);
    expect(y.fallbackEligible).toBe(false);
  });

  it("★ (٩) وسياسة YSD من الرقعة صفر كما هي", () => {
    expect(new YSDProvider().fallbackPolicy).toBe("none");
  });

  it("★ OpenRouter: ظاهر وغير مؤهَّل — الأساسيّ لا البديل", () => {
    const or: AIProviderAdapter = new OpenRouterProvider();
    expect(or.userSelectable).toBeUndefined(); // أي ظاهر
    expect(or.fallbackEligible).toBeUndefined(); // أي غير مرشّح
    expect(isFallbackCandidate(or)).toBe(false);
  });

  it("★ والطرفان مستقلّان على المزوّد الواحد", () => {
    // Groq يصلح بديلًا ولا يعلن سياسة خروج
    const g: AIProviderAdapter = new GroqProvider();
    expect(g.fallbackEligible).toBe(true);
    expect(g.fallbackPolicy).toBeUndefined();

    // وYSD يمنع الخروج منه ولا يصلح بديلًا — الوجهان معًا
    const y = new YSDProvider();
    expect(y.fallbackPolicy).toBe("none");
    expect(y.fallbackEligible).toBe(false);
  });
});

/* ═══════════ (٥–٧) أثر ذلك على السجلّ ═══════════ */

describe("★ (٥–٧) السجلّ", () => {
  it("★ (٦) OpenRouter → Groq ما يزال يعمل", () => {
    const fb = getFallbackProvider();
    // Groq هو المؤهَّل الوحيد؛ ووجوده رهنٌ بمفتاحه في هذه البيئة
    if (fb) {
      expect(fb.id).toBe("groq");
      expect(fb.fallbackEligible).toBe(true);
    } else {
      // بلا مفتاح: لا احتياط — وهو سلوك ما قبل الرقعة نفسه
      expect(new GroqProvider().isConfigured()).toBe(false);
    }
  });

  it("★ (٧) YSD لا يصير احتياطًا حتى مع العَلَم مفتوحًا", () => {
    process.env.YSD_PROVIDER_ENABLED = "1";
    expect(new YSDProvider().isConfigured()).toBe(true);
    expect(isFallbackCandidate(new YSDProvider())).toBe(false);
    expect(getFallbackProvider()?.id).not.toBe(YSD_PROVIDER_ID);
  });

  it("★ (٧′) ولا حتى لو أُخفي لاحقًا — الحماية بالإعلان لا بالعَرَض", () => {
    /**
     * محاكاة الرقعة القادمة: لو احتيج إخفاء YSD من القائمة، فتحته القديمة
     * (`userSelectable === false` ⇒ احتياط) كانت ستجعله يتلقّى طلبات غيره.
     */
    process.env.YSD_PROVIDER_ENABLED = "1";
    const hiddenYsd = stub({
      id: YSD_PROVIDER_ID,
      userSelectable: false,
      fallbackEligible: false,
    });
    expect(isFallbackCandidate(hiddenYsd)).toBe(false);
  });

  it("★ (٥) دلالة الظهور لم تتغيّر", () => {
    process.env.YSD_PROVIDER_ENABLED = "1";
    const options = listModelOptions();
    // Groq مخفيّ فلا تظهر نماذجه
    expect(options.some((o) => o.provider === "groq")).toBe(false);
    // وYSD ظاهر لكن نموذجه معطَّل — فلا يظهر كذلك، ولسببٍ آخر
    expect(options.some((o) => o.id.startsWith("ysd/model-"))).toBe(false);
  });

  it("★ (٨) ysd/free ما يزال لـOpenRouter", () => {
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
    process.env.YSD_PROVIDER_ENABLED = "1";
    expect(new YSDProvider().listModels().some((m) => m.id === "ysd/free")).toBe(false);
  });
});

/* ═══════════ (١٠) ما لم يُمسّ ═══════════ */

describe("★ (١٠) حدود الرقعة", () => {
  it("★ الاحتياط يُشتقّ من الأهليّة لا من الظهور — في المصدر", async () => {
    const { readFileSync } = await import("node:fs");
    const REG = readFileSync("lib/ai/registry.ts", "utf8");
    const CODE = REG.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

    expect(CODE).toContain("providers.find(isFallbackCandidate)");
    expect(CODE).toContain("p.fallbackEligible === true && p.isConfigured()");
    // ★ ولا أثر للمعيار القديم في الشيفرة
    expect(CODE).not.toContain("p.userSelectable === false && p.isConfigured()");
  });

  it("★ والظهور ما يزال يُشتقّ من userSelectable وحده", async () => {
    const { readFileSync } = await import("node:fs");
    const REG = readFileSync("lib/ai/registry.ts", "utf8");
    expect(REG).toContain("getConfiguredProviders().filter((p) => p.userSelectable !== false)");
  });

  it("★ ولا خوارزميات التوجيه ولا صحة المزوّدين مُسّت", async () => {
    const { readFileSync } = await import("node:fs");
    const HEALTH = readFileSync("lib/ai/provider-health.ts", "utf8");
    // الثوابت المعتمدة كما أُقرّت في الرقعات السابقة
    expect(HEALTH).toContain("export const SMART_PROBE_BUDGET_MS = 6_000;");
    expect(HEALTH).toContain("export const DEGRADED_WINDOW_MS = 300_000;");
    expect(HEALTH).toContain("export const FAILURE_WINDOW_MS = 600_000;");
    expect(HEALTH).toContain("export const CONSECUTIVE_FAILURE_THRESHOLD = 2;");
    // ولا تعرف هذه الوحدة شيئًا عن الأهليّة — الفصل بين الطبقات قائم
    expect(HEALTH).not.toContain("fallbackEligible");
  });

  it("★ والمسار لم يحتج تعديلًا: يقرأ getFallbackProvider كما كان", async () => {
    const { readFileSync } = await import("node:fs");
    const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
    expect(ROUTE).toContain("const fallbackProvider = getFallbackProvider();");
    expect(ROUTE).toContain('const crossProviderAllowed = provider.fallbackPolicy !== "none";');
    // ولا يقرأ الأهليّة بنفسه — تلك مسؤولية السجلّ
    expect(ROUTE).not.toContain("fallbackEligible");
  });
});
