/**
 * اختبار التوليد الاصطناعيّ قبل الفتح العامّ (v0.9.3، الرقعة الثانية عشرة).
 *
 * ── الفجوة التي يسدّها ──
 *
 * الرقعة الحادية عشرة أثبتت السلسلة حتى `GET /models`. ولم تُثبت أن
 * **التوليد نفسه يعمل**. وقائمةُ النماذج تُقرأ من الذاكرة؛ أما التوليد
 * فيحمّل الأوزان ويحجز ذاكرةً ويشتغل. ووقتُ تشغيلٍ يسرد نموذجه ثم يفشل
 * عند أول `chat/completions` حالةٌ واقعية — فيُفتح المفتاح على قائمةٍ
 * صادقة وخدمةٍ معطوبة.
 *
 * ── وما يحرسه هذا الملفّ ──
 *
 * أن يبقى الاختبار اختبارًا: مدخلٌ ثابت لا يمسّه طلب، وتطابقٌ تامّ لا
 * يقبل «ردًّا غير فارغ»، ونصٌّ مولَّد لا يخرج ولا يُسجَّل — **ولا حتى
 * عند الفشل**. وأن ينتهي كل ذلك والمفتاح مغلق.
 *
 * ولا شبكة ولا قاعدة هنا: كل شيء بالحقن.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { checkYSDPreActivationSmoke } from "@/lib/ai/ysd-smoke-test";
import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";
import type { YSDRuntimeJsonResult } from "@/lib/ai/ysd-runtime-client";
import type { ModelDeploymentRecord, ModelVersionRecord } from "@/lib/ai/model-registry";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

const SMOKE_SRC = readSrc("lib/ai/ysd-smoke-test.ts");
const ROUTE_SRC = readSrc("app/api/admin/ysd/smoke/route.ts");
const ENV_EXAMPLE = readSrc(".env.example");

const MARKER = "YSD_SMOKE_OK";
const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret";
const RUNTIME_MODEL = "ysd-alpha-2026-01";
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

const READY = { ok: true, ready: true, publiclyEnabled: false } as const;

/** يبني المشهد ويكشف كل جاسوس — فيُقاس الترتيب سلوكًا */
function scenario(
  over: {
    isOwner?: boolean;
    readiness?: unknown;
    readinessThrows?: boolean;
    config?: unknown;
    configThrows?: boolean;
    adminClient?: unknown;
    adminThrows?: boolean;
    resolution?: unknown;
    resolverThrows?: boolean;
    runtime?: YSDRuntimeJsonResult;
    runtimeThrows?: boolean;
    clock?: number[];
  } = {},
) {
  const order: string[] = [];
  const adminClient = { __admin: true };

  const checkPublicReadiness = vi.fn(async () => {
    order.push("readiness");
    if (over.readinessThrows) throw new Error(`readiness broke: ${KEY}`);
    return (over.readiness ?? READY) as typeof READY;
  });

  const readRuntimeConfig = vi.fn(() => {
    order.push("config");
    if (over.configThrows) throw new Error(`config broke: ${BASE_URL} key=${KEY}`);
    return (over.config ?? { ok: true, config: runtimeConfig }) as {
      ok: true;
      config: typeof runtimeConfig;
    };
  });

  const getAdminClient = vi.fn(() => {
    order.push("admin");
    if (over.adminThrows) throw new Error(`SERVICE_ROLE=${KEY}`);
    return over.adminClient === undefined ? adminClient : over.adminClient;
  });

  const resolveDeployment = vi.fn(async () => {
    order.push("resolver");
    if (over.resolverThrows) throw new Error(`registry broke: ${DEPLOYMENT_ID}`);
    return (over.resolution ?? { ok: true, deployment, version }) as {
      ok: true;
      deployment: ModelDeploymentRecord;
      version: ModelVersionRecord;
    };
  });

  const requestRuntimeJsonCompletion = vi.fn(async () => {
    order.push("generation");
    if (over.runtimeThrows) throw new Error(`runtime broke at ${BASE_URL}`);
    return over.runtime ?? ({ ok: true, text: MARKER } as YSDRuntimeJsonResult);
  });

  const ticks = over.clock ?? [1_000, 1_120];
  let i = 0;
  const now = vi.fn(() => ticks[Math.min(i++, ticks.length - 1)]!);

  const deps = {
    checkPublicReadiness,
    readRuntimeConfig,
    getAdminClient,
    resolveDeployment,
    requestRuntimeJsonCompletion,
    now,
  };

  return {
    order,
    deps,
    run: () =>
      checkYSDPreActivationSmoke(
        over.isOwner ?? true,
        deps as unknown as Parameters<typeof checkYSDPreActivationSmoke>[1],
      ),
  };
}

const reasonOf = (r: Awaited<ReturnType<typeof checkYSDPreActivationSmoke>>) =>
  r.ok ? null : r.reason;

/* ═══════════ (١–٣) قبل أي توليد ═══════════ */

describe("★ (١–٣) ما يُرفض قبل أن يُستهلك شيء", () => {
  it("★ (١) ★ غير المالك ⇒ رفض بصفر جاهزيةٍ وصفر توليد", async () => {
    const s = scenario({ isOwner: false });
    expect(reasonOf(await s.run())).toBe("owner_required");
    expect(s.deps.checkPublicReadiness).not.toHaveBeenCalled();
    expect(s.deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
    expect(s.order).toEqual([]);
  });

  it("★ (٢) ★ والجاهزية فاشلة ⇒ not_ready بصفر سجلٍّ وصفر توليد", async () => {
    const s = scenario({
      readiness: { ok: false, ready: false, reason: "model_gate_off" },
    });
    expect(reasonOf(await s.run())).toBe("not_ready");
    expect(s.deps.getAdminClient).not.toHaveBeenCalled();
    expect(s.deps.resolveDeployment).not.toHaveBeenCalled();
    expect(s.deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٢′) والجاهزية التي ترمي ⇒ رفضٌ آمن بلا نصّ", async () => {
    const s = scenario({ readinessThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("internal_error");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("★ (٣) ★ وجاهزيةٌ تخالف عقدها ⇒ فشل مغلق", async () => {
    /**
     * عقد تلك الدالة أن يكون `publiclyEnabled === false` دائمًا. فمخالفتُه
     * تعني أن شيئًا لم نعد نفهمه — والتوليد على فهمٍ مهزوز أسوأ من
     * الامتناع.
     */
    const broken = [
      { ok: true, ready: true, publiclyEnabled: true },
      { ok: true, ready: false, publiclyEnabled: false },
      { ok: false, ready: true, publiclyEnabled: false },
      { ok: true, publiclyEnabled: false },
    ];
    for (const readiness of broken) {
      const s = scenario({ readiness });
      expect(reasonOf(await s.run()), JSON.stringify(readiness)).toBe("not_ready");
      expect(s.deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
    }
  });

  it("★ ★ ولا يُكرَّر منطق الجاهزية هنا", () => {
    /**
     * مصدر الحقيقة واحد. ومحرّكان يحسبان القاعدة نفسها يفترقان صامتًا —
     * يُصلَح أحدهما ويبقى الآخر يقول القديم.
     */
    const code = stripComments(SMOKE_SRC);
    for (const forbidden of [
      "isYSDAlphaActivationEnabled",
      "allowed_models",
      "AI_SETTING_KEYS",
      "platform_settings",
      "healthCheck",
      "getConfiguredProviders",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("d.checkPublicReadiness(isOwner)");
  });
});

/* ═══════════ (٤–٩) الهدف ═══════════ */

describe("★ (٤–٩) الهدف من الخادم والسجلّ", () => {
  it("★ (٤) إعداد وقت تشغيلٍ ناقص ⇒ target_unavailable بلا توليد", async () => {
    const s = scenario({ config: { ok: false, reason: "missing_base_url" } });
    expect(reasonOf(await s.run())).toBe("target_unavailable");
    expect(s.deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
  });

  it("★ (٤′) ★★ وقراءةٌ ترمي ⇒ internal_error لا target_unavailable", async () => {
    /**
     * ★ التمييز مقصود.
     *
     * `{ok:false}` جوابٌ متوقَّع يقول «الإعداد ناقص»، فيدلّ المشغّل على
     * البيئة. أما الاستثناء فيقول «شيءٌ في برنامجنا انكسر»، وإلباسُه ثوبَ
     * نقصِ إعدادٍ يرسله يفتّش متغيّراتٍ سليمة.
     */
    const s = scenario({ configThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("internal_error");

    // ولا سرَّ ولا عنوان من نصّ الاستثناء
    const dump = JSON.stringify(res);
    for (const leak of [BASE_URL, KEY, "config broke"]) {
      expect(dump, leak).not.toContain(leak);
    }

    // وصفر ما بعده
    expect(s.deps.getAdminClient).not.toHaveBeenCalled();
    expect(s.deps.resolveDeployment).not.toHaveBeenCalled();
    expect(s.deps.requestRuntimeJsonCompletion).not.toHaveBeenCalled();
    expect(s.order).toEqual(["readiness", "config"]);
  });

  it("★ (٥) وعميل الخدمة null ⇒ target_unavailable", async () => {
    const s = scenario({ adminClient: null });
    expect(reasonOf(await s.run())).toBe("target_unavailable");
    expect(s.deps.resolveDeployment).not.toHaveBeenCalled();
  });

  it("★ (٦) وعميلٌ يرمي ⇒ رفضٌ بلا نصّ", async () => {
    const s = scenario({ adminThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("target_unavailable");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("★ (٧) وفشل الحلّال ⇒ target_unavailable بلا توليد", async () => {
    for (const reason of [
      "no_active_deployment",
      "version_not_found",
      "not_servable",
      "registry_error",
    ]) {
      const s = scenario({ resolution: { ok: false, reason } });
      expect(reasonOf(await s.run()), reason).toBe("target_unavailable");
      expect(s.deps.requestRuntimeJsonCompletion, reason).not.toHaveBeenCalled();
      expect(JSON.stringify(await s.run()), reason).not.toContain(reason);
    }
  });

  it("★ (٨) والحلّال الذي يرمي ⇒ رفضٌ بلا معرّف", async () => {
    const s = scenario({ resolverThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("target_unavailable");
    expect(JSON.stringify(res)).not.toContain(DEPLOYMENT_ID);
  });

  it("★ (٩) ★ والحلّال يتلقّى النموذج المملوك وبيئة الإعداد", async () => {
    const s = scenario();
    await s.run();
    const [client, modelId, environment] = s.deps.resolveDeployment.mock
      .calls[0] as unknown as [unknown, string, string];
    expect(client).toEqual({ __admin: true });
    expect(modelId).toBe(YSD_ALPHA_MODEL_ID);
    expect(environment).toBe("production");
  });

  it("★ ولا استعلام مباشر لجداول السجلّ", () => {
    const code = stripComments(SMOKE_SRC);
    for (const forbidden of [
      "ai_model_versions",
      "ai_model_deployments",
      "ai_models",
      ".from(",
      ".select(",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("d.resolveDeployment(");
  });
});

/* ═══════════ (١٠–١٥) نداء التوليد ═══════════ */

describe("★ (١٠–١٥) المدخل ثابتٌ في الكود", () => {
  const capture = async () => {
    const s = scenario();
    await s.run();
    return s.deps.requestRuntimeJsonCompletion.mock.calls[0] as unknown as [
      typeof runtimeConfig,
      ModelDeploymentRecord,
      ModelVersionRecord,
      Record<string, unknown>,
    ];
  };

  it("★ (١٠) الهدف المحلول بعينه يصل وقت التشغيل", async () => {
    const [cfg, dep, ver] = await capture();
    expect(cfg).toEqual(runtimeConfig);
    expect(dep).toEqual(deployment);
    expect(ver).toEqual(version);
  });

  it("★ (١١–١٢) ★ والموجّهان ثابتان حرفيًّا", async () => {
    const [, , , input] = await capture();
    expect(input.systemPrompt).toBe(
      "You are performing an internal YSD runtime health smoke test. " +
        "Follow the instruction exactly.",
    );
    expect(input.userText).toBe(`Reply with exactly: ${MARKER}`);
  });

  it("★ (١٣–١٤) وسقفا الرموز والمهلة ضيّقان", async () => {
    const [, , , input] = await capture();
    /**
     * ★ السقف رُفع إلى ١٢٨ بعد قطعٍ حيّ عند ١٦ (2026-08-18).
     *
     * `include_reasoning: false` يمنع إعادة التفكير لا توليده، فاستهلكت
     * مقدّمةُ التفكير السقف كلَّه وعاد `200` بمحتوى فارغ. والأرضية أدناه
     * تمنع العودة إلى قيمةٍ لا تتّسع لتلك المقدّمة — والرقم وحده يُنسى
     * سببُه، فالأرضية تحفظه.
     */
    expect(input.maxTokens).toBe(128);
    expect(input.maxTokens).toBeGreaterThanOrEqual(64);
    // والمهلة لم تتغيّر — القطع كان في الرموز لا في الزمن
    expect(input.timeoutMs).toBe(5_000);
  });

  it("★ (١٥) ★★ ولا سبيل لمدخلٍ من طلب", () => {
    /**
     * ★ الحارس الذي يمنع تحوّل الاختبار إلى واجهة.
     *
     * لو قُبل موجّهٌ من العميل لصار هذا المسار بابَ توليدٍ إداريًّا بلا
     * حصّة ولا رصد ولا سقف تكلفة. فلا يُقرأ الجسم إطلاقًا، ولا تستقبل
     * الدالة إلا هويّة المالك.
     */
    const code = stripComments(SMOKE_SRC);
    expect(code).toContain("systemPrompt: SMOKE_SYSTEM_PROMPT,");
    expect(code).toContain("userText: SMOKE_USER_TEXT,");
    expect(code).toContain("maxTokens: SMOKE_MAX_TOKENS,");
    expect(code).toContain("timeoutMs: SMOKE_TIMEOUT_MS,");

    // ولا معاملَ إدخالٍ في التوقيع سوى المالك والاعتمادات
    expect(code).toContain("isOwner: boolean,");
    expect(code).toContain("deps: Partial<YSDSmokeDependencies> = {},");

    // والمسار لا يقرأ الجسم
    const routeCode = stripComments(ROUTE_SRC);
    expect(routeCode).not.toContain("req.json()");
    expect(routeCode).not.toContain("req.text(");
    expect(routeCode).not.toContain("searchParams");
    expect(routeCode).toContain("checkYSDPreActivationSmoke(ctx.isOwner)");
  });

  it("★ ★ ولا يمرّ عبر بوّابة الخدمة العامّة", () => {
    /**
     * `YSDProvider.requestJsonCompletion` تُرفض عمدًا والمفتاح مغلق —
     * وهو الشرط الذي تفرضه الجاهزية. فاستعمالُها هنا يجعل الاختبار
     * يفشل دائمًا لسببٍ نحن اشترطناه.
     */
    const code = stripComments(SMOKE_SRC);
    expect(code).not.toContain("YSDProvider");
    expect(code).not.toContain("provider.requestJsonCompletion");
    expect(code).toContain("d.requestRuntimeJsonCompletion(");
  });
});

/* ═══════════ (١٦–٢٥) الحكم على المخرَج ═══════════ */

describe("★ (١٦–٢٥) تطابقٌ تامّ لا «ردّ غير فارغ»", () => {
  const withText = (text: string) => scenario({ runtime: { ok: true, text } });

  it("★ (١٦) العلامة بالضبط ⇒ نجاح", async () => {
    const res = await withText(MARKER).run();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.passed).toBe(true);
  });

  it("★ (١٧) ومسافاتٌ طرفية تُقصّ", async () => {
    for (const text of [`  ${MARKER}  `, `\n${MARKER}\n`, `\t${MARKER}`]) {
      expect((await withText(text).run()).ok, JSON.stringify(text)).toBe(true);
    }
  });

  it("★ (١٨–١٩) ★ وكل ما عداها ⇒ unexpected_output", async () => {
    /**
     * نموذجٌ يُضيف شرحًا أو يغيّر الحالة لم يتبع التعليمة. ومن لا يتبع
     * تعليمةً بهذه البساطة لا يُفتح للناس — والغرض إثبات الفهم لا إثبات
     * أن المنفذ أعاد أحرفًا.
     */
    const wrong = [
      MARKER.toLowerCase(),
      MARKER.replace("OK", "Ok"),
      `${MARKER}!`,
      `Sure: ${MARKER}`,
      `${MARKER} — done`,
      `"${MARKER}"`,
      "YSD_SMOKE_OKAY",
      "OK",
      "مرحبًا",
      MARKER.slice(0, -1),
    ];
    for (const text of wrong) {
      const res = await withText(text).run();
      expect(reasonOf(res), text).toBe("unexpected_output");
    }
  });

  it("★ (٢٠) ونصٌّ فارغ من وقت التشغيل ⇒ لا يُقبل", async () => {
    for (const text of ["", "   ", "\n"]) {
      expect(reasonOf(await withText(text).run()), JSON.stringify(text)).toBe(
        "unexpected_output",
      );
    }
  });

  it("★ (٢١) والمهلة ⇒ timeout", async () => {
    const s = scenario({ runtime: { ok: false, reason: "timeout" } });
    expect(reasonOf(await s.run())).toBe("timeout");
  });

  it("★ (٢٢) والإلغاء ⇒ aborted — لا عطل", async () => {
    const s = scenario({ runtime: { ok: false, reason: "aborted" } });
    expect(reasonOf(await s.run())).toBe("aborted");
  });

  it("★ (٢٣–٢٤) وبقيّة الأعطال ⇒ generation_failed", async () => {
    for (const reason of [
      "unauthorized",
      "network_error",
      "runtime_unavailable",
      "invalid_response",
      "invalid_target",
      "rate_limit",
      "stream_error",
    ] as const) {
      const s = scenario({ runtime: { ok: false, reason } });
      const res = await s.run();
      expect(reasonOf(res), reason).toBe("generation_failed");
      expect(JSON.stringify(res), reason).not.toContain(reason);
    }
  });

  it("★ (٢٥) ووقت تشغيلٍ يرمي ⇒ internal_error بلا نصّ", async () => {
    const s = scenario({ runtimeThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("internal_error");
    expect(JSON.stringify(res)).not.toContain(BASE_URL);
  });
});

/* ═══════════ (٢٦–٢٩) ما لا يخرج ═══════════ */

describe("★ (٢٦–٢٩) النصّ المولَّد لا يغادر", () => {
  it("★ (٢٦) ★★ ولا حتى عند الفشل", async () => {
    /**
     * فهو مخرَج نموذجٍ لم يُراجَع، وطباعتُه في سجلٍّ إداريّ تفتح بابًا لا
     * يُغلق: اليوم علامة، وغدًا رسالةُ خطأ تحمل مسارًا داخليًّا.
     */
    const secrets = [
      "SECRET_LEAK_TOKEN_9f2a",
      `${MARKER} (internal path: /srv/models/${RUNTIME_MODEL})`,
      "Error: connection to 10.0.0.5 refused",
    ];
    for (const text of secrets) {
      const s = scenario({ runtime: { ok: true, text } });
      const res = await s.run();
      const dump = JSON.stringify(res);
      expect(dump, text).not.toContain(text);
      expect(dump).not.toContain("SECRET_LEAK");
      expect(dump).not.toContain("10.0.0.5");
      // والمفاتيح مغلقة
      for (const k of Object.keys(res)) {
        expect(["ok", "passed", "publiclyEnabled", "latencyMs", "reason"], k).toContain(k);
      }
    }
  });

  it("★ (٢٦′) ★★ والنجاح كذلك — أربعة حقول لا خامس", async () => {
    /**
     * ★ الفجوة التي كشفتها طفرة.
     *
     * المسار الوحيد الذي **يملك** النصّ المطابق هو النجاح. وحارسٌ يقيس
     * الفشل وحده يثبت أن ما فشل لا يسرّب — ولا يقول شيئًا عمّا نجح.
     */
    const res = await scenario({ runtime: { ok: true, text: `  ${MARKER}  ` } }).run();
    expect(res.ok).toBe(true);
    expect(Object.keys(res).sort()).toEqual(["latencyMs", "ok", "passed", "publiclyEnabled"]);
    expect(JSON.stringify(res)).not.toContain(MARKER);
  });

  it("★ (٢٧) ★ ولا سجلّ نصّيّ إطلاقًا", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      await scenario().run();
      await scenario({ runtime: { ok: true, text: "SECRET_LEAK_TOKEN_9f2a" } }).run();
      await scenario({ runtime: { ok: false, reason: "unauthorized" } }).run();
      await scenario({ runtimeThrows: true }).run();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(logs).toEqual([]);
    expect(stripComments(SMOKE_SRC)).not.toContain("console.");
  });

  it("★ (٢٨) ★ ولا معرّفَ هدفٍ ولا سرّ في أي نتيجة", async () => {
    const cases: Array<Parameters<typeof scenario>[0]> = [
      {},
      { runtime: { ok: false, reason: "unauthorized" } },
      { resolution: { ok: false, reason: "not_servable" } },
      { config: { ok: false, reason: "missing_base_url" } },
      { runtime: { ok: true, text: "nope" } },
    ];
    for (const over of cases) {
      const res = await scenario(over).run();
      const dump = JSON.stringify(res);
      for (const leak of [RUNTIME_MODEL, ALIAS, BASE_URL, KEY, DEPLOYMENT_ID, VERSION_ID, "artifact-1"]) {
        expect(dump, leak).not.toContain(leak);
      }
    }
  });

  it("★ (٢٩) وزمنٌ منتهٍ غير سالب في كل حال", async () => {
    const clocks: number[][] = [
      [1_000, 1_120],
      [1_000, 1_000],
      [5_000, 4_000],
      [Number.NaN, Number.NaN],
    ];
    for (const clock of clocks) {
      const res = await scenario({ clock }).run();
      expect(Number.isFinite(res.latencyMs), JSON.stringify(clock)).toBe(true);
      expect(res.latencyMs, JSON.stringify(clock)).toBeGreaterThanOrEqual(0);
    }
    const ok = await scenario({ clock: [1_000, 1_120] }).run();
    expect(ok.latencyMs).toBe(120);
  });
});

/* ═══════════ الترتيب سلوكًا ═══════════ */

describe("★ الترتيب: لا توليد قبل اكتمال ما قبله", () => {
  it("★ ★ التسلسل كاملًا كما هو مُعلَن", async () => {
    const s = scenario();
    expect((await s.run()).ok).toBe(true);
    expect(s.order).toEqual(["readiness", "config", "admin", "resolver", "generation"]);
  });

  it("★ وكل عائقٍ يقطع الطريق عند موضعه", async () => {
    const cases: Array<[string, Parameters<typeof scenario>[0], string[]]> = [
      ["الجاهزية", { readiness: { ok: false, ready: false } }, ["readiness"]],
      ["الإعداد", { config: { ok: false } }, ["readiness", "config"]],
      ["العميل", { adminClient: null }, ["readiness", "config", "admin"]],
      [
        "الحلّال",
        { resolution: { ok: false, reason: "not_servable" } },
        ["readiness", "config", "admin", "resolver"],
      ],
    ];
    for (const [label, over, expected] of cases) {
      const s = scenario(over);
      await s.run();
      expect(s.order, label).toEqual(expected);
      expect(s.order, label).not.toContain("generation");
    }
  });
});

/* ═══════════ المسار الإداريّ ═══════════ */

describe("★ المسار: POST للمالك بلا جسم", () => {
  it("★ (٣٠–٣٣) ★ POST وحدها", () => {
    /**
     * `GET` تُنفَّذ بلا قصد — زاحفٌ يتبع رابطًا، أو متصفّحٌ يستبق التحميل،
     * أو إعادةُ تحميل صفحة. فيصير كل ذلك توليدًا لم يطلبه أحد.
     */
    expect(ROUTE_SRC).toContain("export async function POST(");
    for (const verb of ["GET", "PATCH", "DELETE", "PUT", "HEAD"]) {
      expect(ROUTE_SRC, verb).not.toContain(`export async function ${verb}`);
    }
  });

  it("★ (٣٤) ومالكٌ فقط", () => {
    expect(ROUTE_SRC).toContain("checkYSDPreActivationSmoke(ctx.isOwner)");
    expect(ROUTE_SRC).toContain("owner_required: { status: 403");
  });

  it("★ (٣٥–٣٧) ★ ولا يختار العميل شيئًا", () => {
    const code = stripComments(ROUTE_SRC);
    for (const forbidden of [
      "req.json",
      "req.text",
      "searchParams",
      "prompt",
      "runtimeModel",
      "environment",
      "deployment",
      "model:",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٣٨–٣٩) والردّ يقول إن الخدمة مغلقة، ولا يُخزَّن", () => {
    const code = stripComments(ROUTE_SRC);
    expect((code.match(/publiclyEnabled: false/g) ?? []).length).toBe(2);
    expect(code).not.toContain("publiclyEnabled: true");
    expect(code).toContain('"Cache-Control": "no-store, no-cache, must-revalidate"');
  });

  it("★ (٤٠–٤١) ★ ولا نصَّ مولَّد ولا معرّفَ هدفٍ في الردّ", () => {
    /**
     * يُقاس على **جسمَي الردّ** وحدهما: كلمة `output` تظهر مشروعةً في رمز
     * الفشل `ysd_smoke_output_mismatch`، وحارسٌ يقرأ الملفّ كلّه يمنع
     * تسميةً صحيحة بدل أن يمنع تسريبًا.
     */
    const bodies = [...stripComments(ROUTE_SRC).matchAll(/JSON\.stringify\(\{[\s\S]*?\}\)/g)]
      .map((m) => m[0]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      for (const forbidden of [
        "result.text",
        "text",
        "output",
        "completion",
        "runtimeModel",
        "artifactRef",
        "deploymentId",
        "modelVersionId",
        "endpointAlias",
        "baseUrl",
        "apiKey",
      ]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    }
  });

  it("★ (٤٢) وسجلّ التدقيق يقول أن العملية وقعت لا ماذا قالت", () => {
    const at = ROUTE_SRC.indexOf('action: "model.ysd_smoke_test"');
    expect(at).toBeGreaterThan(0);
    const audit = stripComments(ROUTE_SRC.slice(at, ROUTE_SRC.indexOf("      req,", at)));
    expect(audit).toContain("passed: result.passed");
    expect(audit).toContain("publicServing: false");
    expect(audit).toContain("targetId: YSD_ALPHA_MODEL_ID");
    for (const forbidden of ["text", "prompt", "runtimeModel", "artifactRef", "version"]) {
      expect(audit, forbidden).not.toContain(forbidden);
    }
  });

  it("★ وكل سببٍ في الاتّحاد له تحويلٌ في الجدول", () => {
    const union = SMOKE_SRC.slice(
      SMOKE_SRC.indexOf("      reason:"),
      SMOKE_SRC.indexOf("/**\n * ★ المدخل ثابتٌ"),
    );
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(reasons.length).toBe(8);
    const table = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("const SMOKE_FAILURES"),
      ROUTE_SRC.indexOf("const HEADERS"),
    );
    for (const r of reasons) expect(table, r).toContain(`${r}:`);
  });
});


/* ═══════════ التدقيق لا يغيّر النتيجة ═══════════ */

/**
 * ★ هذه المجموعة **تشغّل المعالج** لا تقرأ مصدره.
 *
 * لأن المقيس سلوكُ استثناءٍ عابر: هل يتحوّل ردٌّ ناجح إلى `500` لأن سطر
 * تدقيقٍ لم يُكتب؟ وذلك لا يُرى في نصّ الملفّ — يُرى بتشغيله.
 */
describe("★ المسار: عطلُ التدقيق لا يمسّ الحكم", () => {
  const OWNER_CTX = { supabase: {}, userId: "owner-1", role: "owner", isOwner: true };

  /** يُحمّل المعالج بمحاكاةٍ محقونة، ويُعيد الردّ المفكوك */
  async function callRoute(over: {
    smoke?: unknown;
    auditThrows?: boolean;
    ctx?: unknown;
  }) {
    vi.resetModules();
    const writeAudit = vi.fn(async () => {
      if (over.auditThrows) throw new Error(`audit table missing: ${KEY} / ${MARKER}`);
    });

    vi.doMock("@/lib/admin/guard", () => ({
      getAdminContext: vi.fn(async () => (over.ctx === undefined ? OWNER_CTX : over.ctx)),
      forbidden: () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      writeAudit,
    }));
    vi.doMock("@/lib/ai/ysd-smoke-test", () => ({
      checkYSDPreActivationSmoke: vi.fn(
        async () =>
          over.smoke ?? { ok: true, passed: true, publiclyEnabled: false, latencyMs: 120 },
      ),
    }));

    const { POST } = await import("@/app/api/admin/ysd/smoke/route");
    const req = new Request("http://localhost/api/admin/ysd/smoke", { method: "POST" });
    const res = await POST(req as never);
    return { res, body: await res.json(), writeAudit };
  }

  afterEach(() => {
    vi.doUnmock("@/lib/admin/guard");
    vi.doUnmock("@/lib/ai/ysd-smoke-test");
    vi.resetModules();
  });

  it("★ ★ نجاحٌ + تدقيقٌ يرمي ⇒ يبقى 200 وpassed", async () => {
    /**
     * العملية وقعت فعلًا في وقت التشغيل قبل أن يُكتب السطر. فلو صار الردّ
     * `500` لَقرأ المشغّل «فشل الاختبار» بينما التوليد نجح — ويُعاد النداء
     * فيُستهلك استدلالٌ ثانٍ لأجل عطلٍ في التسجيل لا في المفحوص.
     */
    const { res, body, writeAudit } = await callRoute({ auditThrows: true });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      passed: true,
      publiclyEnabled: false,
      latencyMs: 120,
      nextAction: "enable_public_serving",
    });
  });

  it("★ ★ وفشلٌ + تدقيقٌ يرمي ⇒ الرمز والحالة الأصليان", async () => {
    const cases: Array<[string, number, string]> = [
      ["unexpected_output", 409, "ysd_smoke_output_mismatch"],
      ["timeout", 504, "ysd_smoke_timeout"],
      ["generation_failed", 503, "ysd_generation_failed"],
      ["not_ready", 409, "ysd_not_ready"],
    ];
    for (const [reason, status, code] of cases) {
      const { res, body } = await callRoute({
        auditThrows: true,
        smoke: { ok: false, passed: false, reason, latencyMs: 44 },
      });
      expect(res.status, reason).toBe(status);
      expect(body.code, reason).toBe(code);
      expect(body.passed, reason).toBe(false);
      expect(body.publiclyEnabled, reason).toBe(false);
      expect(res.status, reason).not.toBe(500);
    }
  });

  it("★ ★ ولا نصُّ الاستثناء ولا العلامة في الجسم", async () => {
    for (const smoke of [
      undefined,
      { ok: false, passed: false, reason: "unexpected_output", latencyMs: 7 },
    ]) {
      const { body } = await callRoute({ auditThrows: true, smoke });
      const dump = JSON.stringify(body);
      for (const leak of [KEY, MARKER, "audit table missing"]) {
        expect(dump, leak).not.toContain(leak);
      }
    }
  });

  it("★ والتدقيق يُستدعى للنجاح وللفشل — لا لغير المالك", async () => {
    const pass = await callRoute({});
    expect(pass.writeAudit).toHaveBeenCalledTimes(1);

    const failed = await callRoute({
      smoke: { ok: false, passed: false, reason: "timeout", latencyMs: 3 },
    });
    expect(failed.writeAudit).toHaveBeenCalledTimes(1);

    const denied = await callRoute({
      smoke: { ok: false, passed: false, reason: "owner_required", latencyMs: 0 },
    });
    expect(denied.writeAudit).not.toHaveBeenCalled();
  });

  it("★ وسياقٌ غائب ⇒ 403 بلا تدقيقٍ ولا اختبار", async () => {
    const { res, writeAudit } = await callRoute({ ctx: null });
    expect(res.status).toBe(403);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("★ والترويسة تمنع التخزين في كل حال", async () => {
    for (const smoke of [
      undefined,
      { ok: false, passed: false, reason: "generation_failed", latencyMs: 1 },
    ]) {
      const { res } = await callRoute({ auditThrows: true, smoke });
      expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    }
  });
});

/* ═══════════ لا تفعيل ═══════════ */

describe("★ الاختبار لا يفتح شيئًا", () => {
  it("★ ★ ولا يكتب في القاعدة ولا يمسّ البيئة", () => {
    const code = stripComments(SMOKE_SRC);
    for (const forbidden of [
      ".update(",
      ".insert(",
      ".upsert(",
      ".delete(",
      ".rpc(",
      "stageYSDDatabaseEligibility",
      "stageYSDRelease",
      "process.env",
      "YSD_MODEL_ALPHA_ENABLED",
      "fetch(",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(stripComments(ROUTE_SRC)).not.toContain("process.env");
  });

  it("★ والمفتاح افتراضه الإغلاق ولم يُمسّ", () => {
    expect(ENV_EXAMPLE).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    expect(ENV_EXAMPLE).not.toContain("YSD_MODEL_ALPHA_ENABLED=1");
  });

  it("★ ولا ترحيلة جديدة", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    /**
     * ★ حُدِّث في بنك التدريب (0040).
     *
     * الثابت هو أن رقعة YSD هذه لم تُدخل ترحيلة، لا أن المشروع لن يضيف
     * غيرها أبدًا. فيُقاس ما يخصّها: لا ترحيلةَ تمسّ تفعيل النموذج.
     */
    for (const f of files) {
      const sql = readSrc(`supabase/migrations/${f}`).toLowerCase();
      expect(sql, f).not.toContain("update public.ai_models set enabled = true");
      expect(sql, f).not.toContain("ysd_model_alpha_enabled");
    }
  });

  it("★ ودلالة مفتاح الإذن كما هي", () => {
    expect(readSrc("lib/ai/ysd-activation.ts")).toContain(
      'return env.YSD_MODEL_ALPHA_ENABLED === "1";',
    );
  });

  it("★ وسياستا العبور وysd/free", async () => {
    const { YSDProvider } = await import("@/lib/ai/ysd");
    const p = new YSDProvider();
    expect(p.fallbackPolicy).toBe("none");
    expect(p.fallbackEligible).toBe(false);

    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });
});
