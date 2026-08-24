/**
 * تسجيل إصدار YSD (v0.9.3، الرقعة العاشرة).
 *
 * ── الحلقة التي تفكّها هذه الرقعة ──
 *
 * `healthCheck` لا يقول «متصل» بلا نشرةٍ نشطة لنسخةٍ معتمدة، والرقعة
 * التاسعة لا تفتح أهليّة القاعدة بلا «متصل». فبلا تسجيل إصدارٍ يستحيل
 * الوصول إلى أيّهما:
 *
 *   لا نشرة ⇐ لا فحص ⇐ لا أهليّة ⇐ ولا طريق إلى نشرة.
 *
 * ولذلك **لا يُشترط الفحص هنا** — وهو أهمّ ما يحرسه هذا الملفّ: اشتراطه
 * يبدو تشدّدًا حكيمًا وهو في الحقيقة قفلٌ لا مفتاح له.
 *
 *   السجلّ جاهز  ≠  مؤهَّلٌ في القاعدة  ≠  مفتوحٌ للناس.
 *
 * ولا قاعدة ولا شبكة هنا: كل شيء بالحقن.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import { stageYSDRelease } from "@/lib/ai/ysd-release";
import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "@/lib/ai/ysd";
import type { AIProviderAdapter } from "@/lib/ai/types";

/**
 * ★ المصادر تُقرأ بنهايات أسطر موحّدة.
 *
 * شجرةُ عملٍ على Windows تُخرج CRLF، فحارسٌ يقصّ على `"\n  }\n"` لا يجد
 * شيئًا ويسقط بلا خطأ حقيقيّ. والمقيس هنا **بنية المصدر** لا شكل سطوره.
 */
const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const RELEASE_SRC = readSrc("lib/ai/ysd-release.ts");
const ROUTE_SRC = readSrc("app/api/admin/ysd/release/route.ts");
const MIGRATION = readSrc("supabase/migrations/0039_ysd_release_staging.sql");

const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret";
const RUNTIME_MODEL = "ysd-alpha-2026-01";

const runtimeConfig = {
  deploymentEnvironment: "production" as const,
  endpointAlias: ALIAS,
  baseUrl: BASE_URL,
  apiKey: KEY,
};

const VALID = {
  version: "1.4.2",
  baseModelRef: "base-a",
  artifactRef: "artifact-1",
  runtimeModel: RUNTIME_MODEL,
};

const ysdProvider = (): AIProviderAdapter =>
  ({
    id: YSD_PROVIDER_ID,
    displayName: "YSD",
    healthCheck: vi.fn(async () => ({ status: "connected" as const })),
  }) as unknown as AIProviderAdapter;

const otherProvider = (): AIProviderAdapter =>
  ({ id: "openrouter", displayName: "OpenRouter" }) as unknown as AIProviderAdapter;

/** عميل خدمةٍ في الذاكرة يسجّل كل نداء RPC — ليُقاس ما مُرِّر وما لم يُمرَّر */
function memoryAdmin(result: string | { error: unknown } = "ok") {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push([fn, args]);
      if (typeof result === "object") return Promise.resolve({ data: null, error: result.error });
      if (result === "__throw") return Promise.reject(new Error(`relation ai_models: ${KEY}`));
      return Promise.resolve({ data: result, error: null });
    },
  };
  return { client, calls };
}

function deps(over: Record<string, unknown> = {}) {
  const admin = memoryAdmin();
  return {
    isKillSwitchOn: vi.fn(() => false),
    readRuntimeConfig: vi.fn(() => ({ ok: true, config: runtimeConfig })),
    listConfiguredProviders: vi.fn(() => [otherProvider(), ysdProvider()]),
    getAdminClient: vi.fn(() => admin.client),
    ...over,
    __admin: admin,
  } as Record<string, unknown> & { __admin: ReturnType<typeof memoryAdmin> };
}

const stageWith = (
  isOwner: boolean,
  d: Record<string, unknown>,
  input: Partial<typeof VALID> = {},
) =>
  stageYSDRelease(
    isOwner,
    { ...VALID, ...input },
    d as unknown as Parameters<typeof stageYSDRelease>[2],
  );

const reasonOf = (r: Awaited<ReturnType<typeof stageYSDRelease>>) => (r.ok ? null : r.reason);

/* ═══════════ (١–٤) ما يُرفض قبل القاعدة ═══════════ */

describe("★ (١–٤) الفحوص السابقة لأي كتابة", () => {
  it("★ (١) ★ مشرفٌ ليس مالكًا ⇒ رفض بصفر نداءٍ للخدمة", async () => {
    /**
     * اختيارُ النتاج الذي يخدم النموذج قرارٌ أعمق من إشرافٍ يوميّ: هو
     * تحديد **ما هو** النموذج، لا متى يُفتح.
     */
    const d = deps();
    const res = await stageWith(false, d);
    expect(reasonOf(res)).toBe("owner_required");
    expect(d.getAdminClient).not.toHaveBeenCalled();
    expect(d.__admin.calls).toHaveLength(0);
  });

  it("★ (٢) ★ ومفتاح الخدمة مفتوح ⇒ رفض قبل الدالة", async () => {
    /**
     * تبديلُ النتاج والخدمةُ مفتوحة يعني محادثةً تبدأ على نسخةٍ وتنتهي
     * على أخرى، ورصدًا ينسب الردّ إلى نشرةٍ لم تكتبه.
     */
    const d = deps({ isKillSwitchOn: vi.fn(() => true) });
    expect(reasonOf(await stageWith(true, d))).toBe("kill_switch_must_be_off");
    expect(d.getAdminClient).not.toHaveBeenCalled();
    expect(d.__admin.calls).toHaveLength(0);
  });

  it("★ (٣) وإعداد وقت تشغيلٍ ناقص ⇒ رفض", async () => {
    const d = deps({ readRuntimeConfig: vi.fn(() => ({ ok: false, reason: "missing_base_url" })) });
    expect(reasonOf(await stageWith(true, d))).toBe("not_configured");
    expect(d.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ (٤) والمزوّد غير مهيّأ ⇒ رفض", async () => {
    const d = deps({ listConfiguredProviders: vi.fn(() => [otherProvider()]) });
    expect(reasonOf(await stageWith(true, d))).toBe("provider_not_configured");
    expect(d.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ والترتيب مكتوبٌ كذلك في المصدر", () => {
    const ownerAt = RELEASE_SRC.indexOf('return fail("owner_required")');
    const killAt = RELEASE_SRC.indexOf('return fail("kill_switch_must_be_off")');
    const configAt = RELEASE_SRC.indexOf("d.readRuntimeConfig()");
    const providerAt = RELEASE_SRC.indexOf("d.listConfiguredProviders()");
    const clientAt = RELEASE_SRC.indexOf("d.getAdminClient()");
    const rpcAt = RELEASE_SRC.indexOf('admin.rpc("ysd_stage_release"');
    expect(ownerAt).toBeGreaterThan(0);
    expect(ownerAt).toBeLessThan(killAt);
    expect(killAt).toBeLessThan(configAt);
    expect(configAt).toBeLessThan(providerAt);
    expect(providerAt).toBeLessThan(clientAt);
    expect(clientAt).toBeLessThan(rpcAt);
  });
});

/* ═══════════ (٥) لا فحص جاهزية — عمدًا ═══════════ */

describe("★ (٥) الفحص ليس شرطًا هنا", () => {
  it("★ ★ لا يُستدعى healthCheck في مسار التسجيل", async () => {
    /**
     * ★ الحارس الذي يمنع قفلًا لا مفتاح له.
     *
     * اشتراطُ «متصل» قبل تسجيل النشرة يبدو تشدّدًا حكيمًا — وهو في
     * الحقيقة شرطٌ دائريّ: الفحص يحتاج نشرةً نشطة، والنشرة تحتاج فحصًا.
     * فلا يُنشأ شيء أبدًا. والاشتراط يملكه المسار التالي وحده، بعد أن
     * يصير للفحص ما يفحصه.
     */
    const health = vi.fn(async () => ({ status: "unreachable" as const }));
    const provider = {
      id: YSD_PROVIDER_ID,
      displayName: "YSD",
      healthCheck: health,
    } as unknown as AIProviderAdapter;

    const d = deps({ listConfiguredProviders: vi.fn(() => [provider]) });
    const res = await stageWith(true, d);

    expect(res).toEqual({ ok: true, alreadyStaged: false });
    expect(health).not.toHaveBeenCalled();
  });

  it("★ ولا يذكر المصدرُ الفحصَ إطلاقًا", () => {
    const code = RELEASE_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("healthCheck");
    expect(code).not.toContain("checkRuntimeReadiness");
  });

  it("★ ولا يستدعي مسارَ أهليّة القاعدة تلقائيًّا", () => {
    for (const src of [RELEASE_SRC, ROUTE_SRC]) {
      expect(src).not.toContain("stageYSDDatabaseEligibility");
      expect(src).not.toContain("ysd-rollout");
    }
  });
});

/* ═══════════ (٦–٩) الهدف من الإعداد لا من الطلب ═══════════ */

describe("★ (٦–٩) العميل لا يختار الهدف", () => {
  it("★ (٦–٧) ★ البيئة والاسم المستعار من الإعداد وحده", async () => {
    /**
     * ولو جاءا من جسم طلبٍ لَأمكن تسجيل نشرةٍ لبيئةٍ لا يخدمها هذا
     * الخادم — فيقول الفحص «لا نشرة» ولا يفهم أحدٌ لماذا. والأسوأ: اسمٌ
     * مستعار مخالف يجعل بوابة الثقة ترفض كل نداء بعد ذلك بلا سببٍ ظاهر.
     */
    const d = deps();
    await stageWith(true, d);
    const [fn, args] = d.__admin.calls[0]!;
    expect(fn).toBe("ysd_stage_release");
    expect(args.p_environment).toBe("production");
    expect(args.p_endpoint_alias).toBe(ALIAS);
  });

  it("★ (٨) ★ وتغيّرهما بتغيّر الإعداد لا بتغيّر الطلب", async () => {
    const d = deps({
      readRuntimeConfig: vi.fn(() => ({
        ok: true,
        config: { ...runtimeConfig, deploymentEnvironment: "staging", endpointAlias: "ysd-stg" },
      })),
    });
    await stageWith(true, d);
    const [, args] = d.__admin.calls[0]!;
    expect(args.p_environment).toBe("staging");
    expect(args.p_endpoint_alias).toBe("ysd-stg");
  });

  it("★ (٨″) ★★ ومحاولةُ تجاوزٍ صريحة تُهمَل تمامًا", async () => {
    /**
     * ★ الفرق بين «الإعداد يُستعمل» و«الطلب لا يستطيع تجاوزه».
     *
     * الأول يثبت بمدخلٍ نظيف — وهو ما لا يكفي: مسارٌ يقرأ الطلب أولًا ثم
     * يرجع إلى الإعداد عند غيابه يمرّ من الاختبار النظيف سالمًا، ثم يقبل
     * التجاوز في أول طلبٍ خبيث. فتُدَسّ الحقول هنا صراحةً.
     */
    const rogue = {
      ...VALID,
      environment: "development",
      endpointAlias: "attacker-alias",
      deploymentEnvironment: "staging",
      baseUrl: "https://attacker.example/v1",
      apiKey: "sk-attacker",
      modelId: "other/model",
    } as unknown as typeof VALID;

    const d = deps();
    const res = await stageYSDRelease(
      true,
      rogue,
      d as unknown as Parameters<typeof stageYSDRelease>[2],
    );
    expect(res.ok).toBe(true);

    const [, args] = d.__admin.calls[0]!;
    expect(args.p_environment).toBe("production");
    expect(args.p_endpoint_alias).toBe(ALIAS);
    const dump = JSON.stringify(args);
    for (const injected of [
      "development",
      "staging",
      "attacker-alias",
      "attacker.example",
      "sk-attacker",
      "other/model",
    ]) {
      expect(dump, injected).not.toContain(injected);
    }
  });

  it("★ (٨′) ★ ولا سبيل للعميل إلى تمريرهما — ليسا في العقد", () => {
    // لا في مخطّط المسار
    const schema = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("const releaseSchema"),
      ROUTE_SRC.indexOf("export async function POST"),
    );
    for (const forbidden of ["environment", "endpointAlias", "alias", "baseUrl", "apiKey", "url"]) {
      expect(schema.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
    // ولا في مدخلات المساعد
    const inputType = RELEASE_SRC.slice(
      RELEASE_SRC.indexOf("export interface YSDReleaseInput"),
      RELEASE_SRC.indexOf("export interface YSDReleaseDependencies"),
    );
    for (const forbidden of ["environment", "endpointAlias", "baseUrl", "apiKey"]) {
      expect(inputType, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٩) ★ ولا عنوان ولا مفتاح يصل الدالة", async () => {
    const d = deps();
    await stageWith(true, d);
    const [, args] = d.__admin.calls[0]!;
    const dump = JSON.stringify(args);
    for (const secret of [BASE_URL, KEY, "baseUrl", "apiKey", "http"]) {
      expect(dump, secret).not.toContain(secret);
    }
    // والوسائط ستّة معلومة لا أكثر
    expect(Object.keys(args).sort()).toEqual([
      "p_artifact_ref",
      "p_base_model_ref",
      "p_endpoint_alias",
      "p_environment",
      "p_runtime_model",
      "p_version",
    ]);
  });

  it("★ والمعرّف المنطقيّ لا يُمرَّر أصلًا — ثابتٌ في الدالة", async () => {
    const d = deps();
    await stageWith(true, d);
    const [, args] = d.__admin.calls[0]!;
    expect(JSON.stringify(args)).not.toContain("p_model_id");
    // والدالة تثبّته بنفسها
    expect(MIGRATION).toContain("v_model_id   constant text := 'ysd/model-alpha';");
  });
});

/* ═══════════ (١٠–١٣) المدخلات ═══════════ */

describe("★ (١٠–١٣) ما يُرفض من المدخل", () => {
  it("★ الفارغ والمساحات وحدها ⇒ invalid_input بصفر نداء", async () => {
    const bad: Array<Partial<typeof VALID>> = [
      { version: "" },
      { version: "   " },
      { artifactRef: "" },
      { artifactRef: "  " },
      { runtimeModel: "" },
      { runtimeModel: "\t" },
      { version: "v".repeat(65) },
      { artifactRef: "a".repeat(257) },
      { runtimeModel: "r".repeat(257) },
      { baseModelRef: "b".repeat(257) },
    ];
    for (const input of bad) {
      const d = deps();
      expect(reasonOf(await stageWith(true, d, input)), JSON.stringify(input)).toBe("invalid_input");
      expect(d.__admin.calls, JSON.stringify(input)).toHaveLength(0);
    }
  });

  it("★ ★ ومعرّف وقت التشغيل لا يساوي المعرّف المنطقيّ", async () => {
    /**
     * `ysd/model-alpha` اسمٌ يراه المستخدم، و`runtime_model` نتاجٌ يحمله
     * الخادم. وخلطهما ينتج نشرةً تطلب من وقت التشغيل اسمًا لا يعرفه —
     * فيقول الفحص «النموذج غير محمَّل» ولا يُفهم السبب.
     */
    const d = deps();
    expect(reasonOf(await stageWith(true, d, { runtimeModel: YSD_ALPHA_MODEL_ID }))).toBe(
      "invalid_input",
    );
    expect(d.__admin.calls).toHaveLength(0);
  });

  it("★ والقيَم تُقصّ قبل التمرير", async () => {
    const d = deps();
    await stageWith(true, d, {
      version: "  1.4.2  ",
      artifactRef: " artifact-1 ",
      runtimeModel: ` ${RUNTIME_MODEL} `,
    });
    const [, args] = d.__admin.calls[0]!;
    expect(args.p_version).toBe("1.4.2");
    expect(args.p_artifact_ref).toBe("artifact-1");
    expect(args.p_runtime_model).toBe(RUNTIME_MODEL);
  });

  it("★ والأساس الفارغ يصير null لا نصًّا فارغًا", async () => {
    const d = deps();
    await stageWith(true, d, { baseModelRef: "   " });
    expect(d.__admin.calls[0]![1].p_base_model_ref).toBeNull();
  });
});

/* ═══════════ (١٤–١٨) نتيجة الدالة ═══════════ */

describe("★ (١٤–١٨) ما يُعاد", () => {
  it("★ عميل الخدمة غائب ⇒ فشل مغلق", async () => {
    expect(reasonOf(await stageWith(true, deps({ getAdminClient: vi.fn(() => null) })))).toBe(
      "admin_client_unavailable",
    );
  });

  it("★ وعميلٌ يرمي ⇒ فشل مغلق بلا نصّ", async () => {
    const d = deps({
      getAdminClient: vi.fn(() => {
        throw new Error(`SERVICE_ROLE=${KEY}`);
      }),
    });
    const res = await stageWith(true, d);
    expect(reasonOf(res)).toBe("admin_client_unavailable");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("★ ★ وخطأ القاعدة يُبتلع رمزًا لا نصًّا", async () => {
    const withError = memoryAdmin({ error: { code: "42501", message: `permission denied: ${KEY}` } });
    const res = await stageWith(true, deps({ getAdminClient: () => withError.client }));
    expect(reasonOf(res)).toBe("database_error");
    const dump = JSON.stringify(res);
    for (const leak of [KEY, "42501", "permission denied"]) {
      expect(dump, leak).not.toContain(leak);
    }
  });

  it("★ والاستثناء كذلك", async () => {
    const thrower = memoryAdmin("__throw");
    const res = await stageWith(true, deps({ getAdminClient: () => thrower.client }));
    expect(reasonOf(res)).toBe("database_error");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("★ ورموز الدالة تُقابَل بأسبابٍ مغلقة", async () => {
    const map: Array<[string, string]> = [
      ["invalid_input", "invalid_input"],
      ["model_not_found", "model_not_found"],
      ["model_gate_must_be_off", "model_gate_must_be_off"],
      ["version_conflict", "version_conflict"],
    ];
    for (const [code, reason] of map) {
      const admin = memoryAdmin(code);
      expect(reasonOf(await stageWith(true, deps({ getAdminClient: () => admin.client }))), code).toBe(
        reason,
      );
    }
  });

  it("★ ورمزٌ مجهول من الدالة ⇒ فشل مغلق لا نجاحٌ صامت", async () => {
    const admin = memoryAdmin("something_new_we_did_not_map");
    const res = await stageWith(true, deps({ getAdminClient: () => admin.client }));
    expect(res.ok).toBe(false);
    expect(reasonOf(res)).toBe("database_error");
    expect(JSON.stringify(res)).not.toContain("something_new");
  });

  it("★ (١٧) `ok` ⇒ نجاحٌ جديد", async () => {
    const admin = memoryAdmin("ok");
    expect(await stageWith(true, deps({ getAdminClient: () => admin.client }))).toEqual({
      ok: true,
      alreadyStaged: false,
    });
  });

  it("★ (١٨) و`already_staged` ⇒ نجاحٌ موسوم", async () => {
    const admin = memoryAdmin("already_staged");
    expect(await stageWith(true, deps({ getAdminClient: () => admin.client }))).toEqual({
      ok: true,
      alreadyStaged: true,
    });
  });

  it("★ ولا حقولَ زائدة في أي نتيجة", async () => {
    const outcomes = ["ok", "already_staged", "version_conflict", "model_gate_must_be_off"];
    for (const code of outcomes) {
      const admin = memoryAdmin(code);
      const res = await stageWith(true, deps({ getAdminClient: () => admin.client }));
      for (const k of Object.keys(res)) {
        expect(["ok", "reason", "alreadyStaged"], `${code}/${k}`).toContain(k);
      }
    }
  });
});

/* ═══════════ (١٩–٢٤) المسار الإداريّ ═══════════ */

describe("★ (١٩–٢٤) العقد الخارجيّ", () => {
  it("★ POST وحدها، ومالكٌ فقط", () => {
    expect(ROUTE_SRC).toContain("export async function POST(");
    expect(ROUTE_SRC).not.toContain("export async function GET(");
    expect(ROUTE_SRC).not.toContain("export async function PATCH(");
    expect(ROUTE_SRC).not.toContain("export async function DELETE(");
    expect(ROUTE_SRC).toContain("stageYSDRelease(ctx.isOwner");
  });

  it("★ (٢٠) ★ والردّ يذكر البوّابتين الباقيتين صراحةً", () => {
    /**
     * لأن «تمّ التسجيل» تُقرأ على أنها «صار النموذج جاهزًا للناس». وهو
     * لم يصر: أهليّة القاعدة مغلقة، ومفتاح الخدمة مغلق.
     */
    const body = ROUTE_SRC.slice(ROUTE_SRC.indexOf("      ok: true,"));
    expect(body).toContain("staged: true");
    expect(body).toContain("alreadyStaged: staged.alreadyStaged");
    expect(body).toContain("databaseEligible: false");
    expect(body).toContain("publiclyEnabled: false");
  });

  it("★ (٢١) ★ ولا معرّف ولا سرّ في الردّ", () => {
    const body = ROUTE_SRC.slice(ROUTE_SRC.indexOf("      ok: true,"));
    for (const forbidden of [
      "deploymentId",
      "modelVersionId",
      "runtimeModel",
      "artifactRef",
      "endpointAlias",
      "environment",
      "baseUrl",
      "apiKey",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٢٢) ★ وسجلّ التدقيق يحمل رقم النسخة وحده", () => {
    const at = ROUTE_SRC.indexOf('action: "model.ysd_release_staged"');
    expect(at).toBeGreaterThan(0);
    const audit = ROUTE_SRC.slice(at, ROUTE_SRC.indexOf("    req,\n  );", at));
    const code = audit
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("version: parsed.data.version");
    expect(code).toContain('releaseStatus: "active"');
    expect(code).toContain("databaseEligible: false");
    expect(code).toContain("publicServing: false");
    for (const forbidden of [
      "runtimeModel",
      "artifactRef",
      "endpointAlias",
      "environment",
      "deploymentId",
      "modelVersionId",
      "baseUrl",
      "apiKey",
      "baseModelRef",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain(`targetId: YSD_ALPHA_MODEL_ID`);
  });

  it("★ (٢٣) والرموز المعروضة مغلقة", () => {
    const table = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("const RELEASE_FAILURES"),
      ROUTE_SRC.indexOf("const releaseSchema"),
    );
    expect(table).toContain("ysd_owner_required");
    expect(table).toContain("ysd_kill_switch_must_be_off");
    expect(table).toContain("ysd_model_gate_must_be_off");
    expect(table).toContain("ysd_version_conflict");
    expect(table).toContain("status: 403");
  });

  it("★ (٢٤) ★ وكل سببٍ في الاتّحاد له تحويلٌ في الجدول", () => {
    /**
     * وإلا لَصار سببٌ جديد يُعرض `undefined` — استثناءً في وقت التشغيل
     * داخل مسارٍ إداريّ، أي رسالة خطأ عامّة بدل رمزٍ يفهمه المشرف.
     */
    const union = RELEASE_SRC.slice(
      RELEASE_SRC.indexOf("      reason:"),
      RELEASE_SRC.indexOf("const fail ="),
    );
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(reasons.length).toBe(10);
    const table = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("const RELEASE_FAILURES"),
      ROUTE_SRC.indexOf("const releaseSchema"),
    );
    for (const r of reasons) expect(table, r).toContain(`${r}:`);
  });
});


/* ═══════════ (٣١–٣٣) تصحيحات الرقعة ═══════════ */

describe("★ (٣١) معرّف وقت التشغيل ليس عنوانًا", () => {
  it("★ ★ العناوين تُرفض بصفر نداء", async () => {
    /**
     * الخطر أن يُخزَّن عنوانٌ في حقلٍ يُمرَّر يومًا إلى جهةٍ تبنيه وجهةَ
     * اتصال. فيُقفل الباب عند الكتابة لا عند القراءة — ومن يقرأ الصفّ
     * بعد سنة لن يعرف أنه كان يُفترض ألّا يحمل عنوانًا.
     */
    const urls = [
      "https://evil.example/model",
      "http://evil.example/model",
      "//evil.example/model",
      "HTTPS://EVIL.EXAMPLE/model",
      "ftp://evil.example/model",
      "file:///etc/passwd",
      "s3://bucket/model",
      "custom-scheme+v1://host/model",
    ];
    for (const runtimeModel of urls) {
      const d = deps();
      expect(reasonOf(await stageWith(true, d, { runtimeModel })), runtimeModel).toBe(
        "invalid_input",
      );
      expect(d.__admin.calls, runtimeModel).toHaveLength(0);
    }
  });

  it("★ ★ والمعرّفات المشروعة لا تُرفض لمجرّد `/` أو `:`", async () => {
    /**
     * `org/model-name` معرّفٌ شائع في مستودعات النماذج، و`hf:model-name`
     * كذلك. وحارسٌ يمنع المحرفين بعمومهما يرفض أسماءً صحيحة كل يوم —
     * فيُلتَفّ عليه، والحارس الذي يُزعج بلا سبب يُحذف.
     */
    const fine = [
      "org/model-name",
      "hf:model-name",
      "ysd/alpha:2026-01",
      "a/b/c",
      "model:v2",
      "ysd-alpha-2026-01",
      "registry.internal/ysd/alpha",
    ];
    for (const runtimeModel of fine) {
      const d = deps();
      const res = await stageWith(true, d, { runtimeModel });
      expect(res.ok, runtimeModel).toBe(true);
      expect(d.__admin.calls[0]![1].p_runtime_model, runtimeModel).toBe(runtimeModel);
    }
  });

  it("★ والحارس نفسه في القاعدة — لا في TypeScript وحده", () => {
    /**
     * الدالة تُنفَّذ بـ`service_role`، ونصٌّ تشغيليّ يستدعيها مباشرةً لا
     * يمرّ بالمساعد. والحراسة تكون عند المورد.
     */
    const code = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain("if v_runtime ~ '^([A-Za-z][A-Za-z0-9+.-]*://|//)' then");
    expect(code).toContain("return 'invalid_input'");
  });
});

describe("★ (٣٢) هوية الأساس تشمل الغياب", () => {
  it("★ ★ والقيد في القاعدة يقارن الغياب كقيمة", () => {
    /**
     * الشرط القديم كان يتخطّى الفحص حين يأتي الأساس فارغًا، فيقبل
     * تسجيلًا يزعم أن النسخة بلا أساس بينما المسجَّل يقول `base-a`.
     * ونجاحٌ يعقبه اختلافٌ في المعنى أسوأ من رفضٍ صريح.
     */
    const code = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain("if v_v_base is distinct from v_base then");
    // ولا يبقى الشرط القديم الذي يتخطّى الفحص عند الغياب
    expect(code).not.toContain("if v_base is not null and v_v_base is distinct from v_base");
  });

  it("★ وحدّ طول الأساس مفروض في القاعدة كذلك", () => {
    const code = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain("if v_base is not null and length(v_base) > 256 then");
  });
});

describe("★ (٣٣) النسخة تُطبَّع عند الحدّ", () => {
  it("★ ★ فمصدر الحقيقة واحد: `parsed.data.version`", () => {
    /**
     * كان القصّ يقع داخل المساعد وحده، فتدخل القاعدة `"1.4.2"` ويُسجَّل
     * في التدقيق `"  1.4.2  "`. وسجلُّ تدقيقٍ يخالف ما وقع فعلًا أسوأ من
     * غيابه: يُبحَث فيه لاحقًا عن رقمٍ لا يطابق شيئًا في الجداول.
     */
    expect(ROUTE_SRC).toContain("version: z.string().trim().min(1).max(64),");
    // والقيمة نفسها تذهب إلى المساعد وإلى التدقيق
    expect(ROUTE_SRC).toContain("version: parsed.data.version,");
    // الشيفرة وحدها تُعدّ: الشرح يذكر الاسم ليقول لِمَ هو مصدر الحقيقة
    const routeCode = ROUTE_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect((routeCode.match(/parsed\.data\.version/g) ?? []).length).toBe(2);
  });

  it("★ ★ والمخطّط يقصّ فعلًا — لا في الشرح وحده", async () => {
    const { z } = await import("zod");
    const schema = z.object({ version: z.string().trim().min(1).max(64) });
    expect(schema.parse({ version: "  1.4.2  " }).version).toBe("1.4.2");
    // والفراغ وحده يُرفض بعد القصّ
    expect(schema.safeParse({ version: "   " }).success).toBe(false);
  });

  it("★ والمساعد يتلقّى القيمة المطبَّعة ويمرّرها كما هي", async () => {
    const d = deps();
    await stageWith(true, d, { version: "1.4.2" });
    expect(d.__admin.calls[0]![1].p_version).toBe("1.4.2");
  });
});

/* ═══════════ (٢٥–٣٠) الترحيلة والأمن ═══════════ */

describe("★ (٢٥–٣٠) 0039 وما لا تفعله", () => {
  const code = MIGRATION.split("\n")
    .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
    .join("\n");

  it("★ (٢٥) ★ الدالة لـservice_role وحده", () => {
    expect(code).toContain("from public;");
    expect(code).toContain("from anon;");
    expect(code).toContain("from authenticated;");
    expect(code).toContain("to service_role;");
    expect(code).not.toContain("to authenticated;");
  });

  it("★ (٢٦) ★ وتشترط أن تكون الأهليّة مغلقة", () => {
    expect(code).toContain("if v_model_enabled then return 'model_gate_must_be_off'; end if;");
    // والقفل قبل القراءة
    const lockAt = code.indexOf("for update");
    const checkAt = code.indexOf("if v_model_enabled then");
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(checkAt);
  });

  it("★ (٢٧) ★ ولا تُرقّي نسخةً موجودة ولا تكتب فوقها", () => {
    expect(code).toContain("if v_v_status is distinct from 'approved' then return 'version_conflict'");
    expect(code).toContain("if v_v_artifact is distinct from v_artifact then return 'version_conflict'");
    // ولا `update` على النسخ إطلاقًا
    expect(code).not.toMatch(/update\s+ai_model_versions/i);
  });

  it("★ (٢٨) ★ والتقاعد ثم الإنشاء بلا استثناءٍ يبتلع نصف العملية", () => {
    /**
     * الدالة تعمل داخل معاملة المستدعي، فأي فشلٍ بعد التقاعد يُرجعه معه.
     * و`exception when others` هنا كان سيثبّت التقاعد ويسقط الإنشاء —
     * فتنتهي البيئة بلا نشرة نشطة إطلاقًا.
     */
    expect(code).toContain("set status = 'retired', retired_at = now()");
    expect(code).toContain("insert into ai_model_deployments");
    expect(code.toLowerCase()).not.toContain("exception when");
    expect(code.toLowerCase()).not.toContain("savepoint");
  });

  it("★ (٢٩) ★ ولا تفعّل الترحيلة شيئًا ولا تزرع", () => {
    expect(code.toLowerCase()).not.toMatch(/update\s+(public\.)?ai_models\s+set\s+enabled/);
    expect(code.toLowerCase()).not.toMatch(/insert\s+into\s+(public\.)?ai_models\b/);
    expect(code).not.toContain("YSD_MODEL_ALPHA_ENABLED");
  });

  it("★ (٣٠) وهي الأحدث ترقيمًا، ولا تُمسّ سابقاتها", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0039_ysd_release_staging.sql");
    const numbers = files.map((f) => Number(f.slice(0, f.indexOf("_"))));
    /**
     * ★ حُدِّث في بنك التدريب (0040).
     *
     * الثابت المحروس هو أن **هذه الرقعة** لم تُدخل ترحيلة، لا أن المشروع
     * توقّف عند رقمٍ بعينه. وربطُه بالأعلى يجعل كل ترحيلةٍ لاحقة تُسقطه
     * بلا خطأ حقيقيّ — و«0040 هي الأحدث» يملكه v107.
     */
    expect(numbers).toContain(39);
    for (let n = 1; n <= 39; n++) expect(numbers, String(n)).toContain(n);
    expect(new Set(numbers).size).toBe(numbers.length);

    const { execFileSync } = await import("node:child_process");
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
      { encoding: "utf8" },
    );
    for (const kept of ["0036_", "0037_", "0038_"]) {
      expect(changed, kept).not.toContain(kept);
    }
  });

  it("★ ★ ولا تفعيل عامّ من هذه الرقعة", async () => {
    const env = readSrc(".env.example");
    expect(env).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    expect(env).not.toContain("YSD_MODEL_ALPHA_ENABLED=1");

    const { YSDProvider } = await import("@/lib/ai/ysd");
    const p = new YSDProvider();
    expect(p.fallbackPolicy).toBe("none");
    expect(p.fallbackEligible).toBe(false);

    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });

  it("★ ولا يُطبع سرٌّ ولا يُقرأ مفتاح خدمةٍ في المساعد", () => {
    const src = RELEASE_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const forbidden of ["console.", "SUPABASE_SERVICE_ROLE_KEY", "process.env"]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    expect(RELEASE_SRC.startsWith('import "server-only";')).toBe(true);
  });
});
