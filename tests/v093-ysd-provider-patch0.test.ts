/**
 * YSD — عقد المزوّد الخامل وسياسة العبور (v0.9.3، الرقعة صفر).
 *
 * ── ما تختبره هذه المجموعة ──
 *
 * أن إضافة مزوّد جديد إلى السجلّ **لم تغيّر شيئًا**. فالرقعة تأسيسية: تُثبّت
 * شكل المزوّد ومعرّفاته وسياسته، ولا تشغّل شيئًا.
 *
 * والتعطيل مزدوج عمدًا — عَلَم بيئة، ونموذج `enabled: false` — فحتى فتحُ
 * العَلَم لا يعرض على المستخدم نموذجًا لا خدمة خلفه.
 *
 * ── والخطر الذي تحرسه ──
 *
 * مزوّدٌ خامل قد يتسلّل إلى القائمة أو إلى الاحتياط أو يسرق `ysd/free`. وكلٌّ
 * من هذه انحدارٌ صامت في الإنتاج، فلكلٍّ حارسه هنا.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  YSDProvider,
  YSD_PROVIDER_ID,
  YSD_ALPHA_MODEL_ID,
} from "@/lib/ai/ysd";
import {
  getConfiguredProviders,
  getFallbackProvider,
  listAvailableModels,
  listModelOptions,
  resolveProviderForModel,
} from "@/lib/ai/registry";
import type { AIProviderAdapter } from "@/lib/ai/types";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { GroqProvider } from "@/lib/ai/groq";

const YSD_SRC = readFileSync("lib/ai/ysd.ts", "utf8");
const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");

const original = process.env.YSD_PROVIDER_ENABLED;
beforeEach(() => {
  delete process.env.YSD_PROVIDER_ENABLED;
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
});

/* ═══════════ (١) مغلق افتراضيًّا ═══════════ */

describe("★ (١) بلا YSD_PROVIDER_ENABLED", () => {
  it("★ المزوّد غير مُهيّأ", () => {
    expect(new YSDProvider().isConfigured()).toBe(false);
  });

  it("★ ولا يظهر في المزوّدين المُهيّئين", () => {
    expect(getConfiguredProviders().some((p) => p.id === YSD_PROVIDER_ID)).toBe(false);
  });

  it("★ ولا يظهر model-alpha في خيارات النماذج", () => {
    expect(listAvailableModels().some((m) => m.id === YSD_ALPHA_MODEL_ID)).toBe(false);
    expect(listModelOptions().some((o) => o.id === YSD_ALPHA_MODEL_ID)).toBe(false);
  });

  it("★ وتوجيه model-alpha يرد null", () => {
    expect(resolveProviderForModel(YSD_ALPHA_MODEL_ID)).toBeNull();
  });

  it("★ أي قيمة غير \"1\" تبقى مغلقة", () => {
    for (const v of ["0", "true", "yes", "", " 1", "1 "]) {
      process.env.YSD_PROVIDER_ENABLED = v;
      expect(new YSDProvider().isConfigured(), v).toBe(false);
    }
  });
});

/* ═══════════ (٢) مع العَلَم مفتوحًا ═══════════ */

describe("★ (٢) مع YSD_PROVIDER_ENABLED=1", () => {
  beforeEach(() => {
    process.env.YSD_PROVIDER_ENABLED = "1";
  });

  it("★ المزوّد مُهيّأ", () => {
    expect(new YSDProvider().isConfigured()).toBe(true);
    expect(getConfiguredProviders().some((p) => p.id === YSD_PROVIDER_ID)).toBe(true);
  });

  it("★ لكن model-alpha يبقى غير قابل للاختيار — الطبقة الثانية", () => {
    const models = new YSDProvider().listModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe(YSD_ALPHA_MODEL_ID);
    expect(models[0]!.enabled).toBe(false);

    // ولا يصل إلى القائمة ولا إلى التوجيه
    expect(listAvailableModels().some((m) => m.id === YSD_ALPHA_MODEL_ID)).toBe(false);
    expect(resolveProviderForModel(YSD_ALPHA_MODEL_ID)).toBeNull();
  });

  it("★ ولا نداء شبكيّ: البثّ يفشل مغلقًا بإطار خطأ مصنَّف", async () => {
    const fetchSpy = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("no network allowed in patch 0");
    }) as typeof fetch;

    try {
      const chunks = [];
      for await (const c of new YSDProvider().streamChat()) chunks.push(c);

      expect(called).toBe(false);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.type).toBe("error");
      expect(chunks[0]!.errorCode).toBe("provider_unavailable");
      expect(chunks[0]!.error).toBe(
        "خدمة الذكاء الاصطناعي غير متاحة الآن. حاول مرة أخرى لاحقًا.",
      );
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });

  it("★ ولا يرمي استثناءً خامًا — مزوّد خامل لا يُسقط طلبًا", async () => {
    await expect(
      (async () => {
        for await (const _ of new YSDProvider().streamChat()) {
          /* يُستهلك */
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it("★ وretrieval JSON يعلن الفشل بلا محاولة", async () => {
    const r = await new YSDProvider().requestJsonCompletion();
    expect(r).toEqual({ ok: false, reason: "error" });
  });
});

/* ═══════════ (٣–٤) سياسة العبور ═══════════ */

describe("★ (٣–٤) fallbackPolicy", () => {
  it("★ (٣) YSD يعلن \"none\"", () => {
    expect(new YSDProvider().fallbackPolicy).toBe("none");
  });

  it("★ (٤) المزوّدون القائمون لا يعلنونها ⇒ سلوكهم الخارجيّ كما هو", () => {
    /**
     * تُقرأ عبر الواجهة لا عبر النوع المحسوس — لأن المُترجم نفسه يرفض
     * قراءتها من `OpenRouterProvider` مباشرةً: الخاصية غائبة عن الصنف.
     * وذلك **إثباتٌ إضافيّ** أنها اختيارية ولم تُفرض على مزوّد قائم.
     */
    const existing: AIProviderAdapter[] = [new OpenRouterProvider(), new GroqProvider()];
    for (const p of existing) {
      expect(p.fallbackPolicy, p.id).toBeUndefined();
    }
    // والشرط في المسار يُختصر إلى ما كان حين تغيب
    expect(undefined !== "none").toBe(true);
  });

  it("★ المسار يقرأ السياسة ولا يفترضها", () => {
    expect(ROUTE).toContain('const crossProviderAllowed = provider.fallbackPolicy !== "none";');
    expect(ROUTE).toContain("crossProviderAllowed && fallbackProvider");
  });

  it("★ ومنطق الاختيار مكافئ للقديم حين تغيب السياسة", () => {
    /**
     * محاكاة الشرط الحقيقيّ: قديمًا `fb && fb.id !== id`، وحديثًا يُضاف
     * `crossProviderAllowed`. فمع سياسة غائبة تتطابق النتيجتان في كل حالة.
     */
    const decide = (policy: "external" | "none" | undefined, fbId: string | null, id: string) => {
      const allowed = policy !== "none";
      return allowed && fbId && fbId !== id ? fbId : null;
    };
    const legacy = (fbId: string | null, id: string) => (fbId && fbId !== id ? fbId : null);

    for (const [fbId, id] of [
      ["groq", "openrouter"],
      ["groq", "groq"],
      [null, "openrouter"],
    ] as const) {
      expect(decide(undefined, fbId, id)).toBe(legacy(fbId, id));
      expect(decide("external", fbId, id)).toBe(legacy(fbId, id));
    }
    // و"none" وحدها تمنع
    expect(decide("none", "groq", "ysd")).toBeNull();
  });
});

/* ═══════════ (٥–٦) لا انحدار في القائم ═══════════ */

describe("★ (٥–٦) المزوّدون القائمون", () => {
  it("★ (٥) Groq يبقى المزوّد الاحتياطيّ — وYSD لا ينافسه", () => {
    // الاحتياط يشترط userSelectable === false، وYSD يعلن true
    expect(new YSDProvider().userSelectable).toBe(true);
    expect(new GroqProvider().userSelectable).toBe(false);

    process.env.YSD_PROVIDER_ENABLED = "1";
    const fb = getFallbackProvider();
    expect(fb?.id).not.toBe(YSD_PROVIDER_ID);
  });

  it("★ (٦) ysd/free ما يزال لـOpenRouter — الاسم لم يُنتزع", () => {
    const or = new OpenRouterProvider();
    const owned = or.listModels().some((m) => m.id === "ysd/free");
    expect(owned).toBe(true);

    // ولا يدّعيه YSD
    process.env.YSD_PROVIDER_ENABLED = "1";
    expect(new YSDProvider().listModels().some((m) => m.id === "ysd/free")).toBe(false);

    /**
     * والتوجيه: لا يُثبَّت على "openrouter" لأن ذلك يعتمد على وجود مفتاحه
     * في بيئة الاختبار — فيصير الحارس هشًّا يقيس البيئة لا الشيفرة. المُثبَت
     * هنا أقوى وأثبت: **لا مزوّد غير OpenRouter يملك هذا المعرّف**.
     */
    const resolved = resolveProviderForModel("ysd/free");
    if (resolved) expect(resolved.id).toBe("openrouter");
    for (const p of [new YSDProvider(), new GroqProvider()]) {
      expect(p.listModels().some((m) => m.id === "ysd/free"), p.id).toBe(false);
    }
  });

  it("★ ومعرّف YSD منفصل عن اسم النموذج المجانيّ", () => {
    expect(YSD_PROVIDER_ID).toBe("ysd");
    expect(YSD_ALPHA_MODEL_ID).toBe("ysd/model-alpha");
    expect(YSD_ALPHA_MODEL_ID).not.toBe("ysd/free");
  });
});

/* ═══════════ (٧–٩) حدود الرقعة ═══════════ */

describe("★ (٧–٩) ما لا تحويه الرقعة", () => {
  it("★ (٧) لا نداء شبكيّ في المصدر إطلاقًا", () => {
    for (const forbidden of ["fetch(", "https://", "http://", "XMLHttpRequest", "axios"]) {
      expect(YSD_SRC, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٩) ولا مفتاح ولا سرّ — عَلَم التفعيل وحده", () => {
    const envRefs = [...YSD_SRC.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(envRefs).toEqual(["YSD_PROVIDER_ENABLED"]);
    for (const bad of ["API_KEY", "SECRET", "TOKEN", "Authorization", "Bearer"]) {
      expect(YSD_SRC, bad).not.toContain(bad);
    }
  });

  it("★ ولا healthCheck يدّعي اتصالًا", () => {
    /**
     * الفحص على الكائن لا على النصّ: الشرح يذكر `healthCheck` ليُفهم سبب
     * غيابه، وحارسٌ يقرأ التعليق كشيفرة يمنع التوثيق لا الانحدار.
     */
    const p = new YSDProvider();
    expect("healthCheck" in p).toBe(false);
    expect(typeof (p as { healthCheck?: unknown }).healthCheck).toBe("undefined");
  });

  it("★ ولا discoverModels — القائمة ثابتة", () => {
    expect("discoverModels" in new YSDProvider()).toBe(false);
  });
});

/* ═══════════ (١٠) التكافؤ مع الأساس ═══════════ */

describe("★ (١٠) العَلَم مغلقًا ⇒ السلوك مكافئ للأساس", () => {
  it("★ قائمة المزوّدين المُهيّئين لا تتضمّن YSD", () => {
    const ids = getConfiguredProviders().map((p) => p.id);
    expect(ids).not.toContain(YSD_PROVIDER_ID);
  });

  it("★ وخيارات النماذج خالية من أي نموذج YSD", () => {
    for (const o of listModelOptions()) {
      expect(o.id.startsWith("ysd/model-")).toBe(false);
    }
  });

  it("★ والاحتياط يبقى كما كان", () => {
    const fb = getFallbackProvider();
    // Groq أو null بحسب البيئة — لكن ليس YSD بحال
    expect(fb?.id).not.toBe(YSD_PROVIDER_ID);
  });

  it("★ وYSD مسجَّل آخر القائمة فلا يغيّر المزوّد الافتراضيّ", () => {
    const REG = readFileSync("lib/ai/registry.ts", "utf8");
    const orAt = REG.indexOf("new OpenRouterProvider()");
    const ysdAt = REG.indexOf("new YSDProvider()");
    expect(orAt).toBeGreaterThan(0);
    expect(ysdAt).toBeGreaterThan(orAt);
  });
});
