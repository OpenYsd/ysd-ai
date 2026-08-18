/**
 * تدرّج أهليّة نموذج YSD في القاعدة (v0.9.3، الرقعة التاسعة).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 * أن يكون **الطريق الوحيد** إلى `ai_models['ysd/model-alpha'].enabled = true`
 * طريقًا يمرّ بالمالك، ثم بمفتاحٍ مغلق، ثم بفحصٍ يقول «متصل» — وأن يظلّ
 * الخروج منه ممكنًا في أي لحظة بلا أيٍّ من ذلك.
 *
 * والترتيب هو الأمان نفسه: كتابةٌ قبل الفحص تُفعّل ما لم يُثبت أنه يعمل،
 * وقبولُ المفتاح مفتوحًا يجعل هذه العملية **نشرًا عامًّا فوريًّا** بدل أن
 * تكون تجهيزًا له.
 *
 * ولا قاعدة ولا شبكة هنا: كل شيء بالحقن.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { stageYSDDatabaseEligibility } from "@/lib/ai/ysd-rollout";
import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "@/lib/ai/ysd";
import type { AIProviderAdapter, ProviderHealth } from "@/lib/ai/types";

const ROLLOUT_SRC = readFileSync("lib/ai/ysd-rollout.ts", "utf8");
const ADMIN_ROUTE = readFileSync("app/api/admin/models/route.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/0038_guard_ysd_model_eligibility.sql",
  "utf8",
);

const RUNTIME_MODEL = "ysd-alpha-2026-01";
const BASE_URL = "https://runtime.internal.example/v1";
const KEY = "sk-ysd-runtime-secret";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";

/* ═════════════ مصنع الاعتمادات ═════════════ */

const CONNECTED: ProviderHealth = { status: "connected", modelCount: 5, latencyMs: 11 };

/** صفّ النموذج كما تقرؤه الدالة — بأعمدة صريحة */
const modelRow = (over: Record<string, unknown> = {}) => ({
  id: YSD_ALPHA_MODEL_ID,
  provider_id: YSD_PROVIDER_ID,
  enabled: false,
  ...over,
});

/**
 * عميل إدارةٍ في الذاكرة يحاكي سلسلة `postgrest` المستعملة فعلًا.
 *
 * يسجّل كل قراءةٍ وكتابة كي يُقاس **ما لم يقع** أيضًا: أن لا `insert` ولا
 * `upsert` جرى، وأن الشرط شمل `provider_id` لا المعرّف وحده.
 */
function memoryAdmin(
  rows: Array<Record<string, unknown>> | null,
  opts: { selectError?: boolean; updateError?: boolean; updatedRows?: number } = {},
) {
  const calls = {
    selects: [] as string[],
    updates: [] as Array<Record<string, unknown>>,
    filters: [] as Array<[string, unknown]>,
    inserts: 0,
    upserts: 0,
  };

  const client = {
    from(table: string) {
      if (table !== "ai_models") throw new Error(`جدول غير متوقَّع: ${table}`);
      return {
        select(cols: string) {
          calls.selects.push(cols);
          const chain = {
            eq(col: string, val: unknown) {
              calls.filters.push([col, val]);
              return chain;
            },
            limit() {
              return Promise.resolve(
                opts.selectError
                  ? { data: null, error: { code: "42P01" } }
                  : { data: rows, error: null },
              );
            },
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          calls.updates.push(patch);
          const chain = {
            eq(col: string, val: unknown) {
              calls.filters.push([col, val]);
              return chain;
            },
            select() {
              const n = opts.updatedRows ?? 1;
              return Promise.resolve(
                opts.updateError
                  ? { data: null, error: { code: "23505" } }
                  : { data: Array.from({ length: n }, () => ({ id: YSD_ALPHA_MODEL_ID })), error: null },
              );
            },
          };
          return chain;
        },
        insert() {
          calls.inserts += 1;
          return Promise.resolve({ error: null });
        },
        upsert() {
          calls.upserts += 1;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, calls };
}

const ysdProvider = (health?: () => Promise<ProviderHealth>): AIProviderAdapter =>
  ({
    id: YSD_PROVIDER_ID,
    displayName: "YSD",
    healthCheck: health ?? (async () => CONNECTED),
  }) as unknown as AIProviderAdapter;

const otherProvider = (): AIProviderAdapter =>
  ({ id: "openrouter", displayName: "OpenRouter" }) as unknown as AIProviderAdapter;

function deps(over: Record<string, unknown> = {}) {
  const admin = memoryAdmin([modelRow()]);
  return {
    isKillSwitchOn: vi.fn(() => false),
    listConfiguredProviders: vi.fn(() => [otherProvider(), ysdProvider()]),
    getAdminClient: vi.fn(() => admin.client),
    ...over,
    __admin: admin,
  } as Record<string, unknown> & { __admin: ReturnType<typeof memoryAdmin> };
}

const stage = (isOwner: boolean, d: Record<string, unknown>) =>
  stageYSDDatabaseEligibility(
    isOwner,
    d as unknown as Parameters<typeof stageYSDDatabaseEligibility>[1],
  );

const reasonOf = (r: Awaited<ReturnType<typeof stageYSDDatabaseEligibility>>) =>
  r.ok ? null : r.reason;

/* ═══════════ (١–٢) قبل أي فحصٍ وأي قاعدة ═══════════ */

describe("★ (١–٢) ما يُرفض قبل أن يُلمس شيء", () => {
  it("★ (١) ★ مشرفٌ ليس مالكًا ⇒ رفض بصفر فحصٍ وصفر قاعدة", async () => {
    /**
     * تفعيل نموذج المنصّة قرارٌ يصعب التراجع عنه بلا أثر: سيصل النموذج
     * مستخدمين، وستُسجَّل محادثاتٌ منسوبةٌ إليه. وصلاحيةُ الإشراف اليومي
     * أوسع من أن تحمل هذا.
     */
    const d = deps();
    const health = vi.fn(async () => CONNECTED);
    d.listConfiguredProviders = vi.fn(() => [ysdProvider(health)]);

    const res = await stage(false, d);
    expect(reasonOf(res)).toBe("owner_required");
    expect(health).not.toHaveBeenCalled();
    expect(d.getAdminClient).not.toHaveBeenCalled();
    expect(d.__admin.calls.updates).toHaveLength(0);
  });

  it("★ (٢) ★ ومفتاح الإذن مفتوح ⇒ رفض قبل الفحص وقبل الكتابة", async () => {
    /**
     * ★ الشرط الذي يجعل هذه العملية تجهيزًا لا نشرًا.
     *
     * البوّابتان الأخريان مفتوحتان لحظتَها، فلو كُتبت القاعدة والمفتاح
     * مفتوح لَوصل النموذج المستخدمين في اللحظة نفسها — بضغطة زرٍّ واحدة
     * تُراجَع مرةً بدل مرّتين.
     */
    const health = vi.fn(async () => CONNECTED);
    const d = deps({
      isKillSwitchOn: vi.fn(() => true),
      listConfiguredProviders: vi.fn(() => [ysdProvider(health)]),
    });

    const res = await stage(true, d);
    expect(reasonOf(res)).toBe("kill_switch_must_be_off");
    expect(health).not.toHaveBeenCalled();
    expect(d.getAdminClient).not.toHaveBeenCalled();
    expect(d.__admin.calls.updates).toHaveLength(0);
  });

  it("★ والترتيب مكتوبٌ كذلك في المصدر", () => {
    const ownerAt = ROLLOUT_SRC.indexOf('return fail("owner_required")');
    const killAt = ROLLOUT_SRC.indexOf('return fail("kill_switch_must_be_off")');
    const healthAt = ROLLOUT_SRC.indexOf("provider.healthCheck()");
    const clientAt = ROLLOUT_SRC.indexOf("d.getAdminClient()");
    const updateAt = ROLLOUT_SRC.indexOf('.update({ enabled: true })');
    expect(ownerAt).toBeGreaterThan(0);
    expect(ownerAt).toBeLessThan(killAt);
    expect(killAt).toBeLessThan(healthAt);
    expect(healthAt).toBeLessThan(clientAt);
    expect(clientAt).toBeLessThan(updateAt);
  });
});

/* ═══════════ (٣–٩) المزوّد والفحص ═══════════ */

describe("★ (٣–٩) لا تفعيل بلا دليل", () => {
  it("★ (٣) المزوّد غير مهيّأ ⇒ رفض", async () => {
    const d = deps({ listConfiguredProviders: vi.fn(() => [otherProvider()]) });
    expect(reasonOf(await stage(true, d))).toBe("provider_not_configured");
    expect(d.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ (٣′) وقائمةٌ فارغة ⇒ رفض", async () => {
    const d = deps({ listConfiguredProviders: vi.fn(() => []) });
    expect(reasonOf(await stage(true, d))).toBe("provider_not_configured");
  });

  it("★ (٤) ★ ومزوّدٌ بلا فاحص ⇒ رفض — لا تفعيل على أمل", async () => {
    const bare = { id: YSD_PROVIDER_ID, displayName: "YSD" } as unknown as AIProviderAdapter;
    const d = deps({ listConfiguredProviders: vi.fn(() => [bare]) });
    expect(reasonOf(await stage(true, d))).toBe("health_not_connected");
    expect(d.getAdminClient).not.toHaveBeenCalled();
  });

  it("★ (٥–٨) ★ وكل حالةٍ سوى connected ⇒ رفض", async () => {
    /**
     * و`no_models` أخطر ما يُغرى بقبوله: تعني أن وقت التشغيل حيّ ولا يحمل
     * نموذجنا — وهي بالضبط الحالة التي وُجد الفحص لأجلها في الرقعة السابعة.
     */
    const statuses = [
      "not_configured",
      "unauthorized",
      "unreachable",
      "no_models",
      "unsupported",
    ] as const;
    for (const status of statuses) {
      const d = deps({
        listConfiguredProviders: vi.fn(() => [ysdProvider(async () => ({ status, latencyMs: 3 }))]),
      });
      expect(reasonOf(await stage(true, d)), status).toBe("health_not_connected");
      expect(d.getAdminClient, status).not.toHaveBeenCalled();
      expect(d.__admin.calls.updates, status).toHaveLength(0);
    }
  });

  it("★ (٩) والفاحص الذي يرمي ⇒ رفضٌ آمن بلا نصّ خام", async () => {
    const d = deps({
      listConfiguredProviders: vi.fn(() => [
        ysdProvider(async () => {
          throw new Error(`${BASE_URL} رفض ${RUNTIME_MODEL} بالمفتاح ${KEY}`);
        }),
      ]),
    });
    const res = await stage(true, d);
    expect(reasonOf(res)).toBe("health_not_connected");
    const dump = JSON.stringify(res);
    for (const secret of [BASE_URL, RUNTIME_MODEL, KEY]) {
      expect(dump, secret).not.toContain(secret);
    }
  });

  it("★ (١٠) ★ وعميل الإدارة لا يُطلب إلا بعد connected", async () => {
    const order: string[] = [];
    const admin = memoryAdmin([modelRow()]);
    const d = {
      isKillSwitchOn: () => false,
      listConfiguredProviders: () => [
        ysdProvider(async () => {
          order.push("health");
          return CONNECTED;
        }),
      ],
      getAdminClient: () => {
        order.push("admin");
        return admin.client;
      },
    };
    const res = await stage(true, d as unknown as Record<string, unknown>);
    expect(res.ok).toBe(true);
    expect(order).toEqual(["health", "admin"]);
  });
});

/* ═══════════ (١١–١٣) القاعدة ═══════════ */

describe("★ (١١–١٣) الكتابة على سجلٍّ نفهمه", () => {
  it("★ (١١) عميل الإدارة null ⇒ فشل مغلق", async () => {
    const d = deps({ getAdminClient: vi.fn(() => null) });
    expect(reasonOf(await stage(true, d))).toBe("admin_client_unavailable");
  });

  it("★ (١١′) وعميلٌ يرمي ⇒ فشل مغلق بلا نصّ", async () => {
    const d = deps({
      getAdminClient: vi.fn(() => {
        throw new Error(`SERVICE_ROLE=${KEY}`);
      }),
    });
    const res = await stage(true, d);
    expect(reasonOf(res)).toBe("admin_client_unavailable");
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("★ (١٢) وصفٌّ مفقود ⇒ model_not_found بلا إنشاء", async () => {
    const admin = memoryAdmin([]);
    const d = deps({ getAdminClient: vi.fn(() => admin.client) });
    expect(reasonOf(await stage(true, d))).toBe("model_not_found");
    expect(admin.calls.inserts).toBe(0);
    expect(admin.calls.upserts).toBe(0);
    expect(admin.calls.updates).toHaveLength(0);
  });

  it("★ (١٣) ★ ومزوّدٌ آخر يملك المعرّف ⇒ فشل مغلق بلا كتابة", async () => {
    /**
     * صفٌّ بهذا المعرّف يملكه مزوّدٌ آخر يعني أن السجلّ ليس ما نظنّه.
     * والكتابة على سجلٍّ لا نفهمه أسوأ من الامتناع.
     */
    const admin = memoryAdmin([modelRow({ provider_id: "openrouter" })]);
    const d = deps({ getAdminClient: vi.fn(() => admin.client) });
    expect(reasonOf(await stage(true, d))).toBe("database_error");
    expect(admin.calls.updates).toHaveLength(0);
  });

  it("★ (١٣′) وصفّان بالمعرّف نفسه ⇒ فشل مغلق", async () => {
    const admin = memoryAdmin([modelRow(), modelRow()]);
    const d = deps({ getAdminClient: vi.fn(() => admin.client) });
    expect(reasonOf(await stage(true, d))).toBe("database_error");
    expect(admin.calls.updates).toHaveLength(0);
  });

  it("★ (١٣″) وخطأ القراءة أو الكتابة ⇒ رمزٌ لا نصّ", async () => {
    const readErr = memoryAdmin([modelRow()], { selectError: true });
    expect(reasonOf(await stage(true, deps({ getAdminClient: () => readErr.client })))).toBe(
      "database_error",
    );

    const writeErr = memoryAdmin([modelRow()], { updateError: true });
    const res = await stage(true, deps({ getAdminClient: () => writeErr.client }));
    expect(reasonOf(res)).toBe("database_error");
    expect(JSON.stringify(res)).not.toContain("23505");
  });

  it("★ وصفرُ صفوفٍ متأثّرة ⇒ فشل مغلق لا نجاحٌ صامت", async () => {
    const admin = memoryAdmin([modelRow()], { updatedRows: 0 });
    expect(reasonOf(await stage(true, deps({ getAdminClient: () => admin.client })))).toBe(
      "database_error",
    );
  });
});

/* ═══════════ (١٤–١٦) النجاح ═══════════ */

describe("★ (١٤–١٦) الكتابة نفسها", () => {
  it("★ (١٥) ★ صفٌّ واحد بعينه يُحدَّث إلى true", async () => {
    const admin = memoryAdmin([modelRow()]);
    const d = deps({ getAdminClient: vi.fn(() => admin.client) });
    const res = await stage(true, d);

    expect(res).toEqual({ ok: true, alreadyEnabled: false });
    expect(admin.calls.updates).toEqual([{ enabled: true }]);
    // والشرط يشمل المزوّد لا المعرّف وحده
    expect(admin.calls.filters).toContainEqual(["id", YSD_ALPHA_MODEL_ID]);
    expect(admin.calls.filters).toContainEqual(["provider_id", YSD_PROVIDER_ID]);
    // والقراءة بأعمدة صريحة لا `*`
    expect(admin.calls.selects[0]).toBe("id, provider_id, enabled");
  });

  it("★ (١٦) ★ ولا insert ولا upsert في أي مسار", async () => {
    /**
     * هوية النموذج تملكها الترحيلة `0036` وحدها. وصفٌّ يُنشئه مسارُ تفعيل
     * صفٌّ بلا مراجعة — يحمل ما تصادف أن كتبناه هنا لا ما قرّرته الترحيلة.
     */
    for (const rows of [[modelRow()], [], [modelRow({ enabled: true })]]) {
      const admin = memoryAdmin(rows);
      await stage(true, deps({ getAdminClient: () => admin.client }));
      expect(admin.calls.inserts).toBe(0);
      expect(admin.calls.upserts).toBe(0);
    }
    const code = ROLLOUT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain(".upsert(");
    expect(code).not.toContain(".insert(");
  });

  it("★ (١٤) ★ ومُفعَّلٌ سلفًا ⇒ نجاحٌ موسوم — بعد الفحوص كلها", async () => {
    /**
     * ولا يُختصر الطريق إليه: الخروج المبكر كان سيجعل الاستدعاء الثاني
     * يقول «تمّ» بلا أن يمسّ الفحص شيئًا — فيُعلن نجاح تدرّجٍ على بنيةٍ
     * قد تكون انكسرت بعد الأول.
     */
    const health = vi.fn(async () => CONNECTED);
    const admin = memoryAdmin([modelRow({ enabled: true })]);
    const d = deps({
      listConfiguredProviders: vi.fn(() => [ysdProvider(health)]),
      getAdminClient: vi.fn(() => admin.client),
    });

    const res = await stage(true, d);
    expect(res).toEqual({ ok: true, alreadyEnabled: true });
    expect(health).toHaveBeenCalledTimes(1);
    expect(admin.calls.updates).toHaveLength(0);
  });

  it("★ ومُفعَّلٌ سلفًا بمفتاحٍ مفتوح ⇒ رفضٌ رغم ذلك", async () => {
    const admin = memoryAdmin([modelRow({ enabled: true })]);
    const d = deps({
      isKillSwitchOn: vi.fn(() => true),
      getAdminClient: vi.fn(() => admin.client),
    });
    expect(reasonOf(await stage(true, d))).toBe("kill_switch_must_be_off");
  });
});

/* ═══════════ (٣٠–٣٩) الأمن والخصوصية ═══════════ */

describe("★ (٣٠–٣٩) ما لا يخرج ولا يُلمس", () => {
  it("★ (٣٠) ★ الدالة الإدارية العامّة تحجب تفعيل YSD في القاعدة", () => {
    const code = MIGRATION.split("\n")
      .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain("if p_id = 'ysd/model-alpha' and p_enabled is true then");
    expect(code).toContain("return 'ysd_guarded'");
    // ولا استثناء للمالك: حارسٌ يُتجاوَز اتفاقٌ لا قاعدة
    expect(code).not.toContain("is_owner()");
  });

  it("★ ملفّ ترحيلةٍ واحد جديد، وهو الأحدث ترقيمًا", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0038_guard_ysd_model_eligibility.sql");
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(38);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("★ ولا تُمسّ 0036 ولا 0037", async () => {
    /**
     * الترحيلتان مطبَّقتان على الإنتاج. وتعديلُ ملفٍّ طُبِّق يجعل المستودع
     * يصف قاعدةً غير القائمة — انحرافٌ صامت لا يظهر حتى تُبنى بيئةٌ جديدة.
     */
    const { execFileSync } = await import("node:child_process");
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", "HEAD", "--", "supabase/migrations/"],
      { encoding: "utf8" },
    );
    expect(changed).not.toContain("0036_");
    expect(changed).not.toContain("0037_");
  });

  it("★ (٣٠′) ولا تفعّل الترحيلة شيئًا", () => {
    const code = MIGRATION.toLowerCase()
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/update\s+(public\.)?ai_models\s+set\s+enabled\s*=\s*true/);
    expect(code).not.toMatch(/insert\s+into\s+(public\.)?ai_models/);
  });

  it("★ (٣١) ★ ومسار التدرّج يكتب بعميل الخدمة لا بعميل المستخدم", () => {
    const code = ROLLOUT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("admin\n      .from(\"ai_models\")");
    // ولا `ctx.supabase` ولا `createClient` — أيّهما يعني كتابةً بصلاحية المستخدم
    expect(code).not.toContain("ctx.supabase");
    expect(code).not.toContain("createClient");
    expect(code).not.toContain("adminRpc");
  });

  it("★ (٣٢) ولا تُقرأ قيمة مفتاح الخدمة ولا تُطبع", () => {
    const code = ROLLOUT_SRC.split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("console.");
  });

  it("★ (٣٣) ★ ولا نصّ خام في أي نتيجة", async () => {
    const cases = [
      deps({ isKillSwitchOn: () => true }),
      deps({ listConfiguredProviders: () => [] }),
      deps({ getAdminClient: () => null }),
      deps({ getAdminClient: () => memoryAdmin([modelRow()], { selectError: true }).client }),
      deps({ getAdminClient: () => memoryAdmin([modelRow({ provider_id: "x" })]).client }),
    ];
    for (const d of cases) {
      const res = await stage(true, d);
      const dump = JSON.stringify(res);
      for (const leak of [KEY, BASE_URL, RUNTIME_MODEL, DEPLOYMENT_ID, "42P01", "23505"]) {
        expect(dump, leak).not.toContain(leak);
      }
      // والمفاتيح مغلقة: `ok` و`reason` أو `alreadyEnabled` لا غير
      for (const k of Object.keys(res)) {
        expect(["ok", "reason", "alreadyEnabled"], k).toContain(k);
      }
    }
  });

  it("★ (٣٤) ولا معرّف هدفٍ في سجلّ التدقيق", () => {
    const at = ADMIN_ROUTE.indexOf('action: "model.ysd_eligibility_enabled"');
    expect(at).toBeGreaterThan(0);
    const block = ADMIN_ROUTE.slice(at - 200, at + 900);
    expect(block).toContain("after: { enabled: true, readiness: \"connected\", publicServing: false }");
    for (const forbidden of [
      "deploymentId",
      "modelVersion",
      "runtimeModel",
      "environment",
      "endpointAlias",
      "baseUrl",
      "apiKey",
    ]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٣٥–٣٦) ★ ولا يمسّ المسارُ مفتاحَ الإذن ولا يعلنه", () => {
    for (const src of [ROLLOUT_SRC, ADMIN_ROUTE]) {
      expect(src).not.toContain("YSD_MODEL_ALPHA_ENABLED");
      expect(src).not.toContain("NEXT_PUBLIC");
    }
    // والقراءة وحدها عبر المساعد المخصّص
    expect(ROLLOUT_SRC).toContain("isYSDAlphaActivationEnabled()");
  });

  it("★ (٣٧–٣٩) وسياستا العبور وysd/free كما هما", async () => {
    const { YSDProvider } = await import("@/lib/ai/ysd");
    const p = new YSDProvider();
    expect(p.fallbackPolicy).toBe("none");
    expect(p.fallbackEligible).toBe(false);

    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });
});

/* ═══════════ (١٧–٢٩) المسار الإداريّ ═══════════ */

/**
 * ★ المسار يُختبر بمصدره لا بتشغيله.
 *
 * تشغيل معالج Next هنا كان يستلزم محاكاة `next/headers` وعميل Supabase
 * وسياق الطلب — وهي محاكاةٌ تقيس نفسها أكثر مما تقيس الفرع. والفرع الذي
 * تضيفه هذه الرقعة شرطيٌّ ثلاثيّ صريح، فيُقاس كما هو: أنه موجود، وأن
 * التعطيل وغيرُ YSD لا يمرّان به.
 */
describe("★ (١٧–٢٩) توجيه الفرع في مسار الإدارة", () => {
  /** الفرع بشيفرته وحدها — الشرح يذكر الحقول نفسها ليقول لِمَ هي هناك */
  const stripComments = (src: string) =>
    src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");

  const BRANCH_HEAD = 'if (target === "model" && id === YSD_ALPHA_MODEL_ID';

  const branchStart = ADMIN_ROUTE.indexOf(BRANCH_HEAD);
  /** نهاية الفرع: أول `\n  }\n` بعد رأسه — أي إغلاقه على مستوى الدالة */
  const branchEnd = branchStart + ADMIN_ROUTE.slice(branchStart).indexOf("\n  }\n") + 5;

  const branch = stripComments(ADMIN_ROUTE.slice(branchStart, branchEnd));

  /**
   * وكل ما بعد الفرع — يُقاس من **نهايته** لا من سطر `const fn`.
   *
   * فسطرٌ يُدَسّ بينهما كان يقع خارج النطاق المقيس، فلا يراه حارسٌ يبدأ
   * من `const fn`. والحدّ الصحيح هو حيث ينتهي ما نستثنيه.
   */
  const generic = stripComments(ADMIN_ROUTE.slice(branchEnd));

  it("★ (١٧–١٨) ★ التفعيل وحده يسلك مسار التدرّج", () => {
    expect(branch.length).toBeGreaterThan(100);
    expect(branch).toContain('if (target === "model" && id === YSD_ALPHA_MODEL_ID && enabled === true)');
    expect(branch).toContain("await stageYSDDatabaseEligibility(ctx.isOwner)");
    // ولا يمرّ بالدالة العامّة
    expect(branch).not.toContain("adminRpc");
  });

  it("★ (١٨) ★ والردّ يقول صراحةً إن الخدمة لم تُفتح", () => {
    /**
     * لأن المشرف يقرأ «تمّ التفعيل» فيظنّ أن النموذج صار متاحًا للناس.
     * وهو لم يصر: مفتاح الإذن ما يزال مغلقًا، وفتحُه قرارٌ ثانٍ.
     */
    expect(branch).toContain("staged: true");
    expect(branch).toContain("publiclyEnabled: false");
    expect(branch).toContain("alreadyEnabled: staged.alreadyEnabled");
  });

  it("★ (١٩–٢٥) ★ والتعطيل يمرّ بالمسار العامّ بلا شرط", () => {
    /**
     * مفتاح إيقافٍ ثانٍ: إغلاق أهليّة القاعدة يجب أن يعمل أثناء العطل
     * الكامل — بلا مالك، ولا فحص، ولا مزوّدٍ مهيّأ، ولا مفتاحٍ مغلق.
     * وحارسٌ يمنع الإغلاق في الطوارئ حارسٌ ضدّنا.
     */
    expect(branch).toContain("enabled === true");
    // الشرط لا يلتقط التعطيل
    expect(branch).not.toContain("enabled === false");
    // والمسار العامّ ما يزال قائمًا لكل ما عداه
    expect(ADMIN_ROUTE).toContain(
      'const fn = target === "provider" ? "admin_set_provider_enabled" : "admin_set_model_enabled";',
    );
    expect(ADMIN_ROUTE).toContain("await adminRpc(ctx, fn, { p_id: id, p_enabled: enabled })");
    expect(ADMIN_ROUTE).toContain("action: `${target}.enabled`");
  });

  it("★ (٢٣–٢٤) ولا فحص ولا عميل خدمةٍ في مسار التعطيل", () => {
    for (const forbidden of ["healthCheck", "stageYSDDatabaseEligibility", "getAdminClient"]) {
      expect(generic, forbidden).not.toContain(forbidden);
    }
  });

  it("★ (٢٦–٢٩) ★ وغير YSD لا يمسّه شيء", () => {
    // الشرط ثلاثيّ: الهدف، والمعرّف بعينه، والتفعيل
    expect(branch).toContain('target === "model"');
    expect(branch).toContain("id === YSD_ALPHA_MODEL_ID");
    /**
     * ★ ولا شرط ملكية يتسرّب إلى المسار العامّ.
     *
     * `ctx.isOwner` يظهر **مرّة واحدة** في الملفّ كلّه، وهي داخل فرع YSD.
     * فمن أضاف ثانيةً — ولو قبل سطرٍ من المسار العامّ — أوقف مشرفًا عن
     * عملٍ كان يفعله بالأمس.
     */
    expect(generic).not.toContain("ctx.isOwner");
    expect((stripComments(ADMIN_ROUTE).match(/ctx\.isOwner/g) ?? []).length).toBe(1);
    expect(branch).toContain("ctx.isOwner");
    // والمخطّط لم يتغيّر
    expect(ADMIN_ROUTE).toContain('z.literal("provider")');
    expect(ADMIN_ROUTE).toContain('z.literal("model")');
  });

  it("★ والرموز المعروضة مغلقة — بلا نصٍّ من القاعدة أو الفاحص", () => {
    const table = ADMIN_ROUTE.slice(
      ADMIN_ROUTE.indexOf("const YSD_STAGE_FAILURES"),
      ADMIN_ROUTE.indexOf("const patchSchema"),
    );
    for (const reason of [
      "owner_required",
      "kill_switch_must_be_off",
      "provider_not_configured",
      "health_not_connected",
      "admin_client_unavailable",
      "database_error",
      "model_not_found",
    ]) {
      expect(table, reason).toContain(reason);
    }
    expect(table).toContain("ysd_owner_required");
    expect(table).toContain("ysd_kill_switch_must_be_off");
    expect(table).toContain("ysd_not_ready");
    expect(table).toContain("status: 403");
  });

  it("★ وكل سببٍ في الاتّحاد له تحويلٌ في الجدول", () => {
    /**
     * وإلا لَصار سببٌ جديد يُعرض `undefined` — استثناءً في وقت التشغيل
     * داخل مسارٍ إداريّ، أي رسالة خطأ عامّة بدل رمزٍ يفهمه المشرف.
     */
    const union = ROLLOUT_SRC.slice(
      ROLLOUT_SRC.indexOf("reason:"),
      ROLLOUT_SRC.indexOf("const fail ="),
    );
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(reasons.length).toBeGreaterThanOrEqual(7);
    const table = ADMIN_ROUTE.slice(
      ADMIN_ROUTE.indexOf("const YSD_STAGE_FAILURES"),
      ADMIN_ROUTE.indexOf("const patchSchema"),
    );
    for (const r of reasons) expect(table, r).toContain(`${r}:`);
  });
});
