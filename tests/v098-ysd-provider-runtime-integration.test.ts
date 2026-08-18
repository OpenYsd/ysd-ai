/**
 * توصيل مزوّد YSD بالسجلّ ووقت التشغيل (v0.9.3، الرقعة الخامسة).
 *
 * ── توصيلٌ لا تفعيل ──
 *
 * المسار صار حقيقيًّا من طرفه إلى طرفه، و`ysd/model-alpha` ما يزال
 * `enabled: false`. فيُختبر الأنبوب كاملًا قبل أن يُفتح الصنبور.
 *
 * ── وما يُقاس هنا ──
 *
 * أن الترتيب محفوظ (لا قاعدة قبل الجاهزية، ولا وقت تشغيل قبل الحلّال)،
 * وأن **لا شيء تشغيليّ يتسرّب** إلى المستخدم: لا معرّف نتاج ولا عنوان ولا
 * مفتاح ولا سبب داخليّ. والاعتمادات محقونة كلها، فلا شبكة ولا قاعدة.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { YSDProvider, YSD_ALPHA_MODEL_ID, type YSDProviderDependencies } from "@/lib/ai/ysd";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";
import type { ChatRequest, StreamChunk } from "@/lib/ai/types";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";
import type { YSDRuntimeChunk, YSDRuntimeFailureReason } from "@/lib/ai/ysd-runtime-client";
import type { ServableDeploymentResolution } from "@/lib/ai/model-registry-resolver";

const SRC = readFileSync("lib/ai/ysd.ts", "utf8");

const KEY = "sk-ysd-runtime-secret-never-leak";
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
  id: "d-1",
  modelId: YSD_ALPHA_MODEL_ID,
  modelVersionId: "v-1",
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
  id: "v-1",
  modelId: YSD_ALPHA_MODEL_ID,
  version: "1.0.0",
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

const jsonInput = (over: Record<string, unknown> = {}) => ({
  systemPrompt: "تعليمات",
  userText: "سؤال",
  maxTokens: 700,
  timeoutMs: 8_000,
  ...over,
});

/* ───────── اعتمادات محقونة، وكلها مُراقَبة ───────── */

interface Spies {
  readRuntimeConfig: ReturnType<typeof vi.fn>;
  hasRegistryAccess: ReturnType<typeof vi.fn>;
  getAdminClient: ReturnType<typeof vi.fn>;
  resolveDeployment: ReturnType<typeof vi.fn>;
  streamRuntimeChat: ReturnType<typeof vi.fn>;
  requestRuntimeJsonCompletion: ReturnType<typeof vi.fn>;
}

const okResolution = (): ServableDeploymentResolution => ({
  ok: true,
  deployment: deployment(),
  version: version(),
});

function build(over: Partial<Record<keyof Spies, unknown>> = {}) {
  const spies: Spies = {
    readRuntimeConfig: vi.fn(() => ({ ok: true, config: runtimeConfig })),
    hasRegistryAccess: vi.fn(() => true),
    getAdminClient: vi.fn(() => ({ from: () => ({}) })),
    resolveDeployment: vi.fn(async () => okResolution()),
    streamRuntimeChat: vi.fn(async function* () {
      yield { type: "done" } as YSDRuntimeChunk;
    }),
    requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: true, text: "{}" })),
  };
  for (const [k, v] of Object.entries(over)) {
    (spies as unknown as Record<string, unknown>)[k] = v;
  }
  const provider = new YSDProvider(spies as unknown as Partial<YSDProviderDependencies>);
  return { provider, spies };
}

const collect = async (gen: AsyncGenerator<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
};

const runtimeError = (reason: YSDRuntimeFailureReason) =>
  vi.fn(async function* () {
    yield { type: "error", reason } as YSDRuntimeChunk;
  });

const original = process.env.YSD_PROVIDER_ENABLED;
beforeEach(() => {
  process.env.YSD_PROVIDER_ENABLED = "1";
});
afterEach(() => {
  if (original === undefined) delete process.env.YSD_PROVIDER_ENABLED;
  else process.env.YSD_PROVIDER_ENABLED = original;
});

/* ═══════════ (١–٦) الجاهزية ═══════════ */

describe("★ (١–٦) الجاهزية ثلاثة شروط", () => {
  it("★ (١) العَلَم مغلق ⇒ false", () => {
    delete process.env.YSD_PROVIDER_ENABLED;
    expect(build().provider.isConfigured()).toBe(false);
  });

  it("★ (٢) العَلَم مفتوح وإعداد وقت التشغيل فاشل ⇒ false", () => {
    const { provider } = build({
      readRuntimeConfig: vi.fn(() => ({ ok: false, reason: "disabled" })),
    });
    expect(provider.isConfigured()).toBe(false);
  });

  it("★ (٣) والسجلّ غير متاح ⇒ false", () => {
    const { provider } = build({ hasRegistryAccess: vi.fn(() => false) });
    expect(provider.isConfigured()).toBe(false);
  });

  it("★ (٤) الثلاثة مكتملة ⇒ true", () => {
    expect(build().provider.isConfigured()).toBe(true);
  });

  it("★ (٥) ولا قاعدة ولا حلّال ولا وقت تشغيل داخل isConfigured", () => {
    const { provider, spies } = build();
    provider.isConfigured();
    expect(spies.getAdminClient).not.toHaveBeenCalled();
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
    expect(spies.streamRuntimeChat).not.toHaveBeenCalled();
    expect(spies.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٦) والنموذج ما يزال معطَّلًا مهما اكتملت الجاهزية", () => {
    const { provider } = build();
    expect(provider.isConfigured()).toBe(true);
    const models = provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe(YSD_ALPHA_MODEL_ID);
    expect(models[0]!.enabled).toBe(false); // ★ توصيلٌ لا تفعيل
  });
});

/* ═══════════ (٧–١٤) البوابات قبل الاتصال ═══════════ */

describe("★ (٧–١٤) لا خطوة قبل ما يسبقها", () => {
  const expectGenericError = (chunks: StreamChunk[]) => {
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      type: "error",
      error: ERROR_MESSAGES.provider_unavailable,
      errorCode: "provider_unavailable",
    });
  };

  it("★ (٧) نموذج غير مملوك ⇒ خطأ عامّ بلا حلّال ولا وقت تشغيل", async () => {
    const { provider, spies } = build();
    const chunks = await collect(provider.streamChat(chatRequest({ modelId: "ysd/other" })));
    expectGenericError(chunks);
    expect(spies.getAdminClient).not.toHaveBeenCalled();
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
    expect(spies.streamRuntimeChat).not.toHaveBeenCalled();
  });

  it("★ (٨) إلغاء مسبق ⇒ صفر إطارات وصفر كل شيء", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, spies } = build();
    const chunks = await collect(provider.streamChat(chatRequest({ signal: ac.signal })));
    expect(chunks).toHaveLength(0);
    expect(spies.readRuntimeConfig).not.toHaveBeenCalled();
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
    expect(spies.streamRuntimeChat).not.toHaveBeenCalled();
  });

  it("★ (٩) إعداد وقت التشغيل فاشل ⇒ لا حلّال", async () => {
    const { provider, spies } = build({
      readRuntimeConfig: vi.fn(() => ({ ok: false, reason: "missing_api_key" })),
    });
    expectGenericError(await collect(provider.streamChat(chatRequest())));
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
    expect(spies.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ (١٠) السجلّ غير متاح ⇒ لا عميل ولا حلّال", async () => {
    const { provider, spies } = build({ hasRegistryAccess: vi.fn(() => false) });
    expectGenericError(await collect(provider.streamChat(chatRequest())));
    expect(spies.getAdminClient).not.toHaveBeenCalled();
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
  });

  it("★ (١١) العميل الإداريّ null ⇒ خطأ عامّ بلا حلّال", async () => {
    const { provider, spies } = build({ getAdminClient: vi.fn(() => null) });
    expectGenericError(await collect(provider.streamChat(chatRequest())));
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
  });

  it("★ (١٢) العميل الإداريّ يرمي ⇒ خطأ عامّ بلا أثر من الاستثناء", async () => {
    const { provider } = build({
      getAdminClient: vi.fn(() => {
        throw new Error("service role misconfigured: sk-leak-me");
      }),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expectGenericError(chunks);
    expect(JSON.stringify(chunks)).not.toContain("sk-leak-me");
    expect(JSON.stringify(chunks)).not.toContain("misconfigured");
  });

  it("★ (١٣) كل أسباب الحلّال ⇒ خطأ عامّ واحد بلا وقت تشغيل", async () => {
    const reasons = [
      "invalid_input",
      "registry_error",
      "no_active_deployment",
      "ambiguous_active_deployment",
      "version_not_found",
      "invalid_record",
      "not_servable",
    ] as const;

    for (const reason of reasons) {
      const { provider, spies } = build({
        resolveDeployment: vi.fn(async () => ({ ok: false, reason })),
      });
      const chunks = await collect(provider.streamChat(chatRequest()));
      expectGenericError(chunks);
      // ★ السبب الداخليّ لا يظهر — المستخدم لا يعنيه أين تعثّر المسار
      expect(JSON.stringify(chunks), reason).not.toContain(reason);
      expect(spies.streamRuntimeChat, reason).not.toHaveBeenCalled();
    }
  });

  it("★ (١٤) الحلّال يرمي ⇒ خطأ عامّ بلا أثر", async () => {
    const { provider, spies } = build({
      resolveDeployment: vi.fn(async () => {
        throw new Error("pg: relation does not exist");
      }),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expectGenericError(chunks);
    expect(JSON.stringify(chunks)).not.toContain("relation");
    expect(spies.streamRuntimeChat).not.toHaveBeenCalled();
  });
});

/* ═══════════ (١٥–١٩) التمرير والتسريب ═══════════ */

describe("★ (١٥–١٩) ما يُمرَّر وما لا يخرج", () => {
  it("★ (١٥) الحلّال يُستدعى بالمعرّف المنطقيّ وبيئة الإعداد", async () => {
    const { provider, spies } = build();
    await collect(provider.streamChat(chatRequest()));
    expect(spies.resolveDeployment).toHaveBeenCalledTimes(1);
    const [, modelId, environment] = spies.resolveDeployment.mock.calls[0]!;
    expect(modelId).toBe(YSD_ALPHA_MODEL_ID);
    expect(environment).toBe(runtimeConfig.deploymentEnvironment);
  });

  it("★ (١٦) إلغاء أثناء استعلام السجلّ ⇒ وقت التشغيل لا يبدأ", async () => {
    const ac = new AbortController();
    const { provider, spies } = build({
      resolveDeployment: vi.fn(async () => {
        ac.abort(); // المستخدم انصرف بينما نستعلم
        return okResolution();
      }),
    });
    const chunks = await collect(provider.streamChat(chatRequest({ signal: ac.signal })));
    expect(spies.streamRuntimeChat).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0); // ولا حتى إطار meta
  });

  it("★ (١٧) وقت التشغيل يتلقّى الإعداد والنشرة والنسخة والطلب بأعيانها", async () => {
    const req = chatRequest({ systemPrompt: "تعليمات", maxTokens: 123 });
    const { provider, spies } = build();
    await collect(provider.streamChat(req));

    const [cfg, dep, ver, passedReq] = spies.streamRuntimeChat.mock.calls[0]!;
    expect(cfg).toEqual(runtimeConfig);
    expect(dep).toEqual(deployment());
    expect(ver).toEqual(version());
    expect(passedReq).toBe(req); // المرجع نفسه لا نسخة
  });

  it("★ (١٨) meta يحمل المعرّف المنطقيّ لا معرّف وقت التشغيل", async () => {
    const { provider } = build();
    const chunks = await collect(provider.streamChat(chatRequest()));
    const meta = chunks.find((c) => c.type === "meta");
    expect(meta?.model).toBe(YSD_ALPHA_MODEL_ID);
    expect(meta?.model).not.toBe(RUNTIME_MODEL);
    expect(RUNTIME_MODEL).not.toBe(YSD_ALPHA_MODEL_ID); // الاختبار ليس خاويًا
    // ★ ونسبُ الهدف يخرج معها (v0.9.3) — انظر v099 لتفصيله
    expect(meta?.modelVersion).toBe("1.0.0");
  });

  it("★ (١٩) ولا تفصيل تشغيليّ في أي إطار", async () => {
    const { provider } = build({
      streamRuntimeChat: vi.fn(async function* () {
        yield { type: "text", text: "جواب" } as YSDRuntimeChunk;
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } } as YSDRuntimeChunk;
        yield { type: "done" } as YSDRuntimeChunk;
      }),
    });
    const serialized = JSON.stringify(await collect(provider.streamChat(chatRequest())));
    /**
     * ★ أهداف الاتصال والأسرار لا تخرج أبدًا.
     *
     * ومعرّفا النشرة والنسخة (`d-1` · `v-1`) يخرجان مع `meta` منذ v0.9.3
     * — لكنهما **لا يعبران إلى المتصفّح**: المسار يلتقطهما ويُبقيهما للرصد
     * الإداريّ. وحدّ العميل محروسٌ في v099 على `route.ts` نفسه.
     */
    for (const secret of [RUNTIME_MODEL, ARTIFACT, ALIAS, BASE_URL, KEY]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });
});

/* ═══════════ (٢٠–٣٢) تحويل البثّ ═══════════ */

describe("★ (٢٠–٣٢) تحويل إطارات وقت التشغيل", () => {
  const streamOf = (chunks: YSDRuntimeChunk[]) =>
    vi.fn(async function* () {
      for (const c of chunks) yield c;
    });

  it("★ (٢٠) النصّ يمرّ كما هو", async () => {
    const { provider } = build({
      streamRuntimeChat: streamOf([{ type: "text", text: "أ" }, { type: "done" }]),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks.filter((c) => c.type === "text")).toEqual([{ type: "text", text: "أ" }]);
  });

  it("★ (٢١) والاستهلاك كذلك", async () => {
    const usage = { inputTokens: 11, outputTokens: 22 };
    const { provider } = build({
      streamRuntimeChat: streamOf([{ type: "usage", usage }, { type: "done" }]),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks.find((c) => c.type === "usage")).toEqual({ type: "usage", usage });
  });

  it("★ (٢٢) والانتهاء الطبيعيّ", async () => {
    const { provider } = build({ streamRuntimeChat: streamOf([{ type: "done" }]) });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks[chunks.length - 1]).toEqual({ type: "done" });
  });

  it("★ (٢٣) والردّ الناقص بوسمه", async () => {
    const { provider } = build({
      streamRuntimeChat: streamOf([
        { type: "text", text: "أ" },
        { type: "done", completion: "incomplete_provider", completionReason: "stream_interrupted" },
      ]),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks[chunks.length - 1]).toEqual({
      type: "done",
      completion: "incomplete_provider",
      completionReason: "stream_interrupted",
    });
  });

  const mapping: [YSDRuntimeFailureReason, string][] = [
    ["rate_limit", "rate_limit"],
    ["timeout", "timeout"],
    ["network_error", "network_error"],
    ["unauthorized", "provider_unavailable"],
    ["runtime_unavailable", "provider_unavailable"],
    ["invalid_response", "provider_unavailable"],
    ["stream_error", "provider_unavailable"],
    ["invalid_target", "provider_unavailable"],
  ];

  for (const [reason, code] of mapping) {
    it(`★ (٢٤–٣٠) ${reason} ⇒ ${code}`, async () => {
      const { provider } = build({ streamRuntimeChat: runtimeError(reason) });
      const chunks = await collect(provider.streamChat(chatRequest()));
      const err = chunks.find((c) => c.type === "error");
      expect(err?.errorCode, reason).toBe(code);
      // الرسالة من المصدر المركزيّ
      expect(err?.error, reason).toBe(ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]);
      /**
       * ولا يظهر السبب الداخليّ — إلا حين يكون اسمه هو الرمز العامّ نفسه
       * (`rate_limit` · `timeout` · `network_error`)، فذاك ظهورُ الرمز لا
       * تسريبُ السبب. والفحص يقتصر على ما يختلف اسمه فعلًا.
       */
      if (reason !== code) {
        expect(JSON.stringify(chunks), reason).not.toContain(reason);
      }
    });
  }

  it("★ (٣١) الإلغاء لا يُنتج إطار خطأ للمستخدم", async () => {
    const { provider } = build({ streamRuntimeChat: runtimeError("aborted") });
    const chunks = await collect(provider.streamChat(chatRequest()));
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    // meta وحده خرج قبل الإلغاء — ولا إطار طرفيّ مصطنع بعده
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("meta");
    expect(chunks[0]!.model).toBe(YSD_ALPHA_MODEL_ID);
  });

  it("★ (٣٢) استثناء غير متوقّع من الناقل ⇒ خطأ عامّ بلا أثر", async () => {
    const { provider } = build({
      streamRuntimeChat: vi.fn(async function* () {
        yield { type: "text", text: "أ" } as YSDRuntimeChunk;
        throw new Error("runtime exploded at https://runtime.internal.example/v1");
      }),
    });
    const chunks = await collect(provider.streamChat(chatRequest()));
    const err = chunks.find((c) => c.type === "error");
    expect(err?.errorCode).toBe("provider_unavailable");
    expect(JSON.stringify(chunks)).not.toContain("exploded");
    expect(JSON.stringify(chunks)).not.toContain(BASE_URL);
  });
});

/* ═══════════ (٣٣–٤٢) نداء JSON ═══════════ */

describe("★ (٣٣–٤٢) استرداد JSON", () => {
  it("★ (٣٣) إلغاء مسبق ⇒ error بصفر حلّال ووقت تشغيل", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, spies } = build();
    const r = await provider.requestJsonCompletion(jsonInput({ signal: ac.signal }));
    expect(r).toEqual({ ok: false, reason: "error" });
    expect(spies.resolveDeployment).not.toHaveBeenCalled();
    expect(spies.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٣٤)(٣٥) يحلّ بمعرّف ألفا وبيئة الإعداد", async () => {
    const { provider, spies } = build();
    await provider.requestJsonCompletion(jsonInput());
    const [, modelId, environment] = spies.resolveDeployment.mock.calls[0]!;
    expect(modelId).toBe(YSD_ALPHA_MODEL_ID);
    expect(environment).toBe(runtimeConfig.deploymentEnvironment);
  });

  it("★ (٣٦) فشل الحلّال ⇒ error بلا وقت تشغيل", async () => {
    const { provider, spies } = build({
      resolveDeployment: vi.fn(async () => ({ ok: false, reason: "not_servable" })),
    });
    const r = await provider.requestJsonCompletion(jsonInput());
    expect(r).toEqual({ ok: false, reason: "error" });
    expect(spies.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٣٧) النجاح يمرّ نصًّا", async () => {
    const { provider } = build({
      requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: true, text: '{"links":[]}' })),
    });
    expect(await provider.requestJsonCompletion(jsonInput())).toEqual({
      ok: true,
      text: '{"links":[]}',
    });
  });

  it("★ (٣٨) المهلة تبقى timeout", async () => {
    const { provider } = build({
      requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: false, reason: "timeout" })),
    });
    expect(await provider.requestJsonCompletion(jsonInput())).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("★ (٣٩)(٤٠) الإلغاء وبقيّة الأسباب ⇒ error", async () => {
    const reasons: YSDRuntimeFailureReason[] = [
      "aborted",
      "unauthorized",
      "rate_limit",
      "network_error",
      "runtime_unavailable",
      "invalid_response",
      "stream_error",
      "invalid_target",
    ];
    for (const reason of reasons) {
      const { provider } = build({
        requestRuntimeJsonCompletion: vi.fn(async () => ({ ok: false, reason })),
      });
      const r = await provider.requestJsonCompletion(jsonInput());
      expect(r, reason).toEqual({ ok: false, reason: "error" });
      expect(JSON.stringify(r), reason).not.toContain(reason);
    }
  });

  it("★ (٤١) استثناء غير متوقّع ⇒ error بلا أثر", async () => {
    const { provider } = build({
      requestRuntimeJsonCompletion: vi.fn(async () => {
        throw new Error(`boom ${KEY}`);
      }),
    });
    const r = await provider.requestJsonCompletion(jsonInput());
    expect(r).toEqual({ ok: false, reason: "error" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("★ (٤٢) والمدخل يصل كما هو", async () => {
    const input = jsonInput({ maxTokens: 321, timeoutMs: 4_321 });
    const { provider, spies } = build();
    await provider.requestJsonCompletion(input);
    const [cfg, dep, ver, passed] = spies.requestRuntimeJsonCompletion.mock.calls[0]!;
    expect(cfg).toEqual(runtimeConfig);
    expect(dep).toEqual(deployment());
    expect(ver).toEqual(version());
    expect(passed).toBe(input);
  });
});

/* ═══════════ (٤٣–٥٣) حرّاس ثابتة ═══════════ */

describe("★ (٤٣–٥٣) حدود الملفّ", () => {
  it("★ (٤٣) خادميّ فقط", () => {
    expect(SRC.startsWith('import "server-only";')).toBe(true);
  });

  it("★ (٤٤) ولا نداء شبكيّ مباشر", () => {
    for (const bad of ["fetch(", "XMLHttpRequest"]) {
      expect(SRC, bad).not.toContain(bad);
    }
  });

  it("★ (٤٥) ولا استعلام قاعدة مباشر — كل وصولٍ عبر الحلّال", () => {
    expect(SRC).not.toContain(".from(");
    expect(SRC).not.toContain(".select(");
    expect(SRC).not.toContain(".eq(");
  });

  it("★ (٤٦)(٤٧) ولا عنوان ثابت ولا مفتاح", () => {
    for (const bad of ["http://", "https://", "Bearer", "sk-"]) {
      expect(SRC, bad).not.toContain(bad);
    }
  });

  it("★ (٤٨)(٤٩) وسياستا العبور محفوظتان", () => {
    expect(SRC).toContain('readonly fallbackPolicy = "none" as const;');
    expect(SRC).toContain("readonly fallbackEligible = false;");
    const { provider } = build();
    expect(provider.fallbackPolicy).toBe("none");
    expect(provider.fallbackEligible).toBe(false);
  });

  it("★ (٥٠) وysd/free ما يزال لـOpenRouter", async () => {
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
    expect(build().provider.listModels().some((m) => m.id === "ysd/free")).toBe(false);
  });

  it("★ (٥١)(٥٢)(٥٣) ولا مسار ولا سياسة نماذج ولا سجلّ مزوّدين يعرف YSD الجديد", () => {
    const route = readFileSync("app/api/chat/route.ts", "utf8");
    const policy = readFileSync("lib/ai/model-policy.ts", "utf8");
    for (const [name, src] of [["route", route], ["policy", policy]] as const) {
      expect(src, name).not.toContain("ysd-runtime");
      expect(src, name).not.toContain("model-registry-resolver");
      expect(src, name).not.toContain("YSDProvider");
    }
    // والسجلّ يسجّله كما كان بلا اعتمادات
    const registry = readFileSync("lib/ai/registry.ts", "utf8");
    expect(registry).toContain("new YSDProvider(),");
  });

  it("★ ولا healthCheck يدّعي اتصالًا", () => {
    expect("healthCheck" in build().provider).toBe(false);
  });
});
