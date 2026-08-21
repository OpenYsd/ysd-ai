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

import {
  YSDProvider,
  YSD_ALPHA_MODEL_ID,
  YSD_PROVIDER_ID,
  type YSDProviderDependencies,
} from "@/lib/ai/ysd";
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
const OTHER_VERSION_ID = "33333333-3333-4333-8333-333333333333";
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

/**
 * ★ بوّابةُ إذنٍ ثانية أُضيفت في الرقعة الثامنة.
 *
 * `YSD_PROVIDER_ENABLED` يقول «البنية مهيّأة»، و`YSD_MODEL_ALPHA_ENABLED`
 * يقول «نأذن بالخدمة». وهذه المجموعة تقيس **مسار الخدمة**، فتُفتح البوّابتان
 * صراحةً هنا — والإذن نفسه يملكه v101 ويقيسه وحده.
 */
const original = process.env.YSD_PROVIDER_ENABLED;
const originalAlpha = process.env.YSD_MODEL_ALPHA_ENABLED;
beforeEach(() => {
  process.env.YSD_PROVIDER_ENABLED = "1";
  process.env.YSD_MODEL_ALPHA_ENABLED = "1";
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
  if (originalAlpha === undefined) delete process.env.YSD_MODEL_ALPHA_ENABLED;
  else process.env.YSD_MODEL_ALPHA_ENABLED = originalAlpha;
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
    const numbers = files.map((f) => Number(f.slice(0, f.indexOf("_"))));
    /**
     * ★ حُدِّث في الرقعة التاسعة: هذا الحارس يملك **رقم 0037 وحده**.
     * وربطُه بالأعلى كان يجعل كل ترحيلةٍ لاحقة تُسقطه بلا خطأ حقيقيّ.
     */
    expect(numbers).toContain(37);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let n = 1; n <= 37; n++) expect(numbers, String(n)).toContain(n);
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



/* ═══════════ (٣٦–٤١) قياس المحاولات ═══════════ */

/**
 * ★ الفجوة التي كشفتها نافذة الرصد الأولى.
 *
 * ٢٨ طلبًا حيًّا، وكلها تعرض `fallback_count = 0` و`provider_calls = -1`.
 * وتتبّعُ الكود أثبت أنهما **قيمتان افتراضيتان لا قياسان**: المسار يشتقّهما
 * من `chunk.attemptCount` و`chunk.providerCalls`، ومزوّد YSD لم يكن يبثّ
 * أيًّا منهما. فكان الصفر يبدو إثباتًا لعزل الاحتياط وهو لا يقيسه — ولو وقع
 * احتياطٌ يومًا لَبدا الحقل كما هو.
 *
 * ── وما يحرسه هذا القسم ──
 *
 * أن يصير الحقلان قياسًا، وأن يبقيا **صادقين** حين لا يقع نداء: فالكذب
 * بالإيجاب ليس أفضل من الكذب بالسكوت.
 */
describe("★ (٣٦–٤١) الحقلان يقيسان لا يفترضان", () => {
  const metasOf = (chunks: StreamChunk[]) => chunks.filter((c) => c.type === "meta");
  const counterMeta = (chunks: StreamChunk[]) =>
    metasOf(chunks).find((c) => typeof c.providerCalls === "number");

  it("★ (٣٦) ★ بثٌّ ناجح ⇒ محاولةٌ واحدة ونداءٌ واحد", async () => {
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    const m = counterMeta(chunks);
    expect(m).toBeDefined();
    expect(m!.attemptCount).toBe(1);
    expect(m!.providerCalls).toBe(1);
  });

  it("★ (٣٧) ★ ولا يتجاوزان الواحد مهما طال البثّ", async () => {
    /**
     * المزوّد بلا سلسلة احتياط داخلية ولا إعادة محاولة. فقيمةٌ أكبر من
     * واحد تعني أن شيئًا تغيّر في التصميم بلا أن يتغيّر القياس معه.
     */
    const { provider } = build(
      (async function* () {
        for (let i = 0; i < 12; i++) yield { type: "text", text: `ج${i}` } as YSDRuntimeChunk;
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 9 } } as YSDRuntimeChunk;
        yield { type: "done" } as YSDRuntimeChunk;
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest()));
    const counters = metasOf(chunks).filter((c) => typeof c.providerCalls === "number");
    // إطارُ عدّادٍ واحد لا أكثر
    expect(counters).toHaveLength(1);
    expect(counters[0]!.attemptCount).toBe(1);
    expect(counters[0]!.providerCalls).toBe(1);
  });

  it("★ (٣٨) ★ وطلبٌ ملغى قبل البدء ⇒ لا يدّعي نداءً لم يقع", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, deps } = build();
    const chunks = await collect(provider.streamChat(chatRequest({ signal: ac.signal })));
    expect(chunks).toHaveLength(0);
    expect(deps.streamRuntimeChat).not.toHaveBeenCalled();
  });

  it("★ (٣٩) ★ والخدمة مغلقة أو الهدف متعذّر ⇒ لا عدّاد إطلاقًا", async () => {
    /**
     * لا نداء وقع، فلا رقم يُقال. و`-1` في القاعدة تعني «لم يُبلَّغ» — وهي
     * الحقيقة هنا، لا نقصٌ في القياس.
     */
    delete process.env.YSD_PROVIDER_ENABLED;
    const off = build();
    expect(counterMeta(await collect(off.provider.streamChat(chatRequest())))).toBeUndefined();
    process.env.YSD_PROVIDER_ENABLED = "1";

    const unresolved = build();
    unresolved.deps.resolveDeployment = vi.fn(async () => ({
      ok: false,
      reason: "no_active_deployment",
    })) as unknown as typeof unresolved.deps.resolveDeployment;
    const p2 = new YSDProvider(unresolved.deps as unknown as Partial<YSDProviderDependencies>);
    expect(counterMeta(await collect(p2.streamChat(chatRequest())))).toBeUndefined();
  });

  it("★ (٤٠) ★★ وهدفٌ يرفضه الناقل قبل الاتصال ⇒ محاولةٌ بلا نداء", async () => {
    /**
     * ★ الحالة التي تجعل الرقم صادقًا لا تقريبيًّا.
     *
     * `invalid_target` رمزٌ يعني في عقد الناقل: رُفض الهدف **قبل أي
     * اتصال** — صفر `fetch`. فالمحاولة بدأت والنداء لم يخرج. ولو قلنا
     * `providerCalls: 1` هنا لَكنّا استبدلنا كذبًا بكذب.
     */
    const { provider } = build(
      (async function* () {
        yield { type: "error", reason: "invalid_target" } as YSDRuntimeChunk;
      }) as RuntimeStream,
    );
    const chunks = await collect(provider.streamChat(chatRequest()));
    const m = counterMeta(chunks);
    expect(m).toBeDefined();
    expect(m!.attemptCount).toBe(1);
    expect(m!.providerCalls).toBe(0);
  });

  it("★ (٤٠′) وأعطالُ الاتصال الأخرى ⇒ نداءٌ وقع فعلًا", async () => {
    for (const reason of ["network_error", "timeout", "unauthorized", "runtime_unavailable"] as const) {
      const { provider } = build(
        (async function* () {
          yield { type: "error", reason } as YSDRuntimeChunk;
        }) as RuntimeStream,
      );
      const m = counterMeta(await collect(provider.streamChat(chatRequest())));
      expect(m!.providerCalls, reason).toBe(1);
      expect(m!.attemptCount, reason).toBe(1);
    }
  });

  it("★ (٤١) ★ وإطار العدّاد لا يمسّ النسب ولا يعبر إلى المتصفّح", async () => {
    /**
     * لا يحمل `model` ولا نسبًا، فلا يُرسل إلى العميل (حارسه `chunk.model`)
     * ولا يُعدّ مجموعةً ثانية تُثير عَلَم التعارض.
     */
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    const m = counterMeta(chunks)!;
    expect(m.model).toBeUndefined();
    expect(m.modelVersion).toBeUndefined();
    expect(m.modelVersionId).toBeUndefined();
    expect(m.deploymentId).toBeUndefined();
    expect(m.deploymentEnvironment).toBeUndefined();

    // والنسب ما يزال في إطاره الأول كاملًا
    const prov = metasOf(chunks).find((c) => c.modelVersionId);
    expect(prov!.model).toBe(YSD_ALPHA_MODEL_ID);
    expect(prov!.modelVersion).toBe("1.4.2");
    expect(prov!.deploymentId).toBe(DEPLOYMENT_ID);
    expect(prov!.deploymentEnvironment).toBe("production");
    expect(prov!.providerCalls).toBeUndefined();
  });

  it("★ ولا سرَّ ولا هدفَ اتصالٍ في أي إطار meta", async () => {
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    const wire = JSON.stringify(metasOf(chunks));
    for (const leak of [RUNTIME_MODEL, ARTIFACT, ALIAS, BASE_URL, KEY, "base-a"]) {
      expect(wire, leak).not.toContain(leak);
    }
  });
});

/* ═══════════ (٢٩–٣٥) المصدر: مزوّد YSD وحده ═══════════ */

/**
 * ★ هذه الكتلة **تُنفَّذ**، لا تُقرأ.
 *
 * تُستخرج كتلة `meta` من مصدر المسار وتُحوَّل دالةً حقيقية. فالحرّاس النصّية
 * تثبت أن الشرط **مكتوب**؛ وهذه تثبت أنه **يعمل** — والفرق بينهما هو الفرق
 * بين مراجعةٍ وبين برهان.
 */
const META_FIELDS = [
  "actualModelId",
  "attemptCount",
  "chainOutcome",
  "answerMode",
  "regenerations",
  "emptyCompletions",
  "groundingSource",
  "protectedDetailBlocked",
  "shortCircuit",
  "providerCalls",
  "providerModelVersion",
  "providerModelVersionId",
  "providerDeploymentId",
  "providerDeploymentEnvironment",
  "providerTargetMetaConflict",
] as const;

function extractMetaBody(): string {
  const prefix = '} else if (chunk.type === "meta"';
  const at = ROUTE.indexOf(prefix);
  if (at < 0) throw new Error("تعذّر إيجاد فرع meta — حدّث المستخرِج ولا تحذف الحارس");
  const braceAt = ROUTE.indexOf("{", at + prefix.length);
  let i = braceAt + 1;
  let depth = 1;
  while (i < ROUTE.length && depth > 0) {
    const ch = ROUTE[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) throw new Error("قوس غير متوازن في فرع meta");
  return ROUTE.slice(braceAt + 1, i);
}

type MetaState = Record<(typeof META_FIELDS)[number], unknown>;

const runMeta = new Function(
  "chunk",
  "state",
  "send",
  "requestId",
  "providerFirstByteMs",
  "activeProviderId",
  "YSD_PROVIDER_ID",
  `let { ${META_FIELDS.join(", ")} } = state;
${extractMetaBody()}
return { ${META_FIELDS.join(", ")} };`,
) as unknown as (
  chunk: StreamChunk,
  state: MetaState,
  send: (m: unknown) => void,
  requestId: string,
  providerFirstByteMs: number,
  activeProviderId: string,
  ysdId: string,
) => MetaState;

const blankState = (): MetaState => ({
  actualModelId: null,
  attemptCount: 0,
  chainOutcome: "unknown",
  answerMode: "general",
  regenerations: 0,
  emptyCompletions: 0,
  groundingSource: "none",
  protectedDetailBlocked: false,
  shortCircuit: false,
  providerCalls: 0,
  providerModelVersion: null,
  providerModelVersionId: null,
  providerDeploymentId: null,
  providerDeploymentEnvironment: null,
  providerTargetMetaConflict: false,
});

/** إطار `meta` كامل النسب — كما يبثّه مزوّد YSD */
const fullMeta = (over: Partial<StreamChunk> = {}): StreamChunk => ({
  type: "meta",
  model: YSD_ALPHA_MODEL_ID,
  modelVersion: "1.4.2",
  modelVersionId: VERSION_ID,
  deploymentId: DEPLOYMENT_ID,
  deploymentEnvironment: "production",
  ...over,
});

/** يشغّل الكتلة الحقيقية ويُعيد الحالة وما أُرسل إلى المتصفّح */
function feed(providerId: string, ...frames: StreamChunk[]) {
  const sent: unknown[] = [];
  let state = blankState();
  for (const f of frames) {
    state = runMeta(f, state, (m) => sent.push(m), "rid", -1, providerId, YSD_PROVIDER_ID);
  }
  return { state, sent };
}

const NO_PROVENANCE = {
  providerModelVersion: null,
  providerModelVersionId: null,
  providerDeploymentId: null,
  providerDeploymentEnvironment: null,
  providerTargetMetaConflict: false,
};

const provenanceOf = (s: MetaState) => ({
  providerModelVersion: s.providerModelVersion,
  providerModelVersionId: s.providerModelVersionId,
  providerDeploymentId: s.providerDeploymentId,
  providerDeploymentEnvironment: s.providerDeploymentEnvironment,
  providerTargetMetaConflict: s.providerTargetMetaConflict,
});

describe("★ (٢٩–٣٥) النسب لمزوّد YSD وحده", () => {
  it("★ (٢٩) ★ مزوّد آخر بنسبٍ كامل الشكل ⇒ يُهمَل بالكامل", () => {
    /**
     * الحقول اختيارية في `StreamChunk`، فأيّ مزوّدٍ يقدر أن يملأها — والعقد
     * يسمح. وحينها يُنسب ردٌّ خارجيّ إلى نسخة YSD: صفٌّ صحيحٌ بنيويًّا لأن
     * معرّفاته تشير إلى نشرةٍ حقيقية، وكاذبٌ معنًى. والقيد في القاعدة لا
     * يراه — فالمصدر لا يُعرف إلا هنا.
     */
    const { state } = feed("openrouter", fullMeta({ model: "meta-llama/llama-3" }));
    expect(provenanceOf(state)).toEqual(NO_PROVENANCE);
  });

  it("★ (٣٠) وكذلك كل مزوّدٍ غير YSD — والمطابقة تامّة لا تقريبية", () => {
    for (const id of ["openrouter", "groq", "anthropic", "ysd-free", "YSD", "ysd "]) {
      const { state } = feed(id, fullMeta());
      expect(provenanceOf(state), id).toEqual(NO_PROVENANCE);
    }
  });

  it("★ (٣١) ومجموعتان مختلفتان من مزوّدٍ آخر لا ترفعان عَلَم التعارض", () => {
    const { state } = feed(
      "openrouter",
      fullMeta(),
      fullMeta({ modelVersionId: OTHER_VERSION_ID, modelVersion: "9.9.9" }),
    );
    expect(state.providerTargetMetaConflict).toBe(false);
    expect(state.providerModelVersion).toBeNull();
  });

  it("★ (٣٢) ومزوّد YSD بنسبٍ كامل ⇒ يُلتقط كما كان", () => {
    const { state } = feed(YSD_PROVIDER_ID, fullMeta());
    expect(provenanceOf(state)).toEqual({
      providerModelVersion: "1.4.2",
      providerModelVersionId: VERSION_ID,
      providerDeploymentId: DEPLOYMENT_ID,
      providerDeploymentEnvironment: "production",
      providerTargetMetaConflict: false,
    });
  });

  it("★ (٣٣) ونسبه الناقص أو الفاسد يبقى مُهمَلًا كما كان", () => {
    const partials: Partial<StreamChunk>[] = [
      { modelVersion: undefined },
      { modelVersionId: undefined },
      { deploymentId: undefined },
      { deploymentEnvironment: undefined },
      { modelVersion: "   " },
      { modelVersionId: "" },
      { deploymentEnvironment: "canary" as StreamChunk["deploymentEnvironment"] },
    ];
    for (const over of partials) {
      const { state } = feed(YSD_PROVIDER_ID, fullMeta(over));
      expect(provenanceOf(state), JSON.stringify(over)).toEqual(NO_PROVENANCE);
    }
  });

  it("★ (٣٣′) وتعارضه الحقيقيّ ما يزال يُرفع عَلَمًا، والأولى تفوز", () => {
    const { state } = feed(
      YSD_PROVIDER_ID,
      fullMeta(),
      fullMeta({ modelVersionId: OTHER_VERSION_ID, modelVersion: "9.9.9" }),
    );
    expect(state.providerModelVersionId).toBe(VERSION_ID);
    expect(state.providerModelVersion).toBe("1.4.2");
    expect(state.providerTargetMetaConflict).toBe(true);
  });

  it("★ (٣٤) ★ وما يعبر إلى المتصفّح هو المعرّف وحده — للمزوّدين جميعًا", () => {
    for (const id of ["openrouter", YSD_PROVIDER_ID]) {
      const { sent } = feed(id, fullMeta());
      expect(sent, id).toEqual([{ type: "meta", model: YSD_ALPHA_MODEL_ID }]);
      const wire = JSON.stringify(sent);
      for (const leak of [VERSION_ID, DEPLOYMENT_ID, "1.4.2", "production"]) {
        expect(wire, `${id}/${leak}`).not.toContain(leak);
      }
    }
  });

  it("★ (٣٥) ولا معرّف ولا رقم نسخة في أي سجلّ نصّيّ", () => {
    const logs: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((m) => logs.push(String(m)));
    const log = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    feed(YSD_PROVIDER_ID, fullMeta(), fullMeta({ modelVersionId: OTHER_VERSION_ID }));
    feed("openrouter", fullMeta());
    err.mockRestore();
    log.mockRestore();
    for (const line of logs) {
      for (const leak of [VERSION_ID, DEPLOYMENT_ID, "1.4.2"]) {
        expect(line, leak).not.toContain(leak);
      }
    }
  });

  it("★ والقيَم المحفوظة لاحقًا مشتقّة من هذه الحالة وحدها", () => {
    /**
     * `model_version` والحدث الدائم يُشتقّان من `providerModelVersion*`
     * حصرًا — فبقاؤها `null` لمزوّدٍ آخر يعني ألّا يُحفظ شيء. والحارسان
     * أدناه يمنعان مسارًا ثانيًا يتجاوزها.
     */
    expect(ROUTE).toContain(
      "if (providerModelVersion !== null) meta.model_version = providerModelVersion;",
    );
    expect(ROUTE).toContain("ysdModelVersionId: providerModelVersionId,");
    const code = ROUTE.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(code).not.toContain("meta.model_version = chunk.");
    expect(code).not.toContain("ysdModelVersionId: chunk.");
  });

  it("★ والشرط مكتوبٌ بالثابت لا بنصٍّ سحريّ", () => {
    expect(ROUTE).toContain("activeProviderId === YSD_PROVIDER_ID &&");
    expect(ROUTE).toContain('import { YSD_PROVIDER_ID } from "@/lib/ai/ysd";');
    expect(YSD_PROVIDER_ID).toBe("ysd");
    // ولا يدخل المسارَ شيءٌ من السجلّ ولا من ناقل وقت التشغيل
    for (const forbidden of ["model-registry", "ysd-runtime-client", "ysd-runtime-config"]) {
      expect(ROUTE, forbidden).not.toContain(forbidden);
    }
  });
});

/* ═══════════ لا تفعيل ═══════════ */

describe("★ الرقعة لا تفعّل شيئًا", () => {
  it("★ model-alpha معطَّلٌ ما لم يُؤذَن صراحةً", () => {
    /**
     * ★ حُدِّث في الرقعة الثامنة.
     *
     * كان `false` ثابتًا لأن الرقعات السابقة لم تملك ما تأذن به. والثابت
     * الذي كان يحرسه هذا الاختبار ما يزال قائمًا: **اكتمالُ الجاهزية لا
     * يفتح النموذج**. فيُقاس الآن بإغلاق مفتاح الإذن صراحةً.
     */
    delete process.env.YSD_MODEL_ALPHA_ENABLED;
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
