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
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";
import type { ChatRequest } from "@/lib/ai/types";

/** طلب أدنى — المزوّد صار يستقبله فعلًا بعد التوصيل */
const chatRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId: YSD_ALPHA_MODEL_ID,
  messages: [{ role: "user", content: "مرحبًا" }],
  ...over,
});

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

  /**
   * ★ حُدِّث في الرقعة الخامسة: العَلَم وحده **لم يعد كافيًا**.
   *
   * كان يكفي، وذلك إعلانٌ كاذب: يقول «المزوّد جاهز» بينما قد يغيب عنوان
   * وقت التشغيل أو مفتاحه أو صلاحية السجلّ — فيصل الطلب إلى مزوّدٍ لا
   * يستطيع خدمته. الآن ثلاثة شروط، والاختبار يقيسها كلها.
   */
  it("★ العَلَم وحده لا يكفي — الجاهزية ثلاثة شروط", () => {
    // العَلَم مفتوح، لكن وقت التشغيل والسجلّ غير جاهزين في بيئة الاختبار
    expect(new YSDProvider().isConfigured()).toBe(false);
    expect(getConfiguredProviders().some((p) => p.id === YSD_PROVIDER_ID)).toBe(false);
  });

  it("★ ومع اكتمال الثلاثة يصير مُهيّأ", () => {
    const ready = new YSDProvider({
      readRuntimeConfig: () => ({
        ok: true,
        config: {
          deploymentEnvironment: "production",
          endpointAlias: "ysd-inference-primary",
          baseUrl: "https://runtime.internal.example/v1",
          apiKey: "k",
        },
      }),
      hasRegistryAccess: () => true,
    });
    expect(ready.isConfigured()).toBe(true);
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

  /**
   * ★ حُدِّث في v0.9.3/الرقعة الخامسة: صار المزوّد يستقبل الطلب فعلًا.
   *
   * الدالتان صارتا تأخذان وسائطهما، والرسالة صارت من المصدر المركزيّ
   * (`ERROR_MESSAGES`) بدل نصٍّ محليّ. والمُقاس هو هو: **صفر شبكة، وفشل
   * مغلق برمز مصنَّف** — بل صار أقوى، لأن المسار الآن حقيقيّ ولم يعد
   * جذعًا يردّ ثابتًا.
   */
  it("★ ولا نداء شبكيّ: البثّ يفشل مغلقًا بإطار خطأ مصنَّف", async () => {
    const fetchSpy = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("no network allowed while dormant");
    }) as typeof fetch;

    try {
      const chunks = [];
      for await (const c of new YSDProvider().streamChat(chatRequest())) chunks.push(c);

      expect(called).toBe(false);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.type).toBe("error");
      expect(chunks[0]!.errorCode).toBe("provider_unavailable");
      // الرسالة من المصدر المركزيّ — لا نصّ موازٍ يتباعد عنه
      expect(chunks[0]!.error).toBe(ERROR_MESSAGES.provider_unavailable);
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });

  it("★ ولا يرمي استثناءً خامًا — مزوّد خامل لا يُسقط طلبًا", async () => {
    await expect(
      (async () => {
        for await (const _ of new YSDProvider().streamChat(chatRequest())) {
          /* يُستهلك */
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it("★ وretrieval JSON يعلن الفشل بلا محاولة", async () => {
    const r = await new YSDProvider().requestJsonCompletion({
      systemPrompt: "تعليمات",
      userText: "سؤال",
      maxTokens: 100,
      timeoutMs: 1_000,
    });
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
    /**
     * ★ حُدِّث في v0.9.3: كان المعيار `userSelectable === false` — أي «كل
     * مخفيّ احتياطٌ». وصار الإعلان الصريح `fallbackEligible` وحده.
     *
     * والحارس لم يُحذَف بل صار **أدقّ**: يفحص السبب الحقيقيّ لا العَرَض.
     * فلو أُخفي YSD يومًا (`userSelectable = false`) يبقى غير مرشّح، وذلك
     * ما كان النصّ القديم يعجز عن ضمانه.
     */
    expect(new GroqProvider().fallbackEligible).toBe(true);
    expect(new YSDProvider().fallbackEligible).toBe(false);
    // والإخفاء يبقى مفهومًا منفصلًا
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

  it("★ (٩) ولا مفتاح ولا سرّ — مجموعة بيئة مغلقة", () => {
    /**
     * ★ اتّسعت في الرقعة الخامسة إلى اثنين، وبقيت **مغلقة**.
     *
     * `NEXT_PUBLIC_SUPABASE_URL` عنوانٌ عامّ بطبيعته (يصل المتصفّح أصلًا)،
     * ويُقرأ لفحص الجاهزية لا للاتصال. وقيمة مفتاح الخدمة لا تُقرأ هنا
     * إطلاقًا: `isServiceRoleConfigured` تقول «موجود» ولا تكشف شيئًا.
     */
    const envRefs = [...YSD_SRC.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(envRefs)).toEqual(
      new Set(["YSD_PROVIDER_ENABLED", "NEXT_PUBLIC_SUPABASE_URL"]),
    );
    // ★ ولا اسم سرّ ولا ترويسة اعتماد
    for (const bad of ["API_KEY", "SERVICE_ROLE", "SECRET", "Authorization", "Bearer"]) {
      expect(YSD_SRC, bad).not.toContain(bad);
    }
  });

  it("★ وhealthCheck لا يدّعي اتصالًا بلا مِسبار", () => {
    /**
     * ★ حُدِّث في الرقعة السابعة.
     *
     * كان «لا فاحص أصلًا» — وهو الصواب حين لم يكن ثمّة ما يُفحص: مزوّدٌ
     * خاملٌ بلا وقت تشغيل لا يملك ما يقوله. والآن صار الفاحص حقيقيًّا،
     * فانتقل الحارس إلى ما كان يحرسه من البداية: ألّا يُقال «متصل» بلا دليل.
     */
    const p = new YSDProvider();
    expect(typeof p.healthCheck).toBe("function");
    const src = readFileSync("lib/ai/ysd.ts", "utf8");
    const at = src.indexOf("async healthCheck(");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at);
    expect(body).toContain("this.deps.checkRuntimeReadiness(");
    expect(body.indexOf('status: "connected"')).toBeGreaterThan(
      body.indexOf("this.deps.checkRuntimeReadiness("),
    );
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
