/**
 * جاهزية الفتح العامّ لنموذج YSD (v0.9.3، الرقعة الحادية عشرة).
 *
 * ── السؤال ──
 *
 * «هل كل شيءٍ مهيّأ بحيث تكون الخطوة التالية الآمنة هي **فقط** فتح
 * المفتاح؟» — ولا يُفتح هنا، ولا يُكتب حرف، ولا يُستهلك رمز.
 *
 * ── والعقد الذي يبدو تناقضًا وليس كذلك ──
 *
 *   ready: true  مع  publiclyEnabled: false
 *
 * هما جوابا سؤالين: «أيجوز أن نخطو؟» و«أخطونا؟». وخلطُهما هو بالضبط ما
 * بُنيت هذه السلسلة كلها لتمنعه — أن يصير التحقّق من الإمكان إذنًا بالفعل.
 *
 * ── والترتيب هو معناها ──
 *
 *   المالك ⇐ المفتاح مغلق ⇐ المزوّد ⇐ أهليّة القاعدة ⇐ القائمة ⇐ الفحص.
 *
 * والفحص آخرًا لأنه وحده رحلة شبكة. ويُقاس ذلك **بالسلوك** لا بقراءة
 * المصدر: جاسوسٌ لم يُستدعَ أصدق من سطرٍ مكتوب.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import { checkYSDPublicActivationReadiness } from "@/lib/ai/ysd-public-readiness";
import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "@/lib/ai/ysd";
import { AI_SETTING_KEYS } from "@/lib/ai/ai-settings";
import type { AIProviderAdapter, ProviderHealth } from "@/lib/ai/types";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const HELPER_SRC = readSrc("lib/ai/ysd-public-readiness.ts");
const ROUTE_SRC = readSrc("app/api/admin/ysd/readiness/route.ts");
const ENV_EXAMPLE = readSrc(".env.example");

const RUNTIME_MODEL = "ysd-alpha-2026-01";
const ALIAS = "ysd-inference-primary";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const CONNECTED: ProviderHealth = { status: "connected", modelCount: 5, latencyMs: 9 };

const modelRow = (over: Record<string, unknown> = {}) => ({
  id: YSD_ALPHA_MODEL_ID,
  provider_id: YSD_PROVIDER_ID,
  enabled: true,
  ...over,
});

/**
 * عميلٌ في الذاكرة يحاكي سلسلة `postgrest` للجدولين المستعملين.
 *
 * ويسجّل كل استدعاء — كي يُقاس **ما لم يقع** أيضًا: أن لا كتابة جرت، وأن
 * الأعمدة صريحة، وأن الفحص لم يُستدعَ حين وجب ألّا يُستدعى.
 */
function memoryAdmin(opts: {
  models?: Array<Record<string, unknown>> | null;
  modelsError?: boolean;
  settings?: Array<{ key: string; value: unknown }> | null;
  settingsError?: boolean;
} = {}) {
  const calls = {
    tables: [] as string[],
    selects: [] as string[],
    filters: [] as Array<[string, unknown]>,
    writes: 0,
  };

  const client = {
    from(table: string) {
      calls.tables.push(table);
      const write = () => {
        calls.writes += 1;
        return Promise.resolve({ data: null, error: null });
      };
      return {
        select(cols: string) {
          calls.selects.push(cols);
          const chain = {
            eq(col: string, val: unknown) {
              calls.filters.push([col, val]);
              return chain;
            },
            limit() {
              if (table === "ai_models") {
                return Promise.resolve(
                  opts.modelsError
                    ? { data: null, error: { code: "42P01", message: `denied ${KEY}` } }
                    : { data: opts.models ?? [modelRow()], error: null },
                );
              }
              return Promise.resolve(
                opts.settingsError
                  ? { data: null, error: { code: "42501", message: `denied ${KEY}` } }
                  : { data: opts.settings ?? [], error: null },
              );
            },
          };
          return chain;
        },
        update: write,
        insert: write,
        upsert: write,
        delete: write,
      };
    },
    rpc: () => {
      calls.writes += 1;
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, calls };
}

const ysdProvider = (health?: () => Promise<ProviderHealth>) => {
  const spy = vi.fn(health ?? (async () => CONNECTED));
  return {
    provider: {
      id: YSD_PROVIDER_ID,
      displayName: "YSD",
      healthCheck: spy,
    } as unknown as AIProviderAdapter,
    spy,
  };
};

const otherProvider = (): AIProviderAdapter =>
  ({ id: "openrouter", displayName: "OpenRouter" }) as unknown as AIProviderAdapter;

/** يبني الاعتمادات ويكشف الجواسيس — فيُقاس الترتيب سلوكًا */
function scenario(
  over: {
    isOwner?: boolean;
    killSwitchOn?: boolean;
    providers?: AIProviderAdapter[];
    adminClient?: unknown;
    adminThrows?: boolean;
    health?: () => Promise<ProviderHealth>;
    db?: Parameters<typeof memoryAdmin>[0];
  } = {},
) {
  const admin = memoryAdmin(over.db);
  const { provider, spy: healthSpy } = ysdProvider(over.health);
  const getAdminClient = vi.fn(() => {
    if (over.adminThrows) throw new Error(`SERVICE_ROLE=${KEY}`);
    return over.adminClient === undefined ? admin.client : over.adminClient;
  });

  const deps = {
    isKillSwitchOn: vi.fn(() => over.killSwitchOn === true),
    listConfiguredProviders: vi.fn(
      () => over.providers ?? [otherProvider(), provider],
    ),
    getAdminClient,
  };

  return {
    admin,
    healthSpy,
    deps,
    run: () =>
      checkYSDPublicActivationReadiness(
        over.isOwner ?? true,
        deps as unknown as Parameters<typeof checkYSDPublicActivationReadiness>[1],
      ),
  };
}

const reasonOf = (r: Awaited<ReturnType<typeof checkYSDPublicActivationReadiness>>) =>
  r.ok ? null : r.reason;

const allowRow = (value: unknown) => [{ key: AI_SETTING_KEYS.allowedModels, value }];

/* ═══════════ (١–٢) قبل أي قاعدة وأي شبكة ═══════════ */

describe("★ (١–٢) ما يُرفض قبل أن يُلمس شيء", () => {
  it("★ (١) ★ مشرفٌ ليس مالكًا ⇒ رفض بصفر قاعدة وصفر فحص", async () => {
    const s = scenario({ isOwner: false });
    expect(reasonOf(await s.run())).toBe("owner_required");
    expect(s.deps.getAdminClient).not.toHaveBeenCalled();
    expect(s.healthSpy).not.toHaveBeenCalled();
    expect(s.admin.calls.tables).toHaveLength(0);
  });

  it("★ (٢) ★ والمفتاح مفتوح أصلًا ⇒ رفض — السؤال فات أوانه", async () => {
    /**
     * هذه الدالة تسأل «أنحن جاهزون للفتح؟» لا «أمفتوحٌ الآن؟». و«جاهز»
     * والمفتاح مفتوح جوابٌ عن سؤالٍ لم يُسأل: يوهم المشغّل بأن فحصًا وقع
     * قبل الفتح ولم يقع.
     */
    const s = scenario({ killSwitchOn: true });
    expect(reasonOf(await s.run())).toBe("kill_switch_must_be_off");
    expect(s.deps.getAdminClient).not.toHaveBeenCalled();
    expect(s.healthSpy).not.toHaveBeenCalled();
    expect(s.admin.calls.tables).toHaveLength(0);
  });
});

/* ═══════════ (٣–٥) المزوّد وعميل الخدمة ═══════════ */

describe("★ (٣–٥) البنية", () => {
  it("★ (٣) المزوّد غير مهيّأ ⇒ رفض بلا قاعدة ولا فحص", async () => {
    const s = scenario({ providers: [otherProvider()] });
    expect(reasonOf(await s.run())).toBe("provider_not_configured");
    expect(s.deps.getAdminClient).not.toHaveBeenCalled();
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٣′) وقائمةٌ فارغة ⇒ رفض", async () => {
    expect(reasonOf(await scenario({ providers: [] }).run())).toBe("provider_not_configured");
  });

  it("★ (٤) وعميل الخدمة null ⇒ رفض", async () => {
    const s = scenario({ adminClient: null });
    expect(reasonOf(await s.run())).toBe("admin_client_unavailable");
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٥) وعميلٌ يرمي ⇒ رفض بلا نصّ", async () => {
    const s = scenario({ adminThrows: true });
    const res = await s.run();
    expect(reasonOf(res)).toBe("admin_client_unavailable");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

/* ═══════════ (٦–١٠) أهليّة القاعدة ═══════════ */

describe("★ (٦–١٠) الصفّ يُقرأ ولا يُكتب", () => {
  it("★ (٦) صفٌّ مفقود ⇒ model_not_found", async () => {
    const s = scenario({ db: { models: [] } });
    expect(reasonOf(await s.run())).toBe("model_not_found");
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٧) وصفّان بالمعرّف نفسه ⇒ database_error", async () => {
    const s = scenario({ db: { models: [modelRow(), modelRow()] } });
    expect(reasonOf(await s.run())).toBe("database_error");
  });

  it("★ (٨) ★ ومزوّدٌ آخر يملك المعرّف ⇒ فشل مغلق", async () => {
    const s = scenario({ db: { models: [modelRow({ provider_id: "openrouter" })] } });
    expect(reasonOf(await s.run())).toBe("database_error");
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٩) ★ والأهليّة مغلقة ⇒ model_gate_off بصفر فحص", async () => {
    const s = scenario({ db: { models: [modelRow({ enabled: false })] } });
    expect(reasonOf(await s.run())).toBe("model_gate_off");
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٩′) وقيمةٌ غير منطقية في العمود ⇒ مغلقة كذلك", async () => {
    for (const enabled of [null, undefined, 0, 1, "true"]) {
      const s = scenario({ db: { models: [modelRow({ enabled })] } });
      expect(reasonOf(await s.run()), String(enabled)).toBe("model_gate_off");
    }
  });

  it("★ (١٠) والأهليّة مفتوحة ⇒ يُكمل إلى القائمة", async () => {
    const s = scenario({ db: { models: [modelRow()] } });
    expect((await s.run()).ok).toBe(true);
    expect(s.admin.calls.tables).toContain("platform_settings");
  });

  it("★ والقراءة بأعمدة صريحة وبمرشّحٍ على المعرّف", async () => {
    const s = scenario();
    await s.run();
    expect(s.admin.calls.selects[0]).toBe("id, provider_id, enabled");
    expect(s.admin.calls.filters).toContainEqual(["id", YSD_ALPHA_MODEL_ID]);
  });

  it("★ (١٨) وخطأ القاعدة ⇒ رمزٌ لا نصّ", async () => {
    const s = scenario({ db: { modelsError: true } });
    const res = await s.run();
    expect(reasonOf(res)).toBe("database_error");
    const dump = JSON.stringify(res);
    for (const leak of ["42P01", KEY, "denied"]) expect(dump, leak).not.toContain(leak);
  });
});

/* ═══════════ (١١–١٨) قائمة السماح ═══════════ */

describe("★ (١١–١٨) القائمة تُقرأ ويُحكم عليها", () => {
  const runWith = async (settings: Array<{ key: string; value: unknown }> | null) => {
    const s = scenario({ db: { settings } });
    const res = await s.run();
    return { res, health: s.healthSpy };
  };

  it("★ (١١) لا صفّ ⇒ لا قيد", async () => {
    const { res } = await runWith([]);
    expect(res.ok).toBe(true);
  });

  it("★ (١٢) وقيمةٌ غائبة ⇒ لا قيد", async () => {
    for (const value of [null, undefined]) {
      const { res } = await runWith(allowRow(value));
      expect(res.ok, String(value)).toBe(true);
    }
  });

  it("★ (١٣) وقائمةٌ فارغة ⇒ ممنوع", async () => {
    const { res, health } = await runWith(allowRow([]));
    expect(reasonOf(res)).toBe("allowlist_blocked");
    expect(health).not.toHaveBeenCalled();
  });

  it("★ (١٤) ★ وقائمةٌ بلا النموذج ⇒ ممنوع بصفر فحص", async () => {
    const { res, health } = await runWith(allowRow(["ysd/free", "anthropic/opus"]));
    expect(reasonOf(res)).toBe("allowlist_blocked");
    expect(health).not.toHaveBeenCalled();
  });

  it("★ (١٥) وقائمةٌ تحويه ⇒ يمرّ", async () => {
    const { res } = await runWith(allowRow(["ysd/free", YSD_ALPHA_MODEL_ID]));
    expect(res.ok).toBe(true);
  });

  it("★ (١٦) ★ وعنصرٌ ليس نصًّا ⇒ تالفة لا متساهلة", async () => {
    /**
     * قيمةٌ لا نفهم شكلها لا تعني «لا قيد»؛ تعني أننا لا نعرف ما القيد.
     * والتساهلُ هنا يجعل إعدادًا فاسدًا يوافق على فتحٍ عامّ — وهو أسوأ ما
     * يمكن أن يقوله فحصُ جاهزية.
     */
    const bad: unknown[][] = [
      [YSD_ALPHA_MODEL_ID, 42],
      [YSD_ALPHA_MODEL_ID, null],
      [YSD_ALPHA_MODEL_ID, { id: YSD_ALPHA_MODEL_ID }],
      [null],
      [{ id: YSD_ALPHA_MODEL_ID }],
    ];
    for (const value of bad) {
      const { res, health } = await runWith(allowRow(value));
      expect(reasonOf(res), JSON.stringify(value)).toBe("allowlist_invalid");
      expect(health, JSON.stringify(value)).not.toHaveBeenCalled();
    }
  });

  it("★ (١٧) ★ وأي نوعٍ آخر ⇒ تالفة", async () => {
    const bad: unknown[] = [
      "ysd/model-alpha",
      42,
      true,
      { models: [YSD_ALPHA_MODEL_ID] },
      { [YSD_ALPHA_MODEL_ID]: true },
    ];
    for (const value of bad) {
      const { res } = await runWith(allowRow(value));
      expect(reasonOf(res), JSON.stringify(value)).toBe("allowlist_invalid");
    }
  });

  it("★ (١٨) وخطأ استعلام الإعدادات ⇒ database_error بلا نصّ", async () => {
    const s = scenario({ db: { settingsError: true } });
    const res = await s.run();
    expect(reasonOf(res)).toBe("database_error");
    expect(JSON.stringify(res)).not.toContain("42501");
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ وصفّان للمفتاح نفسه ⇒ فشل مغلق", async () => {
    const s = scenario({
      db: { settings: [...allowRow([YSD_ALPHA_MODEL_ID]), ...allowRow(null)] },
    });
    expect(reasonOf(await s.run())).toBe("database_error");
  });

  it("★ ★ ولا تُستعمل `isModelAllowed`", () => {
    /**
     * تلك تسأل «أيظهر النموذج للمستخدم الآن؟»، وجوابها اليوم «لا» لأن
     * المفتاح مغلق — وهو الشرط الذي نتحقّق منه عمدًا. فاستعمالُها يجعل
     * الفحص يفشل دائمًا لسببٍ نحن الذين اشترطناه.
     */
    const code = HELPER_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("isModelAllowed");
    expect(code).not.toContain("listModelOptions");
    expect(code).toContain("AI_SETTING_KEYS.allowedModels");
  });
});

/* ═══════════ (١٩–٢٦) الفحص أخيرًا ═══════════ */

describe("★ (١٩–٢٦) الحلقة الأخيرة", () => {
  it("★ (١٩) مزوّدٌ بلا فاحص ⇒ رفض", async () => {
    const bare = { id: YSD_PROVIDER_ID, displayName: "YSD" } as unknown as AIProviderAdapter;
    const s = scenario({ providers: [bare] });
    expect(reasonOf(await s.run())).toBe("health_not_connected");
  });

  it("★ (٢٠–٢٣) ★ وكل حالةٍ سوى connected ⇒ رفض", async () => {
    for (const status of [
      "not_configured",
      "unauthorized",
      "unreachable",
      "no_models",
      "unsupported",
    ] as const) {
      const s = scenario({ health: async () => ({ status, latencyMs: 2 }) });
      const res = await s.run();
      expect(reasonOf(res), status).toBe("health_not_connected");
      expect(JSON.stringify(res), status).not.toContain(status);
    }
  });

  it("★ (٢٤) والفاحص الذي يرمي ⇒ رفضٌ آمن", async () => {
    const s = scenario({
      health: async () => {
        throw new Error(`${BASE_URL} رفض ${RUNTIME_MODEL} بـ${KEY}`);
      },
    });
    const res = await s.run();
    expect(reasonOf(res)).toBe("health_not_connected");
    for (const leak of [BASE_URL, RUNTIME_MODEL, KEY]) {
      expect(JSON.stringify(res), leak).not.toContain(leak);
    }
  });

  it("★ (٢٥–٢٦) ★ و`connected` ⇒ جاهز، والخدمة ما تزال مغلقة", async () => {
    const s = scenario();
    const res = await s.run();
    expect(res).toEqual({ ok: true, ready: true, publiclyEnabled: false });
    expect(s.healthSpy).toHaveBeenCalledTimes(1);
  });
});

/* ═══════════ (٢٧–٣٠) الترتيب سلوكًا ═══════════ */

describe("★ (٢٧–٣٠) الأغلى أخيرًا", () => {
  it("★ (٢٧) ★ أهليّةٌ مغلقة ⇒ صفر نداء فحص", async () => {
    const s = scenario({ db: { models: [modelRow({ enabled: false })] } });
    await s.run();
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٢٨) ★ وقائمةٌ تمنع ⇒ صفر نداء فحص", async () => {
    const s = scenario({ db: { settings: allowRow(["ysd/free"]) } });
    await s.run();
    expect(s.healthSpy).not.toHaveBeenCalled();
  });

  it("★ (٢٩–٣٠) ★ والترتيب كاملًا كما هو مُعلَن", async () => {
    /**
     * يُقاس بالسلوك لا بقراءة المصدر: تسلسلٌ يُسجَّل عند كل خطوة، فيُثبت
     * أن الفحص وقع **بعد** قراءتَي القاعدة كلتيهما.
     */
    const order: string[] = [];
    const admin = memoryAdmin();
    const wrapped = {
      from(table: string) {
        order.push(`db:${table}`);
        return admin.client.from(table);
      },
    };
    const { provider } = ysdProvider(async () => {
      order.push("health");
      return CONNECTED;
    });

    const deps = {
      isKillSwitchOn: () => {
        order.push("kill");
        return false;
      },
      listConfiguredProviders: () => {
        order.push("providers");
        return [provider];
      },
      getAdminClient: () => {
        order.push("admin");
        return wrapped;
      },
    };

    const res = await checkYSDPublicActivationReadiness(
      true,
      deps as unknown as Parameters<typeof checkYSDPublicActivationReadiness>[1],
    );
    expect(res.ok).toBe(true);
    expect(order).toEqual([
      "kill",
      "providers",
      "admin",
      "db:ai_models",
      "db:platform_settings",
      "health",
    ]);
  });
});

/* ═══════════ لا كتابة ولا توليد ═══════════ */

describe("★ قراءةٌ خالصة", () => {
  it("★ ★ صفر كتابة في كل مسار", async () => {
    const cases: Array<Parameters<typeof scenario>[0]> = [
      {},
      { db: { models: [modelRow({ enabled: false })] } },
      { db: { settings: allowRow([]) } },
      { db: { settings: allowRow(42) } },
      { health: async () => ({ status: "unreachable" as const }) },
      { db: { modelsError: true } },
    ];
    for (const over of cases) {
      const s = scenario(over);
      await s.run();
      expect(s.admin.calls.writes, JSON.stringify(over)).toBe(0);
    }
  });

  it("★ ★ ولا كتابةَ في المصدر أصلًا", () => {
    const code = HELPER_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const forbidden of [".update(", ".insert(", ".upsert(", ".delete(", ".rpc("]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ★ ولا توليدَ ولا شبكةَ سوى الفاحص المحقون", () => {
    const code = HELPER_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const forbidden of [
      "fetch(",
      "streamChat",
      "requestJsonCompletion",
      "streamYSDRuntimeChat",
      "requestYSDRuntimeJsonCompletion",
      "chat/completions",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // والفاحص وحده هو منفذ الشبكة
    expect(code).toContain("provider.healthCheck()");
  });

  it("★ ولا يستدعي مساري التدرّج تلقائيًّا", () => {
    for (const src of [HELPER_SRC, ROUTE_SRC]) {
      expect(src).not.toContain("stageYSDDatabaseEligibility");
      expect(src).not.toContain("stageYSDRelease");
      expect(src).not.toContain("ysd_stage_release");
    }
  });
});

/* ═══════════ المسار الإداريّ ═══════════ */

describe("★ المسار: قراءةٌ للمالك بلا تخزين", () => {
  it("★ GET وحدها", () => {
    expect(ROUTE_SRC).toContain("export async function GET()");
    for (const verb of ["POST", "PATCH", "DELETE", "PUT"]) {
      expect(ROUTE_SRC, verb).not.toContain(`export async function ${verb}`);
    }
  });

  it("★ ومالكٌ فقط", () => {
    expect(ROUTE_SRC).toContain("checkYSDPublicActivationReadiness(ctx.isOwner)");
    expect(ROUTE_SRC).toContain("owner_required: { status: 403");
  });

  it("★ ★ ولا تُخزَّن الجاهزية", () => {
    /**
     * لقطةٌ مُخزَّنة تقول «جاهز» بعد أن سقط وقت التشغيل بدقيقة هي أسوأ ما
     * يمكن أن يُعرض هنا: يُفتح المفتاح على جوابٍ صار كاذبًا.
     */
    expect(ROUTE_SRC).toContain('"Cache-Control": "no-store, no-cache, must-revalidate"');
  });

  it("★ والردّ يقول دائمًا إن الخدمة مغلقة", () => {
    const code = ROUTE_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect((code.match(/publiclyEnabled: false/g) ?? []).length).toBe(2);
    expect(code).not.toContain("publiclyEnabled: true");
    expect(code).toContain("ready: true");
  });

  it("★ ★ ولا معرّف ولا سرّ في أي ردّ", () => {
    for (const forbidden of [
      "runtimeModel",
      "artifactRef",
      "deploymentId",
      "modelVersionId",
      "endpointAlias",
      "baseUrl",
      "apiKey",
      "SUPABASE_SERVICE_ROLE_KEY",
      "YSD_MODEL_ALPHA_ENABLED",
    ]) {
      expect(ROUTE_SRC, forbidden).not.toContain(forbidden);
      expect(HELPER_SRC, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ولا سجلّ نصّيّ من أيٍّ منهما", async () => {
    for (const src of [HELPER_SRC, ROUTE_SRC]) {
      const code = src
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toContain("console.");
    }
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    try {
      await scenario().run();
      await scenario({ db: { modelsError: true } }).run();
      await scenario({ health: async () => ({ status: "unreachable" as const }) }).run();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(logs).toEqual([]);
  });

  it("★ وكل سببٍ في الاتّحاد له تحويلٌ في الجدول", () => {
    const union = HELPER_SRC.slice(
      HELPER_SRC.indexOf("      reason:"),
      HELPER_SRC.indexOf("const fail ="),
    );
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(reasons.length).toBe(10);
    const table = ROUTE_SRC.slice(ROUTE_SRC.indexOf("const READINESS_FAILURES"));
    for (const r of reasons) expect(table, r).toContain(`${r}:`);
  });
});

/* ═══════════ الخدمة تبقى مغلقة ═══════════ */

describe("★ لا تفعيل من هذه الرقعة", () => {
  it("★ المفتاح افتراضه الإغلاق ولم يُمسّ", () => {
    expect(ENV_EXAMPLE).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    expect(ENV_EXAMPLE).not.toContain("YSD_MODEL_ALPHA_ENABLED=1");
  });

  it("★ ولا ترحيلة جديدة", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files.some((f) => f.startsWith("0040"))).toBe(false);
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(39);
  });

  it("★ ولا ترحيلةَ تفعّل النموذج", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    for (const f of files) {
      const sql = readSrc(`supabase/migrations/${f}`).toLowerCase();
      expect(sql, f).not.toContain("update public.ai_models set enabled = true");
    }
  });

  it("★ ودلالة مفتاح الإذن كما هي", () => {
    const activation = readSrc("lib/ai/ysd-activation.ts");
    expect(activation).toContain('return env.YSD_MODEL_ALPHA_ENABLED === "1";');
  });

  it("★ وسياستا العبور وysd/free", async () => {
    const { YSDProvider } = await import("@/lib/ai/ysd");
    const p = new YSDProvider();
    expect(p.fallbackPolicy).toBe("none");
    expect(p.fallbackEligible).toBe(false);

    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });

  it("★ ولا يُقرأ معرّف نشرةٍ ولا نسخة في هذا المسار", () => {
    for (const id of [DEPLOYMENT_ID, VERSION_ID, ALIAS]) {
      expect(HELPER_SRC, id).not.toContain(id);
    }
  });
});
