/**
 * نسب هدف YSD (v0.9.3، الرقعة السادسة) — **من يعرف ماذا**.
 *
 * ── السؤال ──
 *
 * «أيّ نسخةٍ وأيّ نشرةٍ أنتجتا هذا الرد؟» — لا يُجاب بعد شهر إن لم يُلتقط
 * لحظتَه، لأن النشرة تتغيّر مع كل ترقية والنسخة تتقاعد.
 *
 * ── وثلاث دوائر لا واحدة ──
 *
 *   المتصفّح  → المعرّف المنطقيّ وحده.
 *   الرسالة   → ونسخة النموذج معها (نسبٌ يفيد القارئ بعد شهور).
 *   الرصد     → والمعرّفات كلها — إداريّ لا يصله عميل.
 *
 * فالاتّساع مقصود ومتدرّج، وكل حدٍّ محروسٌ هنا على حدة.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { YSDProvider, YSD_ALPHA_MODEL_ID, type YSDProviderDependencies } from "@/lib/ai/ysd";
import { readYsdTargetProvenance } from "@/lib/admin/health-metrics";
import type { ChatRequest, StreamChunk } from "@/lib/ai/types";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeChunk } from "@/lib/ai/ysd-runtime-client";

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const METRICS = readFileSync("lib/admin/health-metrics.ts", "utf8");
const MIGRATION = readFileSync("supabase/migrations/0037_ysd_target_observability.sql", "utf8");
const YSD_SRC = readFileSync("lib/ai/ysd.ts", "utf8");

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "sk-ysd-runtime-secret";
const BASE_URL = "https://runtime.internal.example/v1";
const ALIAS = "ysd-inference-primary";
const RUNTIME_MODEL = "ysd-alpha-artifact-2026-01";
const ARTIFACT = "artifact-1";

const runtimeConfig = {
  deploymentEnvironment: "production" as const,
  endpointAlias: ALIAS,
  baseUrl: BASE_URL,
  apiKey: KEY,
};

const deployment = (over: Partial<ModelDeploymentRecord> = {}): ModelDeploymentRecord => ({
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
  ...over,
});

const version = (over: Partial<ModelVersionRecord> = {}): ModelVersionRecord => ({
  id: VERSION_ID,
  modelId: YSD_ALPHA_MODEL_ID,
  version: "1.4.2",
  status: "approved",
  baseModelRef: "base-a",
  artifactRef: ARTIFACT,
  createdAt: "t",
  approvedAt: "t",
  retiredAt: null,
  ...over,
});

const chatRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  modelId: YSD_ALPHA_MODEL_ID,
  messages: [{ role: "user", content: "مرحبًا" }],
  ...over,
});

type RuntimeStream = (...args: unknown[]) => AsyncGenerator<YSDRuntimeChunk>;

function build(streamRuntimeChat?: RuntimeStream) {
  const deps = {
    readRuntimeConfig: vi.fn(() => ({ ok: true, config: runtimeConfig })),
    hasRegistryAccess: vi.fn(() => true),
    getAdminClient: vi.fn(() => ({ from: () => ({}) })),
    resolveDeployment: vi.fn(async () => ({
      ok: true,
      deployment: deployment(),
      version: version(),
    })),
    streamRuntimeChat: vi.fn(
      streamRuntimeChat ??
        (async function* () {
          yield { type: "text", text: "جواب" } as YSDRuntimeChunk;
          yield { type: "done" } as YSDRuntimeChunk;
        } as RuntimeStream),
    ),
    requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: true, text: "{}" })),
  };
  return {
    provider: new YSDProvider(deps as unknown as Partial<YSDProviderDependencies>),
    deps,
  };
}

const collect = async (gen: AsyncGenerator<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
};

const original = process.env.YSD_PROVIDER_ENABLED;
beforeEach(() => {
  process.env.YSD_PROVIDER_ENABLED = "1";
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
});

/* ═══════════ (١–١٠) ما يحمله المزوّد ═══════════ */

describe("★ (١–١٠) نسب الهدف في meta", () => {
  const metaOf = async () => {
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    return chunks.find((c) => c.type === "meta")!;
  };

  it("★ (١–٥) يحمل المعرّف المنطقيّ والنسخة والنشرة والبيئة", async () => {
    const meta = await metaOf();
    expect(meta.model).toBe(YSD_ALPHA_MODEL_ID);
    expect(meta.modelVersion).toBe("1.4.2");
    expect(meta.modelVersionId).toBe(VERSION_ID);
    expect(meta.deploymentId).toBe(DEPLOYMENT_ID);
    expect(meta.deploymentEnvironment).toBe("production");
  });

  it("★ (٦–٩) ولا يحمل هدف اتصالٍ ولا سرًّا", async () => {
    const meta = await metaOf();
    const serialized = JSON.stringify(meta);
    for (const forbidden of [RUNTIME_MODEL, ARTIFACT, ALIAS, BASE_URL, KEY, "base-a"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // ولا حتى كحقول
    expect(meta).not.toHaveProperty("runtimeModel");
    expect(meta).not.toHaveProperty("artifactRef");
    expect(meta).not.toHaveProperty("endpointAlias");
    expect(meta).not.toHaveProperty("baseUrl");
    expect(meta).not.toHaveProperty("apiKey");
  });

  it("★ (٩′) والعقد نفسه يمنع تلك الحقول", () => {
    const types = readFileSync("lib/ai/types.ts", "utf8");
    const chunk = types.slice(
      types.indexOf("export interface StreamChunk"),
      types.indexOf("export interface StreamChunk") + 4_000,
    );
    const code = chunk.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const forbidden of ["runtimeModel", "artifactRef", "endpointAlias", "baseUrl", "apiKey"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (١٠) والناقل يتلقّى الهدف نفسه كما كان", async () => {
    const { provider, deps } = build();
    await collect(provider.streamChat(chatRequest()));
    const [cfg, dep, ver] = deps.streamRuntimeChat.mock.calls[0]!;
    expect(cfg).toEqual(runtimeConfig);
    expect(dep).toEqual(deployment());
    expect(ver).toEqual(version());
  });
});

/* ═══════════ (١١–١٥) النهاية الصامتة ═══════════ */

describe("★ (١١–١٥) إطارٌ طرفيّ واحد دائمًا", () => {
  const terminals = (chunks: StreamChunk[]) =>
    chunks.filter((c) => c.type === "done" || c.type === "error");

  it("★ (١١) الانتهاء الطبيعيّ ⇒ طرفيّ واحد", async () => {
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(terminals(chunks)).toHaveLength(1);
    expect(terminals(chunks)[0]!.type).toBe("done");
  });

  it("★ (١٢) والخطأ ⇒ طرفيّ واحد بلا زيادة", async () => {
    const { provider } = build(
      (async function* () {
        yield { type: "error", reason: "runtime_unavailable" } as YSDRuntimeChunk;
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(terminals(chunks)).toHaveLength(1);
    expect(terminals(chunks)[0]!.type).toBe("error");
  });

  it("★ (١٣) ★ ينتهي صامتًا بلا نصّ ⇒ خطأ عامّ", async () => {
    /**
     * مولّدٌ ينتهي بلا إطارٍ طرفيّ يترك المسار بلا `done` ولا `error`.
     * والصمت أسوأ من العطل هنا لأنه لا يُرى: يبدو الرد مكتملًا وهو لا شيء.
     */
    const { provider } = build((async function* () {}) as RuntimeStream);
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(terminals(chunks)).toHaveLength(1);
    expect(terminals(chunks)[0]!.type).toBe("error");
    expect(terminals(chunks)[0]!.errorCode).toBe("provider_unavailable");
  });

  it("★ (١٤) ★ وينتهي صامتًا بعد نصّ ⇒ ردٌّ ناقص موسوم", async () => {
    const { provider } = build(
      (async function* () {
        yield { type: "text", text: "نصّ" } as YSDRuntimeChunk;
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(terminals(chunks)).toHaveLength(1);
    expect(terminals(chunks)[0]).toEqual({
      type: "done",
      completion: "incomplete_provider",
      completionReason: "runtime_stream_ended",
    });
  });

  it("★ (١٥) والإلغاء لا يُنتج طرفيًّا مصطنعًا", async () => {
    const ac = new AbortController();
    const { provider } = build(
      (async function* () {
        yield { type: "text", text: "نصّ" } as YSDRuntimeChunk;
        ac.abort();
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest({ signal: ac.signal })));
    expect(terminals(chunks)).toHaveLength(0);
  });

  it("★ ولا إطار بعد الطرفيّ", async () => {
    const { provider } = build(
      (async function* () {
        yield { type: "done" } as YSDRuntimeChunk;
        yield { type: "text", text: "بعد النهاية" } as YSDRuntimeChunk;
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest()));
    const lastIdx = chunks.findIndex((c) => c.type === "done");
    expect(lastIdx).toBe(chunks.length - 1);
  });
});

/* ═══════════ (١٦–١٩) حدّ المسار والعميل ═══════════ */

describe("★ (١٦–١٩) المسار يلتقط ولا يُرسل", () => {
  it("★ (١٦) يقبل المجموعة الكاملة وحدها", () => {
    expect(ROUTE).toContain("const targetComplete =");
    for (const f of ["chunk.modelVersion", "chunk.modelVersionId", "chunk.deploymentId"]) {
      expect(ROUTE, f).toContain(f);
    }
    // والبيئة تُفحص بالمجموعة المغلقة
    expect(ROUTE).toContain('targetEnv === "development"');
    expect(ROUTE).toContain('targetEnv === "staging"');
    expect(ROUTE).toContain('targetEnv === "production"');
  });

  it("★ (١٧) والناقصة تُهمَل بلا إسقاط الرد", () => {
    // الالتقاط داخل `if (targetComplete)` — فلا مسار يكتب نصف مجموعة
    const at = ROUTE.indexOf("if (targetComplete) {");
    expect(at).toBeGreaterThan(0);
    const block = ROUTE.slice(at, at + 900);
    expect(block).toContain("providerModelVersionId = targetVersionId;");
    // ولا `throw` ولا `return` يقطع الرد لأجل الرصد
    expect(block).not.toContain("throw");
    /**
     * ولا بناءَ خاصًّا بـTypeScript داخل الكتلة: اختبار `v09` ينفّذها
     * كـJavaScript خام بعد استخراجها، فتوكيدُ `!` واحد يكسر تنفيذها.
     */
    expect(block).not.toMatch(/\w!\s*[;,)]/);
    expect(block).not.toContain(" as ");
  });

  it("★ (١٨) والمجموعة الثانية المختلفة لا تستبدل الأولى", () => {
    expect(ROUTE).toContain("if (providerModelVersionId === null) {");
    expect(ROUTE).toContain("providerTargetMetaConflict = true;");
    // ولا تُطبع القيم — منطقيّ فقط
    expect(ROUTE).toContain("provider_target_meta_conflict=${providerTargetMetaConflict}");
    expect(ROUTE).toContain("ysd_target_attributed=${providerModelVersionId !== null}");
  });

  it("★ (١٩) ★ وما يعبر إلى المتصفّح هو المعرّف وحده", () => {
    /**
     * الإطار المُرسَل يُبنى صراحةً بحقلٍ واحد. فلو مُرِّر `chunk` كاملًا
     * لعبرت المعرّفات إلى المتصفّح بلا أن يقصد أحد.
     */
    expect(ROUTE).toContain('send({ type: "meta", model: chunk.model });');
    const sendAt = ROUTE.indexOf('send({ type: "meta", model: chunk.model });');
    const window = ROUTE.slice(sendAt, sendAt + 200);
    for (const forbidden of ["modelVersionId", "deploymentId", "deploymentEnvironment"]) {
      expect(window, forbidden).not.toContain(forbidden);
    }
    // ولا إطار meta آخر يُرسل بحقول أخرى
    expect((ROUTE.match(/send\(\{ type: "meta"/g) ?? []).length).toBe(1);
  });
});

/* ═══════════ (٢٠–٢٣) نسب الرسالة ═══════════ */

describe("★ (٢٠–٢٣) الرسالة تحفظ النسخة وحدها", () => {
  it("★ (٢٠) model_version يُحفظ حين يكتمل النسب", () => {
    expect(ROUTE).toContain(
      "if (providerModelVersion !== null) meta.model_version = providerModelVersion;",
    );
  });

  it("★ (٢١–٢٣) ولا معرّف نشرة ولا معرّف نسخة ولا بيئة", () => {
    const code = ROUTE.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const forbidden of [
      "meta.deployment_id",
      "meta.model_version_id",
      "meta.deployment_environment",
      "meta.ysd_deployment_id",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

/* ═══════════ (٢٤–٢٨) الرصد الدائم ═══════════ */

describe("★ (٢٤–٢٨) الحدث الدائم", () => {
  it("★ (٢٤) الحقول اختيارية — المستدعي القديم لا ينكسر", () => {
    expect(METRICS).toContain("ysdModelVersionId?: string | null;");
    expect(METRICS).toContain("ysdDeploymentId?: string | null;");
    expect(METRICS).toContain("ysdDeploymentEnvironment?:");
  });

  it("★ (٢٥) المجموعة الكاملة تُقبل", () => {
    expect(
      readYsdTargetProvenance({
        ysdModelVersionId: VERSION_ID,
        ysdDeploymentId: DEPLOYMENT_ID,
        ysdDeploymentEnvironment: "production",
      }),
    ).toEqual({
      modelVersionId: VERSION_ID,
      deploymentId: DEPLOYMENT_ID,
      environment: "production",
    });
  });

  it("★ (٢٦) والناقصة تسقط كلها إلى null", () => {
    const partials = [
      {},
      { ysdModelVersionId: VERSION_ID },
      { ysdDeploymentId: DEPLOYMENT_ID },
      { ysdDeploymentEnvironment: "production" },
      { ysdModelVersionId: VERSION_ID, ysdDeploymentId: DEPLOYMENT_ID },
      { ysdModelVersionId: VERSION_ID, ysdDeploymentEnvironment: "production" },
      { ysdDeploymentId: DEPLOYMENT_ID, ysdDeploymentEnvironment: "production" },
    ];
    for (const p of partials) {
      expect(readYsdTargetProvenance(p), JSON.stringify(p)).toBeNull();
    }
  });

  it("★ (٢٧) ★ والمعرّف الفاسد يسقط إلى null ولا يرمي", () => {
    /**
     * القيد في القاعدة يرفض الفاسد — لكن الرفض هناك يُسقط كتابة الحدث
     * كلّه، فتضيع كل مقاييس الطلب لأجل حقلٍ اختياريّ. فيُحسم هنا قبل
     * الكتابة، والقيد يبقى حارسًا أخيرًا لا مرشّحًا أوّل.
     */
    const bad = [
      { ysdModelVersionId: "not-a-uuid", ysdDeploymentId: DEPLOYMENT_ID, ysdDeploymentEnvironment: "production" },
      { ysdModelVersionId: VERSION_ID, ysdDeploymentId: "123", ysdDeploymentEnvironment: "production" },
      { ysdModelVersionId: VERSION_ID, ysdDeploymentId: DEPLOYMENT_ID, ysdDeploymentEnvironment: "canary" },
      { ysdModelVersionId: "", ysdDeploymentId: "", ysdDeploymentEnvironment: "" },
      { ysdModelVersionId: null, ysdDeploymentId: null, ysdDeploymentEnvironment: null },
    ];
    for (const p of bad) {
      expect(() => readYsdTargetProvenance(p), JSON.stringify(p)).not.toThrow();
      expect(readYsdTargetProvenance(p), JSON.stringify(p)).toBeNull();
    }
  });

  it("★ والكتابة ثلاثتها أو ثلاثة أصفار", () => {
    expect(METRICS).toContain("ysd_model_version_id: target?.modelVersionId ?? null,");
    expect(METRICS).toContain("ysd_deployment_id: target?.deploymentId ?? null,");
    expect(METRICS).toContain("ysd_deployment_environment: target?.environment ?? null,");
  });

  it("★ (٢٨) ولا معرّف في أي سجلّ نصّيّ", () => {
    // في المقاييس: السجلّ الوحيد يحمل رمز خطأ لا معرّفًا
    const logs = METRICS.match(/console\.(log|error|warn)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      for (const forbidden of ["ysd_model_version_id", "ysd_deployment_id", "modelVersionId", "deploymentId"]) {
        expect(l, forbidden).not.toContain(forbidden);
      }
    }
    // وفي المسار: منطقيّان فقط
    const routeLogs = ROUTE.match(/ysd_target_attributed=\$\{[^}]+\}/g) ?? [];
    expect(routeLogs).toHaveLength(1);
    expect(routeLogs[0]).toContain("!== null");
  });

  it("★ والمسار يمرّر النسب إلى الحدث الدائم", () => {
    expect(ROUTE).toContain("ysdModelVersionId: providerModelVersionId,");
    expect(ROUTE).toContain("ysdDeploymentId: providerDeploymentId,");
    expect(ROUTE).toContain("ysdDeploymentEnvironment: providerDeploymentEnvironment,");
  });
});

/* ═══════════ الترحيلة والخصوصية ═══════════ */

describe("★ الترحيلة 0037", () => {
  it("★ ملفّ واحد جديد، وهو الأحدث ترقيمًا", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0037_ysd_target_observability.sql");
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(37);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  const CODE = MIGRATION.split("\n").filter((l) => !/^\s*(--|\*|\/\*)/.test(l)).join("\n");

  it("★ الأعمدة الثلاثة قابلة للغياب — لا ملء رجعيّ", () => {
    expect(CODE).toContain("add column if not exists ysd_model_version_id uuid");
    expect(CODE).toContain("add column if not exists ysd_deployment_id uuid");
    expect(CODE).toContain("add column if not exists ysd_deployment_environment text");
    /**
     * ولا `not null` في **تعريف عمود** — يُقاس على كتلة `add column` وحدها،
     * إذ `is not null` في الفهرس الجزئيّ يحتوي النصّ نفسه بلا أن يعني شيئًا.
     */
    const addBlock = CODE.slice(
      CODE.indexOf("alter table public.observability_events"),
      CODE.indexOf("ysd_deployment_environment text") + 40,
    );
    expect(addBlock.toLowerCase()).not.toContain("not null");
    expect(addBlock.toLowerCase()).not.toContain("default");
    expect(CODE.toLowerCase()).not.toContain("update public.observability_events");
  });

  it("★ وقيد «الثلاثة أو لا شيء»", () => {
    expect(CODE).toContain("num_nonnulls(ysd_model_version_id, ysd_deployment_id, ysd_deployment_environment)");
    expect(CODE).toContain("in (0, 3)");
  });

  it("★ ★ والمرجع المركّب بثلاثة أعمدة لا بواحد", () => {
    expect(CODE).toContain(
      "foreign key (ysd_deployment_id, ysd_model_version_id, ysd_deployment_environment)",
    );
    expect(CODE).toContain(
      "references public.ai_model_deployments (id, model_version_id, environment)",
    );
    expect(CODE).toContain("on delete restrict");
  });

  it("★ ولا سياسة ولا منح ولا RPC", () => {
    expect(CODE.toLowerCase()).not.toContain("create policy");
    expect(CODE.toLowerCase()).not.toContain("grant ");
    expect(CODE.toLowerCase()).not.toContain("security definer");
  });

  it("★ ولا عمود هوية ولا محتوى ولا هدف اتصال", () => {
    for (const forbidden of [
      "user_id", "conversation_id", "message_id", "email",
      "prompt", "response", "runtime_model", "artifact_ref",
      "endpoint_alias", "base_url", "api_key",
    ]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ولا تمسّ 0036 ولا تزرع صفًّا", () => {
    expect(CODE.toLowerCase()).not.toContain("drop ");
    expect(CODE).not.toMatch(/insert\s+into\s+public\.observability_events/i);
    expect(CODE).not.toContain("ysd/free");
  });
});

/* ═══════════ لا تفعيل ═══════════ */

describe("★ الرقعة لا تفعّل شيئًا", () => {
  it("★ model-alpha ما يزال معطَّلًا", () => {
    const { provider } = build();
    expect(provider.listModels()[0]!.enabled).toBe(false);
  });

  it("★ وسياستا العبور كما هما", () => {
    const { provider } = build();
    expect(provider.fallbackPolicy).toBe("none");
    expect(provider.fallbackEligible).toBe(false);
    expect(YSD_SRC).toContain('readonly fallbackPolicy = "none" as const;');
    expect(YSD_SRC).toContain("readonly fallbackEligible = false;");
  });

  it("★ وysd/free ما يزال لـOpenRouter", async () => {
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });
});
