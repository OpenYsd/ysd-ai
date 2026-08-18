/**
 * فاحص اتصال YSD (v0.9.3، الرقعة السابعة) — **السلسلة كاملةً أو لا «متصل»**.
 *
 * ── ما يقوله الزرّ الآن ──
 *
 *   السجلّ يُقرأ  ⇐  نشرةٌ نشطة لنسخةٍ معتمدة  ⇐  وقت تشغيلٍ يُجيب
 *   ⇐  والنموذج المطلوب محمَّلٌ فيه بالاسم نفسه.
 *
 * وكل حلقةٍ تنكسر تُعطي حالةً تدلّ المشرف على **مكان** العطل: أفي البيئة،
 * أم في جداول السجلّ، أم في وقت التشغيل؟ لأن «غير متصل» وحدها لا تدلّه
 * على شيء.
 *
 * وكل ما هنا بالحقن: لا قاعدة، ولا شبكة، ولا سرّ.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";

import { YSDProvider, YSD_ALPHA_MODEL_ID, type YSDProviderDependencies } from "@/lib/ai/ysd";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeReadinessResult } from "@/lib/ai/ysd-runtime-client";

const YSD_SRC = readFileSync("lib/ai/ysd.ts", "utf8");

const RUNTIME_MODEL = "ysd-alpha-2026-01";
const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret-value";
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

const READY: YSDRuntimeReadinessResult = { ok: true, modelCount: 7, latencyMs: 12 };

/** يبني مزوّدًا بجواسيس على كل اعتماد — فيُقاس ما استُدعي وما لم يُستدعَ */
function build(over: Partial<Record<keyof YSDProviderDependencies, unknown>> = {}) {
  const deps = {
    readRuntimeConfig: vi.fn(() => ({ ok: true, config: runtimeConfig })),
    hasRegistryAccess: vi.fn(() => true),
    getAdminClient: vi.fn(() => ({ from: () => ({}) })),
    resolveDeployment: vi.fn(async () => ({ ok: true, deployment, version })),
    streamRuntimeChat: vi.fn(async function* () {}),
    requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: true, text: "{}" })),
    checkRuntimeReadiness: vi.fn(async () => READY),
    ...over,
  } as Record<keyof YSDProviderDependencies, Mock>;
  return {
    provider: new YSDProvider(deps as unknown as Partial<YSDProviderDependencies>),
    deps,
  };
}

const failReadiness = (
  reason: Exclude<YSDRuntimeReadinessResult, { ok: true }>["reason"],
  modelCount?: number,
) =>
  vi.fn(async () => ({ ok: false, reason, modelCount, latencyMs: 9 }) as YSDRuntimeReadinessResult);

const original = process.env.YSD_PROVIDER_ENABLED;
beforeEach(() => {
  process.env.YSD_PROVIDER_ENABLED = "1";
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
});

/* ═══════════ (١–٣) إعدادٌ ناقص ═══════════ */

describe("★ (١–٣) غير مهيّأ — ولا قاعدة ولا شبكة", () => {
  const assertUntouched = (deps: ReturnType<typeof build>["deps"]) => {
    expect(deps.getAdminClient).not.toHaveBeenCalled();
    expect(deps.resolveDeployment).not.toHaveBeenCalled();
    expect(deps.checkRuntimeReadiness).not.toHaveBeenCalled();
  };

  it("★ (١) العَلَم مغلق ⇒ not_configured بلا لمس شيء", async () => {
    delete process.env.YSD_PROVIDER_ENABLED;
    const { provider, deps } = build();
    const health = await provider.healthCheck();
    expect(health.status).toBe("not_configured");
    assertUntouched(deps);
  });

  it("★ (٢) وإعداد وقت تشغيلٍ ناقص ⇒ not_configured", async () => {
    const { provider, deps } = build({
      readRuntimeConfig: vi.fn(() => ({ ok: false, reason: "missing_base_url" })),
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe("not_configured");
    assertUntouched(deps);
  });

  it("★ (٣) وصلاحية سجلٍّ غائبة ⇒ not_configured", async () => {
    const { provider, deps } = build({ hasRegistryAccess: vi.fn(() => false) });
    const health = await provider.healthCheck();
    expect(health.status).toBe("not_configured");
    assertUntouched(deps);
  });

  it("★ والإشارة الملغاة قبل البدء ⇒ unreachable بلا قاعدة", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, deps } = build();
    const health = await provider.healthCheck(ac.signal);
    expect(health.status).toBe("unreachable");
    assertUntouched(deps);
  });
});

/* ═══════════ (٤–٧) السجلّ لم يُجب ═══════════ */

describe("★ (٤–٧) تعذّر السجلّ ⇒ unreachable", () => {
  const cases: Array<[string, Partial<Record<keyof YSDProviderDependencies, unknown>>]> = [
    ["عميل الإدارة null", { getAdminClient: vi.fn(() => null) }],
    [
      "عميل الإدارة يرمي",
      {
        getAdminClient: vi.fn(() => {
          throw new Error(`تعذّر الاتصال بـ${BASE_URL} بالمفتاح ${KEY}`);
        }),
      },
    ],
    ["الحلّال يقول registry_error", { resolveDeployment: vi.fn(async () => ({ ok: false, reason: "registry_error" })) }],
    [
      "الحلّال يرمي",
      {
        resolveDeployment: vi.fn(async () => {
          throw new Error(`صفّ ${DEPLOYMENT_ID} تالف`);
        }),
      },
    ],
  ];

  it.each(cases)("★ %s ⇒ unreachable بلا نصّ خام", async (_label, over) => {
    const { provider, deps } = build(over);
    const health = await provider.healthCheck();
    expect(health.status).toBe("unreachable");
    // ولا مِسبار: لا هدف نُسبر إليه
    expect(deps.checkRuntimeReadiness).not.toHaveBeenCalled();
    const dump = JSON.stringify(health);
    for (const raw of [BASE_URL, KEY, DEPLOYMENT_ID, "registry_error", "تالف"]) {
      expect(dump, raw).not.toContain(raw);
    }
  });

  it("★ ★ و`invalid_input` عطلُ سجلٍّ لا نقصُ نشرة", async () => {
    /**
     * المعرّف ثابتٌ في الكود، والبيئة من إعدادٍ تُحقّق قبل الاستدعاء. فرفضُ
     * الحلّال لهما خللٌ في برنامجنا لا في بيانات السجلّ. و`no_models` كانت
     * سترسل المشرف يفتّش جداولَ لا عيب فيها.
     */
    const { provider } = build({
      resolveDeployment: vi.fn(async () => ({ ok: false, reason: "invalid_input" })),
    });
    expect((await provider.healthCheck()).status).toBe("unreachable");
  });
});

/* ═══════════ (٨–١٢) السجلّ أجاب ولا نشرة ═══════════ */

describe("★ (٨–١٢) لا نشرة صالحة ⇒ no_models", () => {
  const reasons = [
    "no_active_deployment",
    "ambiguous_active_deployment",
    "version_not_found",
    "invalid_record",
    "not_servable",
  ] as const;

  it.each(reasons)("★ %s ⇒ no_models بعدّادٍ صفر", async (reason) => {
    const { provider, deps } = build({
      resolveDeployment: vi.fn(async () => ({ ok: false, reason })),
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe("no_models");
    expect(health.modelCount).toBe(0);
    expect(deps.checkRuntimeReadiness).not.toHaveBeenCalled();
    expect(JSON.stringify(health)).not.toContain(reason);
  });
});

/* ═══════════ (١٣–١٩) وقت التشغيل ═══════════ */

describe("★ (١٣–١٩) نتيجة المِسبار", () => {
  it("★ (١٣) unauthorized ⇒ unauthorized", async () => {
    const { provider } = build({ checkRuntimeReadiness: failReadiness("unauthorized") });
    expect((await provider.healthCheck()).status).toBe("unauthorized");
  });

  it("★ (١٤) ★ model_not_loaded ⇒ no_models لا connected", async () => {
    /**
     * ★ الحالة التي وُجدت هذه الرقعة لأجلها.
     *
     * وقت التشغيل حيّ، والمفتاح مقبول، والقائمة صالحة — وليس فيها نموذجنا.
     * والعدّاد يُنقل كما هو: عشرون نموذجًا حاضرًا وليس فيها المطلوب خبرٌ
     * يدلّ المشرف على أن العطل في **ما حُمِّل**، لا في الاتصال.
     */
    const { provider } = build({ checkRuntimeReadiness: failReadiness("model_not_loaded", 20) });
    const health = await provider.healthCheck();
    expect(health.status).toBe("no_models");
    expect(health.modelCount).toBe(20);
  });

  it("★ (١٤′) وبلا عدّادٍ من المِسبار ⇒ صفر لا undefined", async () => {
    const { provider } = build({ checkRuntimeReadiness: failReadiness("model_not_loaded") });
    expect((await provider.healthCheck()).modelCount).toBe(0);
  });

  it("★ (١٥–١٧) والأعطال كلها ⇒ unreachable", async () => {
    for (const reason of [
      "timeout",
      "network_error",
      "runtime_unavailable",
      "invalid_response",
      "invalid_target",
      "aborted",
    ] as const) {
      const { provider } = build({ checkRuntimeReadiness: failReadiness(reason) });
      const health = await provider.healthCheck();
      expect(health.status, reason).toBe("unreachable");
      expect(JSON.stringify(health), reason).not.toContain(reason);
    }
  });

  it("★ (١٧′) والمِسبار الذي يرمي ⇒ unreachable بلا نصّ", async () => {
    const { provider } = build({
      checkRuntimeReadiness: vi.fn(async () => {
        throw new Error(`${BASE_URL} رفض ${RUNTIME_MODEL}`);
      }),
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe("unreachable");
    expect(JSON.stringify(health)).not.toContain(RUNTIME_MODEL);
  });

  it("★ (١٨) والنجاح ⇒ connected", async () => {
    const { provider } = build();
    expect((await provider.healthCheck()).status).toBe("connected");
  });

  it("★ (١٩) ★ والعدّاد يأتي من المِسبار لا من مكانٍ آخر", async () => {
    for (const count of [1, 7, 42]) {
      const { provider } = build({
        checkRuntimeReadiness: vi.fn(async () => ({ ok: true, modelCount: count, latencyMs: 3 })),
      });
      const health = await provider.healthCheck();
      expect(health.modelCount, String(count)).toBe(count);
    }
  });

  it("★ والزمن زمن السلسلة كلها لا زمن المِسبار وحده", async () => {
    const { provider } = build({
      checkRuntimeReadiness: vi.fn(async () => ({ ok: true, modelCount: 1, latencyMs: 999_999 })),
    });
    const health = await provider.healthCheck();
    expect(typeof health.latencyMs).toBe("number");
    expect(health.latencyMs).toBeLessThan(999_999);
  });
});

/* ═══════════ (٢٠–٢٦) الترتيب وما لا يُستدعى ═══════════ */

describe("★ (٢٠–٢٦) ما يُستدعى ومتى", () => {
  it("★ (٢٠) يحلّ النموذج المملوك وحده", async () => {
    const { provider, deps } = build();
    await provider.healthCheck();
    const [, modelId] = deps.resolveDeployment.mock.calls[0]!;
    expect(modelId).toBe(YSD_ALPHA_MODEL_ID);
  });

  it("★ (٢١) والبيئة من إعداد وقت التشغيل", async () => {
    const { provider, deps } = build();
    await provider.healthCheck();
    const [, , environment] = deps.resolveDeployment.mock.calls[0]!;
    expect(environment).toBe("production");
  });

  it("★ (٢٢) ★ والحلّال قبل المِسبار — لا اتصال بهدفٍ لم يُحلّ", async () => {
    const order: string[] = [];
    const { provider } = build({
      resolveDeployment: vi.fn(async () => {
        order.push("resolve");
        return { ok: true, deployment, version };
      }),
      checkRuntimeReadiness: vi.fn(async () => {
        order.push("probe");
        return READY;
      }),
    });
    await provider.healthCheck();
    expect(order).toEqual(["resolve", "probe"]);
  });

  it("★ (٢٣) والهدف المحلول بعينه يصل المِسبار", async () => {
    const { provider, deps } = build();
    await provider.healthCheck();
    const [cfg, dep, ver, modelId] = deps.checkRuntimeReadiness.mock.calls[0]!;
    expect(cfg).toEqual(runtimeConfig);
    expect(dep).toEqual(deployment);
    expect(ver).toEqual(version);
    expect(modelId).toBe(YSD_ALPHA_MODEL_ID);
  });

  it("★ والإشارة تُمرَّر كي يُلغى الفحص مع المستدعي", async () => {
    const ac = new AbortController();
    const { provider, deps } = build();
    await provider.healthCheck(ac.signal);
    const [, , , , signal] = deps.checkRuntimeReadiness.mock.calls[0]!;
    expect(signal).toBe(ac.signal);
  });

  it("★ (٢٤–٢٦) ★ ولا توليد ولا استهلاك رموز في أي مسار", async () => {
    /**
     * الفحص قراءة. ولو لمس مسارَ إكمالٍ مرةً واحدة لصار زرُّ الإدارة بابًا
     * لتكلفةٍ غير مقصودة — يُضغط مرارًا وكلّ ضغطةٍ تُحاسَب.
     */
    const readiness: Array<Partial<Record<keyof YSDProviderDependencies, unknown>>> = [
      {},
      { checkRuntimeReadiness: failReadiness("unauthorized") },
      { checkRuntimeReadiness: failReadiness("model_not_loaded", 3) },
      { checkRuntimeReadiness: failReadiness("timeout") },
      { resolveDeployment: vi.fn(async () => ({ ok: false, reason: "not_servable" })) },
      { getAdminClient: vi.fn(() => null) },
      { hasRegistryAccess: vi.fn(() => false) },
    ];
    for (const over of readiness) {
      const { provider, deps } = build(over);
      await provider.healthCheck();
      expect(deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
      expect(deps.streamRuntimeChat).not.toHaveBeenCalled();
    }
  });
});

/* ═══════════ (٢٧) خصوصية الإدارة ═══════════ */

describe("★ (٢٧) ما يصل لوحة الإدارة", () => {
  it("★ ★ ثلاثة حقول لا رابع", async () => {
    const outcomes: Array<Partial<Record<keyof YSDProviderDependencies, unknown>>> = [
      {},
      { checkRuntimeReadiness: failReadiness("unauthorized") },
      { checkRuntimeReadiness: failReadiness("model_not_loaded", 5) },
      { checkRuntimeReadiness: failReadiness("network_error") },
      { resolveDeployment: vi.fn(async () => ({ ok: false, reason: "no_active_deployment" })) },
      { getAdminClient: vi.fn(() => null) },
      { hasRegistryAccess: vi.fn(() => false) },
    ];
    for (const over of outcomes) {
      const { provider } = build(over);
      const health = await provider.healthCheck();
      const keys = Object.keys(health).sort();
      expect(keys.every((k) => ["status", "modelCount", "latencyMs"].includes(k)), keys.join()).toBe(
        true,
      );

      const dump = JSON.stringify(health);
      for (const secret of [
        RUNTIME_MODEL,
        ALIAS,
        BASE_URL,
        KEY,
        DEPLOYMENT_ID,
        VERSION_ID,
        "1.4.2",
        "artifact-1",
        "base-a",
        "production",
        YSD_ALPHA_MODEL_ID,
      ]) {
        expect(dump, secret).not.toContain(secret);
      }
    }
  });

  it("★ ولا سجلّ نصّيّ من الفاحص", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      await build().provider.healthCheck();
      await build({ checkRuntimeReadiness: failReadiness("model_not_loaded", 2) }).provider.healthCheck();
      await build({ getAdminClient: vi.fn(() => null) }).provider.healthCheck();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(logs).toEqual([]);
  });

  it("★ والمسار الإداريّ يستدعيه كما هو بلا تعديل", () => {
    const route = readFileSync("app/api/admin/ai-providers/test/route.ts", "utf8");
    expect(route).toContain("await provider.healthCheck()");
    // ولا يقرأ الهدف ولا يبني حقولًا من عنده
    for (const forbidden of ["runtimeModel", "deploymentId", "endpointAlias", "baseUrl"]) {
      expect(route, forbidden).not.toContain(forbidden);
    }
  });
});

/* ═══════════ لا تفعيل ═══════════ */

describe("★ الرقعة لا تفعّل شيئًا", () => {
  it("★ model-alpha ما يزال معطَّلًا", () => {
    expect(build().provider.listModels()[0]!.enabled).toBe(false);
    expect(YSD_SRC).toContain("enabled: false,");
  });

  it("★ وسياستا العبور كما هما", () => {
    const { provider } = build();
    expect(provider.fallbackPolicy).toBe("none");
    expect(provider.fallbackEligible).toBe(false);
  });

  it("★ وysd/free ما يزال لـOpenRouter", async () => {
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });

  it("★ ولا متغيّر بيئة جديد للفحص", () => {
    const code = YSD_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    /**
     * الاسمان القائمان منذ الرقعة الخامسة، ولا ثالث: الفحص لم يُدخل
     * متغيّرًا خاصًّا به. ولو أُدخل `HEALTH_URL` لَصار عندنا عنوانان قد
     * يفترقان — فيُفحص مضيفٌ غير الذي يخدم الطلبات فعلًا.
     */
    const names = [...new Set(code.match(/process\.env\.[A-Z_]+/g) ?? [])].sort();
    expect(names).toEqual([
      "process.env.NEXT_PUBLIC_SUPABASE_URL",
      "process.env.YSD_PROVIDER_ENABLED",
    ]);
    const client = readFileSync("lib/ai/ysd-runtime-client.ts", "utf8");
    expect(client).not.toContain("HEALTH_URL");
    expect(client).not.toContain("MODELS_URL");
  });
});
