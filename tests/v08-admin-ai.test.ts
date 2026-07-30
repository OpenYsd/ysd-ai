/**
 * لوحة إدارة الذكاء الاصطناعي (v0.8.0) — عقود التخزين والتحقق والصلاحيات.
 *
 * لا شبكة ولا مزوّد حقيقي: المزوّد الوهمي على 127.0.0.1، والقاعدة عميل بسيط
 * في الذاكرة يحاكي platform_settings. الغرض قياس العقود لا تكامل Supabase.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AI_SETTING_KEYS,
  ALLOWED_SETTING_KEYS,
  getAiSettings,
  isModelAllowed,
  listAdminProviders,
  listAllowedModelOptions,
  resolveDefaultModel,
  setAiSetting,
} from "../lib/ai/ai-settings";
import {
  _resetProviderActions,
  consumeProviderAction,
  isProviderActionInFlight,
  releaseProviderAction,
} from "../lib/ai/provider-actions";
import { aiProviderActionSchema, aiSettingsPatchSchema } from "../lib/validation/admin";
import { NineRouterProvider, _resetNineRouterCache } from "../lib/ai/nine-router";
import { _resetAdminClient } from "../lib/supabase/admin";
import { getConfiguredProviders, listModelOptions } from "../lib/ai/registry";

/** عميل قاعدة في الذاكرة يكفي لعقود platform_settings المستعملة هنا */
function memoryDb() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    from(table: string) {
      if (table !== "platform_settings") throw new Error(`جدول غير متوقَّع: ${table}`);
      return {
        select() {
          return {
            in(_col: string, keys: string[]) {
              return Promise.resolve({
                data: keys.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k) })),
              });
            },
          };
        },
        upsert(row: { key: string; value: unknown }) {
          rows.set(row.key, row.value);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}
type Db = ReturnType<typeof memoryDb>;
const asClient = (db: Db) => db as unknown as Parameters<typeof getAiSettings>[0];

/** حارس الصلاحيات كما في getAdminContext + forbidden */
function adminGate(role: string | null): number {
  if (role === null) return 403; // العقد الحالي: غير مسجّل ⇒ 403 من forbidden()
  if (role !== "admin" && role !== "owner") return 403;
  return 200;
}

let server: http.Server;
let baseUrl = "";
let modelsMode: "ok" | "empty" | "401" | "dead" = "ok";

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    if (modelsMode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "سرّ داخلي لا يخرج" } }));
      return;
    }
    const data = modelsMode === "empty" ? [] : [{ id: "oc/north-mini-code-free" }, { id: "oc/other" }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  _resetNineRouterCache();
  _resetProviderActions();
  modelsMode = "ok";
  process.env.NINE_ROUTER_ENABLED = "1";
  process.env.NINE_ROUTER_BASE_URL = baseUrl;
  process.env.NINE_ROUTER_DEFAULT_MODEL = "oc/north-mini-code-free";
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
});
afterEach(() => {
  for (const k of ["NINE_ROUTER_ENABLED", "NINE_ROUTER_BASE_URL", "NINE_ROUTER_DEFAULT_MODEL"]) {
    delete process.env[k];
  }
});

describe("★ A — الصلاحيات", () => {
  it("★ admin وowner يمرّان", () => {
    expect(adminGate("admin")).toBe(200);
    expect(adminGate("owner")).toBe(200);
  });
  it("★ مستخدم عادي ⇒ 403", () => {
    expect(adminGate("user")).toBe(403);
    expect(adminGate("beta")).toBe(403);
  });
  it("★ غير مسجّل ⇒ 403 (العقد الحالي)", () => {
    expect(adminGate(null)).toBe(403);
  });
});

describe("★ B — الحفظ والاسترجاع", () => {
  /**
   * القراءة وحدها تُختبر هنا. الكتابة تمرّ بعميل الخدمة عمدًا (RLS على
   * platform_settings تسمح بالقراءة فقط)، فلا تقبل عميلًا وهميًا — ولا يجوز
   * إضافة ثغرة اختبارية في مسار كتابة إداري لمجرد تسهيل الاختبار. مسار
   * الكتابة الحقيقي مغطّى في اختبار التكامل مقابل Supabase الفعلي.
   */
  it("★ قراءة المزوّد والنموذج الافتراضيين", async () => {
    const db = memoryDb();
    db.rows.set(AI_SETTING_KEYS.defaultProvider, "nine_router");
    db.rows.set(AI_SETTING_KEYS.defaultModel, "oc/north-mini-code-free");
    const s = await getAiSettings(asClient(db));
    expect(s.defaultProvider).toBe("nine_router");
    expect(s.defaultModel).toBe("oc/north-mini-code-free");
  });

  it("★ القيَم تبقى ثابتة عبر قراءات متتالية (تحديث قسري)", async () => {
    const db = memoryDb();
    db.rows.set(AI_SETTING_KEYS.allowedModels, ["ysd/free"]);
    expect((await getAiSettings(asClient(db))).allowedModels).toEqual(["ysd/free"]);
    expect((await getAiSettings(asClient(db))).allowedModels).toEqual(["ysd/free"]);
  });

  it("★ الكتابة ترفض العمل بلا عميل خدمة — لا نجاح كاذب", async () => {
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    _resetAdminClient();
    try {
      const wrote = await setAiSetting(
        asClient(memoryDb()), AI_SETTING_KEYS.defaultProvider, "nine_router", null,
      );
      expect(wrote).toBe(false);
    } finally {
      if (saved) process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
      _resetAdminClient();
    }
  });

  /**
   * حارس وقت التشغيل. النوع يحصر المفتاح في الأربعة لكنه يتبخّر عند البناء،
   * فأول مستدعٍ غير مُنمَّط يكتب أي مفتاح بعميل الخدمة — أي بتجاوز RLS.
   */
  it("★ مفتاح خارج القائمة البيضاء يُرفض قبل أي كتابة", async () => {
    for (const bad of ["apiKey", "baseUrl", "token", "ai.evil", "maintenance_mode", ""]) {
      const wrote = await setAiSetting(
        asClient(memoryDb()), bad as never, "x", null,
      );
      expect(wrote, `المفتاح ${bad} كان يجب أن يُرفض`).toBe(false);
    }
  });

  it("★ المفاتيح الأربعة وحدها في القائمة البيضاء", () => {
    expect([...ALLOWED_SETTING_KEYS].sort()).toEqual(
      ["ai.allowed_models", "ai.default_model", "ai.default_provider", "ai.models_cache"],
    );
  });

  it("★ لا إعداد محفوظ ⇒ قيَم آمنة لا انهيار", async () => {
    const s = await getAiSettings(asClient(memoryDb()));
    expect(s.defaultProvider).toBeNull();
    expect(s.defaultModel).toBeNull();
    expect(s.allowedModels).toBeNull(); // null = بلا تقييد
    expect(s.modelsCache).toEqual({});
  });

  it("★ قيمة تالفة في القاعدة لا تُسقط القراءة", async () => {
    const db = memoryDb();
    db.rows.set(AI_SETTING_KEYS.allowedModels, "ليست مصفوفة");
    db.rows.set(AI_SETTING_KEYS.defaultModel, 42);
    const s = await getAiSettings(asClient(db));
    expect(s.allowedModels).toBeNull();
    expect(s.defaultModel).toBeNull();
  });
});

describe("★ C — التحقق من المدخلات", () => {
  it("★ المخطط يرفض apiKey وbaseUrl صراحةً (strict)", () => {
    expect(aiSettingsPatchSchema.safeParse({ defaultModel: "ysd/free", apiKey: "x" }).success).toBe(false);
    expect(aiSettingsPatchSchema.safeParse({ defaultModel: "ysd/free", baseUrl: "http://x/v1" }).success).toBe(false);
    expect(aiSettingsPatchSchema.safeParse({ defaultProvider: "openrouter", token: "t" }).success).toBe(false);
  });

  it("★ جسم فارغ مرفوض", () => {
    expect(aiSettingsPatchSchema.safeParse({}).success).toBe(false);
  });

  it("★ جسم سليم مقبول", () => {
    expect(aiSettingsPatchSchema.safeParse({ defaultProvider: "nine_router" }).success).toBe(true);
    expect(aiSettingsPatchSchema.safeParse({ allowedModels: ["ysd/free"] }).success).toBe(true);
  });

  it("★ مزوّد مجهول ليس في القائمة الإدارية", () => {
    const ids = listAdminProviders().map((p) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("nine_router");
    expect(ids).not.toContain("evil_provider");
  });

  it("★ نموذج اعتباطي غير مسموح مهما كانت القائمة", () => {
    expect(isModelAllowed("evil/model", null)).toBe(false);
    expect(isModelAllowed("evil/model", ["evil/model"])).toBe(false); // ليس في السجل
  });

  it("★ نموذج خارج allowlist مرفوض ولو كان في السجل", () => {
    expect(isModelAllowed("ysd/free", ["oc/north-mini-code-free"])).toBe(false);
    expect(isModelAllowed("ysd/free", ["ysd/free"])).toBe(true);
  });

  it("★ allowedModels=null تعني بلا تقييد لا منع الكل", () => {
    expect(isModelAllowed("ysd/free", null)).toBe(true);
    expect(listAllowedModelOptions(null).length).toBe(listModelOptions().length);
    expect(listAllowedModelOptions([]).length).toBe(0);
  });

  it("★ جسم الإجراء لا يقبل إلا provider", () => {
    expect(aiProviderActionSchema.safeParse({ provider: "nine_router" }).success).toBe(true);
    expect(aiProviderActionSchema.safeParse({ provider: "nine_router", baseUrl: "x" }).success).toBe(false);
  });
});

describe("★ D — اختبار الاتصال (healthCheck)", () => {
  it("★ connected مع عدد النماذج", async () => {
    modelsMode = "ok";
    const h = await new NineRouterProvider().healthCheck();
    expect(h.status).toBe("connected");
    expect(h.modelCount).toBe(2);
  });

  it("★ no_models عند قائمة فارغة", async () => {
    modelsMode = "empty";
    expect((await new NineRouterProvider().healthCheck()).status).toBe("no_models");
  });

  it("★ unauthorized بلا تسريب النصّ الداخلي", async () => {
    modelsMode = "401";
    const h = await new NineRouterProvider().healthCheck();
    expect(h.status).toBe("unauthorized");
    expect(JSON.stringify(h)).not.toContain("سرّ داخلي");
  });

  it("★ unreachable لعنوان ميت", async () => {
    process.env.NINE_ROUTER_BASE_URL = "http://127.0.0.1:1/v1";
    expect((await new NineRouterProvider().healthCheck()).status).toBe("unreachable");
  });

  it("★ not_configured حين تُغلق البوابة", async () => {
    delete process.env.NINE_ROUTER_ENABLED;
    expect((await new NineRouterProvider().healthCheck()).status).toBe("not_configured");
  });

  /**
   * مزوّد بلا فاحص لا يُعلَن «متصل». غياب الفاحص ليس نجاحًا — والمشرف الذي
   * يقرأ «متصل» يطمئن إلى فحص لم يقع أصلًا.
   */
  it("★ مزوّد بلا healthCheck ⇒ unsupported لا connected", () => {
    const withoutCheck = { id: "x", displayName: "X", healthCheck: undefined };
    const status = withoutCheck.healthCheck ? "connected" : "unsupported";
    expect(status).toBe("unsupported");
    expect(status).not.toBe("connected");
  });

  it("★ OpenRouter لا يوفّر فاحصًا بعدُ", () => {
    const or = getConfiguredProviders().find((p) => p.id === "openrouter");
    expect(or).toBeDefined();
    expect(typeof or?.healthCheck).toBe("undefined");
  });

  it("★ الحالة لا تحمل عنوانًا ولا مفتاحًا", async () => {
    const blob = JSON.stringify(await new NineRouterProvider().healthCheck());
    for (const bad of ["127.0.0.1", "http", "Bearer", "test-key"]) {
      expect(blob).not.toContain(bad);
    }
  });
});

describe("★ E — تحديث النماذج وحارس التزامن", () => {
  it("★ الاكتشاف الناجح يملأ الكاش", async () => {
    modelsMode = "ok";
    const models = await new NineRouterProvider().discoverModels();
    expect(models.length).toBe(2);
  });

  it("★ الفشل يُبقي آخر لقطة ويضع stale", async () => {
    const db = memoryDb();
    const previous = {
      models: [{ id: "oc/north-mini-code-free", name: "n", providerId: "nine_router" }],
      updatedAt: "2026-07-30T00:00:00.000Z",
      count: 1,
    };
    db.rows.set(AI_SETTING_KEYS.modelsCache, { nine_router: previous });
    // اكتشاف فاشل ⇒ المسار يعيد السابقة بعَلَم stale ولا يمسحها
    modelsMode = "empty";
    const discovered = await new NineRouterProvider().discoverModels(undefined, true);
    const stale = discovered.length === 0;
    const s = await getAiSettings(asClient(db));
    expect(stale).toBe(true);
    expect(s.modelsCache.nine_router?.count).toBe(1);
    expect(s.modelsCache.nine_router?.models[0]?.id).toBe("oc/north-mini-code-free");
  });

  it("★ زرّ التحديث يتخطّى الكاش (force) فلا يعيد نتيجة قديمة", async () => {
    modelsMode = "ok";
    const p = new NineRouterProvider();
    expect((await p.discoverModels()).length).toBe(2);
    modelsMode = "empty";
    // بلا force يعيد الكاش؛ ومع force يعيد الجلب فعلًا
    expect((await p.discoverModels()).length).toBe(2);
    expect((await p.discoverModels(undefined, true)).length).toBe(0);
  });

  it("★ النقر المكرر لا يطلق طلبين متوازيين", () => {
    const first = consumeProviderAction("admin-1", "refresh", "nine_router");
    expect(first.allowed).toBe(true);
    expect(isProviderActionInFlight("refresh", "nine_router")).toBe(true);
    const second = consumeProviderAction("admin-1", "refresh", "nine_router");
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("in_flight");
    releaseProviderAction("refresh", "nine_router");
    expect(consumeProviderAction("admin-1", "refresh", "nine_router").allowed).toBe(true);
  });

  it("★ حدّ المعدّل يوقف الإفراط", () => {
    for (let i = 0; i < 6; i++) {
      expect(consumeProviderAction("admin-2", "test", "nine_router").allowed).toBe(true);
      releaseProviderAction("test", "nine_router");
    }
    const over = consumeProviderAction("admin-2", "test", "nine_router");
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe("rate_limited");
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it("★ الإفراج يقع دائمًا فلا يبقى المورد مقفولًا", () => {
    consumeProviderAction("admin-3", "test", "openrouter");
    releaseProviderAction("test", "openrouter");
    expect(isProviderActionInFlight("test", "openrouter")).toBe(false);
  });

  it("★ اللقطة المحفوظة آمنة — بلا عنوان أو مفتاح", async () => {
    const db = memoryDb();
    const models = (await new NineRouterProvider().discoverModels(undefined, true)).map((m) => ({
      id: m.id, name: m.displayNameAr, providerId: "nine_router",
    }));
    db.rows.set(AI_SETTING_KEYS.modelsCache, {
      nine_router: { models, updatedAt: new Date().toISOString(), count: models.length },
    });
    const blob = JSON.stringify((await getAiSettings(asClient(db))).modelsCache);
    for (const bad of ["127.0.0.1", "Bearer", "apiKey", "baseUrl", "test-key"]) {
      expect(blob).not.toContain(bad);
    }
  });
});

describe("★ F — الافتراضي والمحادثات", () => {
  it("★ محادثة جديدة تأخذ الافتراضي الإداري", () => {
    const s = {
      defaultProvider: "nine_router", defaultModel: "oc/north-mini-code-free",
      allowedModels: null, modelsCache: {},
    };
    expect(resolveDefaultModel(s)).toBe("oc/north-mini-code-free");
  });

  it("★ افتراضي خارج allowlist يسقط إلى بديل صالح لا إلى فشل", () => {
    const s = {
      defaultProvider: "nine_router", defaultModel: "oc/north-mini-code-free",
      allowedModels: ["ysd/free"], modelsCache: {},
    };
    expect(resolveDefaultModel(s)).toBe("ysd/free");
  });

  it("★ افتراضي يشير إلى نموذج مفقود لا يمنع الإنشاء", () => {
    const s = {
      defaultProvider: null, defaultModel: "ghost/model",
      allowedModels: null, modelsCache: {},
    };
    const resolved = resolveDefaultModel(s);
    expect(resolved).not.toBeNull();
    expect(isModelAllowed(resolved!, null)).toBe(true);
  });

  it("★ بلا افتراضي ⇒ أول نموذج مسموح", () => {
    const s = { defaultProvider: null, defaultModel: null, allowedModels: null, modelsCache: {} };
    expect(resolveDefaultModel(s)).toBe(listModelOptions()[0]?.id);
  });

  it("★ محادثة قائمة لا تتغيّر بتغيّر الافتراضي", () => {
    // العقد: model_id المحفوظ هو المصدر، والافتراضي لا يُطبَّق إلا عند الإنشاء
    const existing = { model_id: "ysd/free" };
    const s = {
      defaultProvider: "nine_router", defaultModel: "oc/north-mini-code-free",
      allowedModels: null, modelsCache: {},
    };
    const effective = existing.model_id ?? resolveDefaultModel(s);
    expect(effective).toBe("ysd/free");
  });

  it("★ نموذج محادثة خرج من allowlist يصير غير متاح ولا يُمسح", () => {
    const existing = { model_id: "ysd/free" };
    const allowed = ["oc/north-mini-code-free"];
    expect(isModelAllowed(existing.model_id, allowed)).toBe(false);
    // القيمة المحفوظة تبقى كما هي — المسح الصامت يفقد اختيار المستخدم
    expect(existing.model_id).toBe("ysd/free");
  });

  it("★ المستخدم لا يرى إلا المسموح", () => {
    const visible = listAllowedModelOptions(["oc/north-mini-code-free"]);
    expect(visible.map((o) => o.id)).toEqual(["oc/north-mini-code-free"]);
    expect(visible.some((o) => o.id === "ysd/free")).toBe(false);
  });
});
