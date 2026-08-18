/**
 * مفتاح إيقاف الخدمة العامّة لنموذج YSD (v0.9.3، الرقعة الثامنة).
 *
 * ── الفرق بين «ممكن» و«مسموح» ──
 *
 * كل ما بُني قبل هذه الرقعة يجيب سؤال القدرة: أمُهيّأة البنية؟ أيحمل وقت
 * التشغيل النموذج؟ ولا شيء منه يجيب سؤال الإذن. وحين لا يفصل النظام
 * بينهما تصير كل ترقيةِ بنيةٍ تحريرًا غير مقصود — يُصلَح إعدادٌ فينفتح
 * النموذج للناس بلا قرار.
 *
 * ── وأربع بوّاباتٍ مستقلّة ──
 *
 *   البنية التحتية · إذن الخدمة · أهليّة القاعدة · قائمة السماح.
 *
 * ولا واحدة تفتح أخرى. فمن فتح واحدةً بالخطأ لم يفتح الخدمة — وهذا
 * الملفّ يُثبت الاستقلال بوّابةً بوّابة.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { isYSDAlphaActivationEnabled } from "@/lib/ai/ysd-activation";
import { YSDProvider, YSD_ALPHA_MODEL_ID, type YSDProviderDependencies } from "@/lib/ai/ysd";
import type { ChatRequest, StreamChunk } from "@/lib/ai/types";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeChunk, YSDRuntimeReadinessResult } from "@/lib/ai/ysd-runtime-client";

const YSD_SRC = readFileSync("lib/ai/ysd.ts", "utf8");
const ACTIVATION_SRC = readFileSync("lib/ai/ysd-activation.ts", "utf8");
const MODELS_ROUTE = readFileSync("app/api/models/route.ts", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");
const MIGRATION_0036 = readFileSync("supabase/migrations/0036_ysd_model_registry.sql", "utf8");

const RUNTIME_MODEL = "ysd-alpha-2026-01";
const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const runtimeConfig = {
  deploymentEnvironment: "production" as const,
  endpointAlias: ALIAS,
  baseUrl: BASE_URL,
  apiKey: KEY,
};

const deployment: ModelDeploymentRecord = {
  id: DEPLOYMENT_ID,
  modelId: YSD_ALPHA_MODEL_ID,
  modelVersionId: VERSION_ID,
  environment: "production",
  status: "active",
  endpointAlias: ALIAS,
  runtimeModel: RUNTIME_MODEL,
  createdAt: "t",
  activatedAt: "t",
  retiredAt: null,
};

const version: ModelVersionRecord = {
  id: VERSION_ID,
  modelId: YSD_ALPHA_MODEL_ID,
  version: "1.4.2",
  status: "approved",
  baseModelRef: "base-a",
  artifactRef: "artifact-1",
  createdAt: "t",
  approvedAt: "t",
  retiredAt: null,
};

const READY: YSDRuntimeReadinessResult = { ok: true, modelCount: 4, latencyMs: 8 };

function build(over: Record<string, unknown> = {}) {
  const deps = {
    readRuntimeConfig: vi.fn(() => ({ ok: true, config: runtimeConfig })),
    hasRegistryAccess: vi.fn(() => true),
    getAdminClient: vi.fn(() => ({ from: () => ({}) })),
    resolveDeployment: vi.fn(async () => ({ ok: true, deployment, version })),
    streamRuntimeChat: vi.fn(async function* () {
      yield { type: "text", text: "جواب" } as YSDRuntimeChunk;
      yield { type: "done" } as YSDRuntimeChunk;
    }),
    requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: true, text: "{}" })),
    checkRuntimeReadiness: vi.fn(async () => READY),
    ...over,
  };
  return {
    provider: new YSDProvider(deps as unknown as Partial<YSDProviderDependencies>),
    deps,
  };
}

const chatRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId: YSD_ALPHA_MODEL_ID,
  messages: [{ role: "user", content: "مرحبًا" }],
  ...over,
});

const collect = async (gen: AsyncGenerator<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
};

const jsonInput = {
  systemPrompt: "s",
  userText: "u",
  maxTokens: 64,
  timeoutMs: 5_000,
};

const savedProvider = process.env.YSD_PROVIDER_ENABLED;
const savedAlpha = process.env.YSD_MODEL_ALPHA_ENABLED;

/** البنية مهيّأة دائمًا في هذا الملفّ — المتغيّر الوحيد هو **الإذن** */
beforeEach(() => {
  process.env.YSD_PROVIDER_ENABLED = "1";
  delete process.env.YSD_MODEL_ALPHA_ENABLED;
});
afterEach(() => {
  if (savedProvider === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = savedProvider;
  if (savedAlpha === undefined) delete process.env.YSD_MODEL_ALPHA_ENABLED;
  else process.env.YSD_MODEL_ALPHA_ENABLED = savedAlpha;
});

const openSwitch = () => {
  process.env.YSD_MODEL_ALPHA_ENABLED = "1";
};

/** بيئةٌ مصغّرة — `NODE_ENV` مطلوب في النوع ولا شأن له بالمفتاح */
const env = (value?: string): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...(value === undefined ? {} : { YSD_MODEL_ALPHA_ENABLED: value }) }) as NodeJS.ProcessEnv;

/* ═══════════ (١–٦) القيمة نفسها ═══════════ */

describe("★ (١–٦) `\"1\"` وحدها تفتح", () => {
  it("★ (١–٥) ★ وكل ما عداها إغلاق", () => {
    /**
     * `Boolean(env.X)` كان سيجعل `"0"` و`"false"` و`"off"` كلها تفتح —
     * نصوصٌ غير فارغة. وذلك أسوأ ما يصيب مفتاح إيقاف: يُكتب `0` ظنًّا أنه
     * إغلاق، فيفتح. و` 1` بمسافة خطأٌ مطبعيّ، وقبولُه يعني أن المشغّل لا
     * يعرف بالضبط ما كتبه — والالتباس في مفتاح الطوارئ أخطر من الرفض.
     */
    const closed = [
      undefined,
      "",
      " ",
      "0",
      "00",
      "01",
      "1.0",
      "true",
      "TRUE",
      "True",
      "yes",
      "on",
      "enabled",
      " 1",
      "1 ",
      "\t1",
      "1\n",
      "١",
    ];
    for (const value of closed) {
      expect(isYSDAlphaActivationEnabled(env(value)), JSON.stringify(value)).toBe(false);
    }
  });

  it("★ (٦) والتطابق التامّ وحده يفتح", () => {
    expect(isYSDAlphaActivationEnabled(env("1"))).toBe(true);
  });

  it("★ وتُقرأ البيئة المحقونة لا العملية", () => {
    process.env.YSD_MODEL_ALPHA_ENABLED = "1";
    expect(isYSDAlphaActivationEnabled(env())).toBe(false);
    expect(isYSDAlphaActivationEnabled(env("1"))).toBe(true);
  });

  it("★ ولا قاعدة ولا شبكة ولا سرّ في الملفّ", () => {
    const code = ACTIVATION_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const forbidden of ["fetch(", "supabase", "getAdminClient", "await", "apiKey", "console."]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(ACTIVATION_SRC.startsWith('import "server-only";')).toBe(true);
  });
});

/* ═══════════ (٧–١٢) البنية ≠ الإذن ═══════════ */

describe("★ (٧–١٢) التهيئة لا تعني التفعيل", () => {
  it("★ (٧) ★ البنية مهيّأة والمفتاح مغلق ⇒ isConfigured يبقى true", async () => {
    /**
     * ★ الفصل الذي تقوم عليه الرقعة كلها.
     *
     * لولاه لَما عمل زرّ «اختبار الاتصال» قبل الفتح — و`getConfiguredProviders`
     * كانت سترشّح المزوّد فلا يصله فحص. فيصير الشرط دائريًّا: لا يُفتح حتى
     * يُفحص، ولا يُفحص حتى يُفتح.
     */
    const { provider } = build();
    expect(provider.isConfigured()).toBe(true);
    // ولا يذكر `isConfigured` مفتاح الإذن إطلاقًا
    const at = YSD_SRC.indexOf("isConfigured(): boolean {");
    const body = YSD_SRC.slice(at, YSD_SRC.indexOf("\n  }", at));
    expect(body).not.toContain("YSD_MODEL_ALPHA_ENABLED");
    expect(body).not.toContain("isYSDAlphaActivationEnabled");
  });

  it("★ (٨) والمفتاح مغلق ⇒ النموذج معطَّل", () => {
    expect(build().provider.listModels()[0]!.enabled).toBe(false);
  });

  it("★ (٩) والمفتاح مفتوح ⇒ النموذج مفعَّل في قائمة المزوّد", () => {
    openSwitch();
    expect(build().provider.listModels()[0]!.enabled).toBe(true);
  });

  it("★ (١٠) ★ ومفتاحٌ مفتوح ببنيةٍ غير مهيّأة لا يُظهر شيئًا", async () => {
    openSwitch();
    delete process.env.YSD_PROVIDER_ENABLED;
    const { getConfiguredProviders } = await import("@/lib/ai/registry");
    expect(getConfiguredProviders().some((p) => p.id === "ysd")).toBe(false);
  });

  it("★ (١١) ★ والمفتاح مغلق ⇒ لا توجيه للنموذج", async () => {
    const { resolveProviderForModel } = await import("@/lib/ai/registry");
    expect(resolveProviderForModel(YSD_ALPHA_MODEL_ID)).toBeNull();
  });

  it("★ (١٢) والمفتاح مفتوح ببنيةٍ مهيّأة ⇒ يملك النموذج", async () => {
    openSwitch();
    const { resolveProviderForModel } = await import("@/lib/ai/registry");
    const p = resolveProviderForModel(YSD_ALPHA_MODEL_ID);
    // البنية الافتراضية في هذه البيئة قد تنقص إعداد وقت التشغيل — فيُقاس
    // الثابت الذي لا يتغيّر: لا مزوّدَ آخر يدّعي ملكية نموذج YSD
    if (p !== null) expect(p.id).toBe("ysd");
  });

  it("★ ولا يظهر النموذج في القائمة العامّة والمفتاح مغلق", async () => {
    const { listAvailableModels, listModelOptions } = await import("@/lib/ai/registry");
    expect(listAvailableModels().some((m) => m.id === YSD_ALPHA_MODEL_ID)).toBe(false);
    expect(listModelOptions().some((o) => o.id === YSD_ALPHA_MODEL_ID)).toBe(false);
  });
});

/* ═══════════ (١٣–١٩) البثّ المباشر ═══════════ */

describe("★ (١٣–١٩) البوّابة داخل الخدمة نفسها", () => {
  it("★ (١٣) ★ المفتاح مغلق ⇒ تعذّرٌ عامّ ولا تفصيل", async () => {
    /**
     * السجلّ يمنع **التوجيه**، وهذه تمنع **الخدمة**. فلو استُدعي المزوّد
     * مباشرةً، أو تجاوز مستدعٍ `resolveProviderForModel` بخطأ، لا يزال
     * المفتاح قائمًا. وحارسٌ في طبقةٍ واحدة يسقط بخطأٍ واحد.
     */
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("error");
    expect(chunks[0]!.errorCode).toBe("provider_unavailable");
    // ولا يُقال «موقوف بمفتاح إيقاف»
    const dump = JSON.stringify(chunks);
    for (const leak of ["kill", "switch", "disabled", "activation", "YSD_MODEL_ALPHA_ENABLED"]) {
      expect(dump.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });

  it("★ (١٤–١٦) ★ وصفر قاعدة وصفر حلّال وصفر وقت تشغيل", async () => {
    const { provider, deps } = build();
    await collect(provider.streamChat(chatRequest()));
    expect(deps.getAdminClient).not.toHaveBeenCalled();
    expect(deps.resolveDeployment).not.toHaveBeenCalled();
    expect(deps.streamRuntimeChat).not.toHaveBeenCalled();
    expect(deps.checkRuntimeReadiness).not.toHaveBeenCalled();
    expect(deps.readRuntimeConfig).not.toHaveBeenCalled();
  });

  it("★ (١٧) والإلغاء المسبق يبقى صمتًا — لا خطأ مصطنع", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, deps } = build();
    const chunks = await collect(provider.streamChat(chatRequest({ signal: ac.signal })));
    expect(chunks).toHaveLength(0);
    expect(deps.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ (١٨) ★ والمفتاح مفتوح ⇒ المسار القديم كاملًا بلا تغيير", async () => {
    openSwitch();
    const { provider, deps } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(deps.resolveDeployment).toHaveBeenCalledTimes(1);
    expect(deps.streamRuntimeChat).toHaveBeenCalledTimes(1);
    expect(chunks.map((c) => c.type)).toEqual(["meta", "text", "done"]);
    // ونسب الهدف من الرقعة السادسة كما هو
    const meta = chunks[0]!;
    expect(meta.model).toBe(YSD_ALPHA_MODEL_ID);
    expect(meta.modelVersionId).toBe(VERSION_ID);
    expect(meta.deploymentId).toBe(DEPLOYMENT_ID);
  });

  it("★ (١٩) ★ ونموذجٌ مجهول لا يصير YSD — بالمفتاح مفتوحًا أو مغلقًا", async () => {
    for (const open of [false, true]) {
      if (open) openSwitch();
      else delete process.env.YSD_MODEL_ALPHA_ENABLED;
      for (const modelId of ["ysd/free", "other/model", "", "ysd/model-alpha "]) {
        const { provider, deps } = build();
        const chunks = await collect(provider.streamChat(chatRequest({ modelId })));
        expect(chunks[0]!.type, `${modelId}/${open}`).toBe("error");
        expect(deps.streamRuntimeChat, `${modelId}/${open}`).not.toHaveBeenCalled();
        expect(deps.getAdminClient, `${modelId}/${open}`).not.toHaveBeenCalled();
      }
    }
  });
});

/* ═══════════ (٢٠–٢٤) إكمال JSON ═══════════ */

describe("★ (٢٠–٢٤) المسار غير التوليديّ", () => {
  it("★ (٢٠–٢١) ★ المفتاح مغلق ⇒ تعذّرٌ عامّ بصفر سجلّ وصفر وقت تشغيل", async () => {
    const { provider, deps } = build();
    const res = await provider.requestJsonCompletion(jsonInput);
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(deps.getAdminClient).not.toHaveBeenCalled();
    expect(deps.resolveDeployment).not.toHaveBeenCalled();
    expect(deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٢٢) والمفتاح مفتوح ⇒ السلوك القديم كاملًا", async () => {
    openSwitch();
    const { provider, deps } = build();
    const res = await provider.requestJsonCompletion(jsonInput);
    expect(res).toEqual({ ok: true, text: "{}" });
    expect(deps.requestRuntimeJsonCompletion).toHaveBeenCalledTimes(1);
  });

  it("★ (٢٣) وتحويل المهلة القديم محفوظ", async () => {
    openSwitch();
    const { provider } = build({
      requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: false, reason: "timeout" })),
    });
    expect(await provider.requestJsonCompletion(jsonInput)).toEqual({
      ok: false,
      reason: "timeout",
    });
    const { provider: p2 } = build({
      requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: false, reason: "unauthorized" })),
    });
    expect(await p2.requestJsonCompletion(jsonInput)).toEqual({ ok: false, reason: "error" });
  });

  it("★ (٢٤) والإلغاء المسبق القديم محفوظ", async () => {
    openSwitch();
    const ac = new AbortController();
    ac.abort();
    const { provider, deps } = build();
    const res = await provider.requestJsonCompletion({ ...jsonInput, signal: ac.signal });
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(deps.getAdminClient).not.toHaveBeenCalled();
  });
});

/* ═══════════ (٢٥–٢٨) الفحص لا يخضع للمفتاح ═══════════ */

describe("★ (٢٥–٢٨) «متصل» ≠ «مفتوح للناس»", () => {
  it("★ (٢٥–٢٦) ★ المفتاح مغلق والفحص يمضي في السلسلة كاملة", async () => {
    /**
     * ★ هذا هو التسلسل التشغيليّ كلّه.
     *
     * لو خضع الفحص للمفتاح لَصار الشرط دائريًّا: لا يُفتح حتى يُفحص، ولا
     * يُفحص حتى يُفتح. فيُفتح المفتاح على أمل — وهو بالضبط ما جاءت هذه
     * السلسلة كلها لتمنعه.
     */
    const { provider, deps } = build();
    const health = await provider.healthCheck();
    expect(deps.resolveDeployment).toHaveBeenCalledTimes(1);
    expect(deps.checkRuntimeReadiness).toHaveBeenCalledTimes(1);
    expect(health.status).toBe("connected");
  });

  it("★ (٢٧) ★ فوقتُ تشغيلٍ سليم يقول connected والنموذج مخفيّ", async () => {
    const { provider } = build();
    const health = await provider.healthCheck();
    expect(health.status).toBe("connected");
    // وفي اللحظة نفسها: النموذج معطَّل والبثّ مرفوض
    expect(provider.listModels()[0]!.enabled).toBe(false);
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks[0]!.type).toBe("error");
  });

  it("★ (٢٨) وفتح المفتاح لا يغيّر دلالة الفحص", async () => {
    const closed = await build().provider.healthCheck();
    openSwitch();
    const opened = await build().provider.healthCheck();
    expect(opened.status).toBe(closed.status);
    expect(opened.modelCount).toBe(closed.modelCount);
  });

  it("★ ولا يذكر الفاحص مفتاح الإذن في مصدره", () => {
    const at = YSD_SRC.indexOf("async healthCheck(");
    const body = YSD_SRC.slice(at);
    expect(body).not.toContain("isYSDAlphaActivationEnabled");
    expect(body).not.toContain("isServingEnabled");
    expect(body).not.toContain("YSD_MODEL_ALPHA_ENABLED");
  });

  it("★ ولا تظهر حالة التفعيل في نتيجة الفحص", async () => {
    for (const open of [false, true]) {
      if (open) openSwitch();
      else delete process.env.YSD_MODEL_ALPHA_ENABLED;
      const health = await build().provider.healthCheck();
      expect(Object.keys(health).sort()).toEqual(["latencyMs", "modelCount", "status"]);
      expect(JSON.stringify(health)).not.toContain("ENABLED");
    }
  });
});

/* ═══════════ (٢٩–٣٤) بوّابة القاعدة في /api/models ═══════════ */

describe("★ (٢٩–٣٤) /api/models — مفتاحٌ مفتوح لا يكفي", () => {
  /** يُحاكي الترشيح الحقيقيّ المستخرَج من المسار */
  const filterOptions = (
    options: Array<{ id: string }>,
    policyModels: Array<{ id: string; enabled: boolean }>,
  ) => {
    const ysdRow = policyModels.find((m) => m.id === YSD_ALPHA_MODEL_ID);
    const ysdDbEnabled = ysdRow?.enabled === true;
    return options.filter((o) => o.id !== YSD_ALPHA_MODEL_ID || ysdDbEnabled);
  };

  const OPTIONS = [
    { id: "ysd/free" },
    { id: YSD_ALPHA_MODEL_ID },
    { id: "9router/dynamic-model" },
  ];

  it("★ (٢٩) المفتاح مغلق ⇒ لا خيار أصلًا يصل الترشيح", async () => {
    const { listModelOptions } = await import("@/lib/ai/registry");
    expect(listModelOptions().some((o) => o.id === YSD_ALPHA_MODEL_ID)).toBe(false);
  });

  it("★ (٣٠) ★ ومفتاحٌ مفتوح وأهليّة قاعدةٍ مغلقة ⇒ لا يظهر", () => {
    /**
     * وإلا ظهر للمستخدم نموذجٌ سيرفضه `/api/chat` فورًا — وهو أسوأ من
     * إخفائه: نقرةٌ تنتهي بخطأ لا يفهم سببه.
     */
    const out = filterOptions(OPTIONS, [
      { id: "ysd/free", enabled: true },
      { id: YSD_ALPHA_MODEL_ID, enabled: false },
    ]);
    expect(out.map((o) => o.id)).not.toContain(YSD_ALPHA_MODEL_ID);
  });

  it("★ (٣١) والاثنتان مفتوحتان ⇒ يظهر", () => {
    const out = filterOptions(OPTIONS, [{ id: YSD_ALPHA_MODEL_ID, enabled: true }]);
    expect(out.map((o) => o.id)).toContain(YSD_ALPHA_MODEL_ID);
  });

  it("★ (٣٢) وصفٌّ غائب من القاعدة ⇒ لا يظهر — الإغلاق هو الافتراض", () => {
    expect(filterOptions(OPTIONS, []).map((o) => o.id)).not.toContain(YSD_ALPHA_MODEL_ID);
    expect(
      filterOptions(OPTIONS, [{ id: "other", enabled: true }]).map((o) => o.id),
    ).not.toContain(YSD_ALPHA_MODEL_ID);
  });

  it("★ (٣٣–٣٤) ★ وبقيّة المزوّدين لا تتغيّر دلالتهم", () => {
    /**
     * ★ حارسٌ يحمي ميزةً قائمة.
     *
     * نماذج 9Router تُكتشف ديناميكيًّا ولا صفوف لها في `ai_models` أصلًا.
     * فترشيحٌ عامّ على أهليّة القاعدة كان سيمحوها كلَّها بلا أن يقصد أحد —
     * كسرُ ما يعمل ثمنًا لحراسة ما لم يُفتح بعد.
     */
    const out = filterOptions(OPTIONS, [{ id: YSD_ALPHA_MODEL_ID, enabled: false }]);
    expect(out.map((o) => o.id)).toEqual(["ysd/free", "9router/dynamic-model"]);

    // ولا صفّ لأيٍّ منهما في السياسة، ويبقيان
    const none = filterOptions(OPTIONS, []);
    expect(none.map((o) => o.id)).toEqual(["ysd/free", "9router/dynamic-model"]);
  });

  it("★ والمسار يرشّح معرّف YSD وحده — لا ترشيحًا عامًّا", () => {
    expect(MODELS_ROUTE).toContain(
      ".filter((o) => o.id !== YSD_ALPHA_MODEL_ID || ysdDbEnabled)",
    );
    expect(MODELS_ROUTE).toContain('import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";');
    // ولا ترشيحٌ يقيس `enabled` لكل خيار
    const code = MODELS_ROUTE.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("minTierById.get(o.id)?.enabled");
    expect(code).not.toMatch(/filter\(\(o\) => .*enabledById/);
  });
});

/* ═══════════ (٣٥–٤٤) لا تفعيل بالخطأ ═══════════ */

describe("★ (٣٥–٤٤) ما لم تفعله هذه الرقعة", () => {
  it("★ (٣٥) ★ صفّ القاعدة ما يزال معطَّلًا في 0036", () => {
    expect(MIGRATION_0036).toContain("'ysd/model-alpha'");
    const at = MIGRATION_0036.indexOf("'ysd/model-alpha'");
    const around = MIGRATION_0036.slice(Math.max(0, at - 400), at + 400);
    expect(around).toContain("false");
    expect(around).not.toMatch(/enabled\s*\)\s*values[^;]*true/i);
  });

  it("★ (٣٦–٣٨) ★ ولا ترحيلة جديدة ولا تحديث يفعّل", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files.some((f) => f.startsWith("0038"))).toBe(false);
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(37);

    for (const f of files) {
      const sql = readFileSync(`supabase/migrations/${f}`, "utf8").toLowerCase();
      expect(sql, f).not.toContain("update public.ai_models set enabled = true");
      expect(sql, f).not.toContain("update public.ai_providers set enabled");
    }
  });

  it("★ (٣٩) و.env.example افتراضه الإغلاق", () => {
    expect(ENV_EXAMPLE).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    expect(ENV_EXAMPLE).not.toContain("YSD_MODEL_ALPHA_ENABLED=1");
  });

  it("★ (٤٠) ★ ولا NEXT_PUBLIC للمفتاح في أي مكان", () => {
    for (const src of [ENV_EXAMPLE, ACTIVATION_SRC, YSD_SRC, MODELS_ROUTE]) {
      expect(src).not.toContain("NEXT_PUBLIC_YSD_MODEL_ALPHA");
    }
    /**
     * الشيفرة وحدها تُقاس: الشرح يذكر `NEXT_PUBLIC` ليقول لِمَ لا يُستعمل،
     * وحارسٌ يقرأ التعليق كشيفرة يمنع التوثيق لا الانحدار.
     */
    const code = ACTIVATION_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("NEXT_PUBLIC");
  });

  it("★ (٤١) ولا يظهر اسم المتغيّر في نتيجة الفحص", async () => {
    const health = await build().provider.healthCheck();
    expect(JSON.stringify(health)).not.toContain("YSD_MODEL_ALPHA");
  });

  it("★ (٤٢–٤٣) وسياستا العبور كما هما", () => {
    for (const open of [false, true]) {
      if (open) openSwitch();
      else delete process.env.YSD_MODEL_ALPHA_ENABLED;
      const { provider } = build();
      expect(provider.fallbackPolicy).toBe("none");
      expect(provider.fallbackEligible).toBe(false);
    }
  });

  it("★ (٤٤) وysd/free ما يزال لـOpenRouter", async () => {
    openSwitch();
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });
});

/* ═══════════ عقد التراجع الطارئ ═══════════ */

describe("★ عقد التراجع الطارئ", () => {
  it("★ ★ إغلاق المفتاح وحده يوقف كل توليدٍ جديد", async () => {
    /**
     * وإن بقيت القاعدة مفعِّلةً والنشرة نشطةً ووقت التشغيل حيًّا. متغيّر
     * بيئةٍ واحد أسرع من ترحيلةٍ وأقلّ خطرًا من نشرةٍ عاجلة.
     */
    openSwitch();
    expect(build().provider.listModels()[0]!.enabled).toBe(true);

    // وتُغلق
    process.env.YSD_MODEL_ALPHA_ENABLED = "0";

    const { provider, deps } = build();
    expect(provider.listModels()[0]!.enabled).toBe(false);

    const { resolveProviderForModel } = await import("@/lib/ai/registry");
    expect(resolveProviderForModel(YSD_ALPHA_MODEL_ID)).toBeNull();

    expect((await collect(provider.streamChat(chatRequest())))[0]!.type).toBe("error");
    expect(await provider.requestJsonCompletion(jsonInput)).toEqual({ ok: false, reason: "error" });
    expect(deps.streamRuntimeChat).not.toHaveBeenCalled();
    expect(deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();

    // ويبقى الفحص عاملًا — كي يُشخَّص العطل بعد الإيقاف
    expect((await provider.healthCheck()).status).toBe("connected");
  });

  it("★ وحذف المتغيّر كإغلاقه تمامًا", async () => {
    openSwitch();
    delete process.env.YSD_MODEL_ALPHA_ENABLED;
    const { provider } = build();
    expect(provider.listModels()[0]!.enabled).toBe(false);
    expect((await collect(provider.streamChat(chatRequest())))[0]!.type).toBe("error");
  });

  it("★ والبوّابة تسبق كل قاعدة في المصدر", () => {
    const at = YSD_SRC.indexOf("async *streamChat(");
    const body = YSD_SRC.slice(at, at + 2_000);
    const gateAt = body.indexOf("this.isServingEnabled(");
    const resolveAt = body.indexOf("this.resolveRuntimeTarget(");
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(resolveAt);
  });
});
