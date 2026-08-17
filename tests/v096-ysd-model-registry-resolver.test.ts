/**
 * حلّال نشرات YSD — **يفشل مغلقًا** (v0.9.3، الرقعة الثالثة).
 *
 * ── ما يُقاس هنا ──
 *
 * الحلّال حدُّ ثقةٍ مستقلّ عن القاعدة: قد يعمل على مخطط لم يُرحَّل، أو على
 * صفٍّ كُتب بصلاحية عالية تجاوزت الطبقات. فكل ما تفرضه 0036 يُفحص هنا
 * ثانيةً — والاختبار يُثبت أن الفحص يقع فعلًا لا أنه مكتوب.
 *
 * وأخطر ما يمنعه: **نشرة نشطة تشير إلى نسخة مرشّحة**. لا قيد في القاعدة
 * اليوم يربط حالة النشرة بحالة النسخة، فهذه البوابة هي المانع الوحيد.
 *
 * ── والعميل مُحاكى بالكامل ──
 *
 * لا شبكة ولا قاعدة ولا سرّ. والمحاكاة تسجّل كل جدول وعمود ومُرشِّح وحدّ،
 * فتُختبر **سلوك الاستعلام** لا نصّ المصدر.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  resolveServableDeployment,
  type ServableDeploymentResolution,
} from "@/lib/ai/model-registry-resolver";
import type { SupabaseClient } from "@supabase/supabase-js";

const SRC = readFileSync("lib/ai/model-registry-resolver.ts", "utf8");
const MODEL = "ysd/model-alpha";
const ENV = "production" as const;

/* ───────── عميل مُحاكى: يسجّل كل ما جرى ───────── */

interface Call {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  limit: number | null;
}

type Result = { data: unknown; error: unknown };

function fakeClient(results: Result[]) {
  const calls: Call[] = [];
  let i = 0;

  const from = (table: string) => {
    const call: Call = { table, columns: "", filters: {}, limit: null };
    calls.push(call);

    const chain = {
      select(columns: string) {
        call.columns = columns;
        return chain;
      },
      eq(k: string, v: unknown) {
        call.filters[k] = v;
        return chain;
      },
      limit(n: number) {
        call.limit = n;
        // النتيجة تُسلَّم عند الحدّ — كما تفعل واجهة supabase-js
        return Promise.resolve(results[i++] ?? { data: [], error: null });
      },
    };
    return chain;
  };

  return { client: { from } as unknown as SupabaseClient, calls };
}

/* ───────── صفوف خام كما تعيدها القاعدة ───────── */

const deploymentRow = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  model_id: MODEL,
  model_version_id: "v-1",
  environment: ENV,
  status: "active",
  endpoint_alias: "ysd-inference-primary",
  runtime_model: "rt-a",
  created_at: "2026-01-03T00:00:00Z",
  activated_at: "2026-01-03T00:00:00Z",
  retired_at: null,
  ...over,
});

const versionRow = (over: Record<string, unknown> = {}) => ({
  id: "v-1",
  model_id: MODEL,
  version: "1.0.0",
  status: "approved",
  base_model_ref: "base-a",
  artifact_ref: "artifact-1",
  created_at: "2026-01-01T00:00:00Z",
  approved_at: "2026-01-02T00:00:00Z",
  retired_at: null,
  ...over,
});

/** يجهّز نتيجتين: النشرة ثم النسخة */
const run = (
  dep: Result,
  ver: Result = { data: [versionRow()], error: null },
  modelId = MODEL,
  env: "development" | "staging" | "production" = ENV,
) => {
  const { client, calls } = fakeClient([dep, ver]);
  return resolveServableDeployment(client, modelId, env).then((res) => ({ res, calls }));
};

const okRows = (rows: unknown[]): Result => ({ data: rows, error: null });
const dbError = (): Result => ({
  data: null,
  error: { message: "relation \"x\" does not exist", code: "42P01", details: "secret-ish" },
});

const reason = (r: ServableDeploymentResolution) => (r.ok ? "OK" : r.reason);

/* ═══════════ (١–٢) حدّ المدخل ═══════════ */

describe("★ (١–٢) المدخل يُفحص قبل أي رحلة", () => {
  it("★ (١) معرّف فارغ ⇒ invalid_input بلا نداء قاعدة", async () => {
    for (const bad of ["", "   ", "\t\n"]) {
      const { client, calls } = fakeClient([]);
      const res = await resolveServableDeployment(client, bad, ENV);
      expect(reason(res), JSON.stringify(bad)).toBe("invalid_input");
      expect(calls, "لا رحلة").toHaveLength(0);
    }
  });

  it("★ (٢) معرّف أطول من الحدّ ⇒ invalid_input بلا نداء", async () => {
    const { client, calls } = fakeClient([]);
    const res = await resolveServableDeployment(client, "y".repeat(129), ENV);
    expect(reason(res)).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("★ وعند الحدّ تمامًا (١٢٨) يمضي إلى القاعدة", async () => {
    const { client, calls } = fakeClient([okRows([])]);
    await resolveServableDeployment(client, "y".repeat(128), ENV);
    expect(calls).toHaveLength(1);
  });

  it("★ بيئة خارج المجموعة ⇒ invalid_input بلا نداء", async () => {
    const { client, calls } = fakeClient([]);
    const res = await resolveServableDeployment(client, MODEL, "canary" as never);
    expect(reason(res)).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("★ ومعرّف غير نصّيّ ⇒ invalid_input", async () => {
    const { client, calls } = fakeClient([]);
    const res = await resolveServableDeployment(client, 42 as never, ENV);
    expect(reason(res)).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

/* ═══════════ (٣–٩) مسارات الفشل ═══════════ */

describe("★ (٣–٩) الفشل المغلق", () => {
  it("★ (٣) لا نشرة نشطة ⇒ no_active_deployment، ولا استعلام نسخة", async () => {
    const { res, calls } = await run(okRows([]));
    expect(reason(res)).toBe("no_active_deployment");
    expect(calls).toHaveLength(1); // ★ توقّف المسار
  });

  it("★ (٤) صفّان نشطان ⇒ ambiguous_active_deployment", async () => {
    const { res, calls } = await run(okRows([deploymentRow(), deploymentRow({ id: "d-2" })]));
    expect(reason(res)).toBe("ambiguous_active_deployment");
    expect(calls).toHaveLength(1);
  });

  it("★ (٥) خطأ استعلام النشرة ⇒ registry_error بلا تسريب", async () => {
    const { res, calls } = await run(dbError());
    expect(reason(res)).toBe("registry_error");
    expect(calls).toHaveLength(1);

    // ★ لا شيء من الخطأ الخام يعبر إلى النتيجة
    const serialized = JSON.stringify(res);
    for (const leak of ["relation", "42P01", "secret-ish", "does not exist"]) {
      expect(serialized, leak).not.toContain(leak);
    }
    expect(serialized).toBe('{"ok":false,"reason":"registry_error"}');
  });

  it("★ (٦) صفّ نشرة مشوّه ⇒ invalid_record", async () => {
    const broken = [
      deploymentRow({ id: null }),
      deploymentRow({ model_version_id: 7 }),
      deploymentRow({ environment: "canary" }),
      deploymentRow({ status: "unknown" }),
      deploymentRow({ endpoint_alias: "" }),
      deploymentRow({ runtime_model: undefined }),
      deploymentRow({ activated_at: 12345 }),
      "not-an-object",
      null,
    ];
    for (const row of broken) {
      const { res } = await run(okRows([row]));
      expect(reason(res), JSON.stringify(row).slice(0, 60)).toBe("invalid_record");
    }
  });

  it("★ (٧) نسخة غير موجودة ⇒ version_not_found", async () => {
    const { res, calls } = await run(okRows([deploymentRow()]), okRows([]));
    expect(reason(res)).toBe("version_not_found");
    expect(calls).toHaveLength(2);
  });

  it("★ (٨) خطأ استعلام النسخة ⇒ registry_error بلا تسريب", async () => {
    const { res } = await run(okRows([deploymentRow()]), dbError());
    expect(reason(res)).toBe("registry_error");
    expect(JSON.stringify(res)).toBe('{"ok":false,"reason":"registry_error"}');
  });

  it("★ (٩) صفّ نسخة مشوّه ⇒ invalid_record", async () => {
    const broken = [
      versionRow({ status: "published" }),
      versionRow({ version: "" }),
      versionRow({ model_id: null }),
      versionRow({ artifact_ref: 5 }),
      versionRow({ approved_at: {} }),
    ];
    for (const row of broken) {
      const { res } = await run(okRows([deploymentRow()]), okRows([row]));
      expect(reason(res), JSON.stringify(row).slice(0, 60)).toBe("invalid_record");
    }
  });

  it("★ ونسختان بنفس المعرّف ⇒ invalid_record — لا اختيار عشوائيّ", async () => {
    const { res } = await run(
      okRows([deploymentRow()]),
      okRows([versionRow(), versionRow({ version: "1.0.1" })]),
    );
    expect(reason(res)).toBe("invalid_record");
  });
});

/* ═══════════ (١٠–١٢) التطابق الصارم ═══════════ */

describe("★ (١٠–١٢) ما وصل هو ما طُلب", () => {
  it("★ (١٠) نشرة لنموذج آخر ⇒ فشل مغلق", async () => {
    const { res } = await run(okRows([deploymentRow({ model_id: "ysd/other" })]));
    expect(res.ok).toBe(false);
    expect(reason(res)).toBe("not_servable");
  });

  it("★ (١١) نسخة لنموذج آخر ⇒ فشل مغلق", async () => {
    const { res } = await run(
      okRows([deploymentRow()]),
      okRows([versionRow({ model_id: "ysd/other" })]),
    );
    expect(res.ok).toBe(false);
    expect(reason(res)).toBe("not_servable");
  });

  it("★ (١٢) بيئة مختلفة في الصفّ ⇒ فشل مغلق", async () => {
    const { res } = await run(okRows([deploymentRow({ environment: "staging" })]));
    expect(res.ok).toBe(false);
    expect(reason(res)).toBe("not_servable");
  });
});

/* ═══════════ (١٣–١٩) بوابة الخدمة ═══════════ */

describe("★ (١٣–١٩) لا نجاح يتجاوز isServableDeployment", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["(١٣) نسخة مرشّحة", {}, { status: "candidate", approved_at: null }],
    ["(١٣′) نسخة مسوّدة", {}, { status: "draft", approved_at: null }],
    ["(١٤) artifactRef غائب", {}, { artifact_ref: null }],
    ["(١٤′) artifactRef فراغ", {}, { artifact_ref: "   " }],
    ["(١٥) معتمدة بلا approvedAt", {}, { approved_at: null }],
    ["(١٥′) approvedAt فراغ", {}, { approved_at: "  " }],
    ["(١٦) نشطة بلا activatedAt", { activated_at: null }, {}],
    ["(١٦′) activatedAt فراغ", { activated_at: " " }, {}],
  ];

  for (const [label, dOver, vOver] of cases) {
    it(`★ ${label} ⇒ not_servable`, async () => {
      const { res } = await run(okRows([deploymentRow(dOver)]), okRows([versionRow(vOver)]));
      expect(reason(res)).toBe("not_servable");
    });
  }

  it("★ (١٧)(١٨) runtimeModel/endpointAlias فارغان ⇒ فشل مغلق في **الطبقتين**", async () => {
    /**
     * ★ انحرافٌ مقصود عن التوقّع الحرفيّ، وهو أشدّ لا أضعف.
     *
     * عمودٌ مطلوب فارغ ليس «نشرةً غير صالحة للخدمة» بل **صفًّا مكسورًا**:
     * القاعدة تمنعه بـ`not null` وبـ`length(btrim(...)) > 0`، فوجوده يعني
     * بياناتٍ فاسدة لا حالةً تشغيلية. فيرفضه المحلّل أبكر وبرمزٍ أدقّ.
     *
     * والغرض من (١٧)(١٨) محفوظ كاملًا: الرفض واقع، وواقعٌ في الطبقتين —
     * المحلّل هنا، والبوابة نفسها في الأسفل. فلو رُخّي المحلّل يومًا بقيت
     * البوابة تمسكهما.
     */
    for (const over of [{ runtime_model: " " }, { endpoint_alias: "  " }, { runtime_model: "" }]) {
      const { res } = await run(okRows([deploymentRow(over)]), okRows([versionRow()]));
      expect(res.ok, JSON.stringify(over)).toBe(false);
      expect(reason(res), JSON.stringify(over)).toBe("invalid_record");
    }
  });

  it("★ والبوابة نفسها ترفضهما — الطبقة الثانية مستقلّة", async () => {
    const { isServableDeployment } = await import("@/lib/ai/model-registry");
    const d = {
      id: "d", modelId: MODEL, modelVersionId: "v", environment: ENV,
      status: "active" as const, endpointAlias: "a", runtimeModel: "r",
      createdAt: "t", activatedAt: "t", retiredAt: null,
    };
    const v = {
      id: "v", modelId: MODEL, version: "1", status: "approved" as const,
      baseModelRef: null, artifactRef: "art", createdAt: "t", approvedAt: "t", retiredAt: null,
    };
    expect(isServableDeployment({ ...d, runtimeModel: "  " }, v)).toBe(false);
    expect(isServableDeployment({ ...d, endpointAlias: "" }, v)).toBe(false);
  });

  it("★ (١٩) modelVersionId لا يطابق معرّف النسخة ⇒ not_servable", async () => {
    /**
     * الاستعلام يفلتر بـ`id` — لكن الحلّال لا يفترض أن القاعدة أطاعت.
     * فلو أعادت صفًّا آخر (مخطط مختلف، عميل محاكًى، عرضٌ بدل جدول) تُرفض.
     */
    const { res } = await run(okRows([deploymentRow()]), okRows([versionRow({ id: "v-9" })]));
    expect(reason(res)).toBe("not_servable");
  });

  it("★ ونشرة غير نشطة لا تصل أصلًا — الفلتر يمنعها، والبوابة تحرسها", async () => {
    const { res } = await run(okRows([deploymentRow({ status: "inactive" })]));
    expect(res.ok).toBe(false);
  });
});

/* ═══════════ (٢٠–٢١) النجاح ═══════════ */

describe("★ (٢٠–٢١) الحالة الصحيحة", () => {
  it("★ (٢٠) نشطة + معتمدة كاملة ⇒ ok:true", async () => {
    const { res } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    expect(res.ok).toBe(true);
  });

  it("★ (٢١) وتُعاد النشرة والنسخة بعينهما بلا تحوير للنموذج", async () => {
    const { res } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    if (!res.ok) throw new Error("توقّعنا النجاح");

    expect(res.deployment.id).toBe("d-1");
    expect(res.deployment.modelId).toBe(MODEL);
    expect(res.deployment.modelVersionId).toBe("v-1");
    expect(res.deployment.environment).toBe(ENV);
    expect(res.deployment.runtimeModel).toBe("rt-a");
    expect(res.deployment.endpointAlias).toBe("ysd-inference-primary");

    expect(res.version.id).toBe("v-1");
    expect(res.version.modelId).toBe(MODEL);
    expect(res.version.version).toBe("1.0.0");
    expect(res.version.artifactRef).toBe("artifact-1");

    // ★ النموذج المنطقيّ كما طُلب — لا تطبيع ولا مستعار
    expect(res.deployment.modelId).toBe(res.version.modelId);
  });

  it("★ والمعرّف يُشذَّب ولا يُحوَّل", async () => {
    const { client, calls } = fakeClient([okRows([deploymentRow()]), okRows([versionRow()])]);
    const res = await resolveServableDeployment(client, `  ${MODEL}  `, ENV);
    expect(res.ok).toBe(true);
    expect(calls[0]!.filters["model_id"]).toBe(MODEL);
  });
});

/* ═══════════ (K) سلوك الاستعلام ═══════════ */

describe("★ (K) سلوك الاستعلام — لا نصّ مصدر", () => {
  it("★ أول استعلام على ai_model_deployments بمرشّحاته الثلاثة وlimit(2)", async () => {
    const { calls } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    const first = calls[0]!;
    expect(first.table).toBe("ai_model_deployments");
    expect(first.filters).toEqual({
      model_id: MODEL,
      environment: ENV,
      status: "active",
    });
    expect(first.limit).toBe(2);
  });

  it("★ وأعمدته صريحة تشمل كل ما يقرؤه المحلّل", async () => {
    const { calls } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    const cols = calls[0]!.columns;
    expect(cols).not.toContain("*");
    for (const c of [
      "id", "model_id", "model_version_id", "environment", "status",
      "endpoint_alias", "runtime_model", "created_at", "activated_at", "retired_at",
    ]) {
      expect(cols, c).toContain(c);
    }
  });

  it("★ واستعلام النسخة بالمعرّفين معًا", async () => {
    const { calls } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    const second = calls[1]!;
    expect(second.table).toBe("ai_model_versions");
    // ★ `id` وحده لا يكفي حتى مع المرجع المركّب
    expect(second.filters).toEqual({ id: "v-1", model_id: MODEL });
    expect(second.columns).not.toContain("*");
  });

  it("★ ولا يبدأ استعلام النسخة إن لم تنجح النشرة", async () => {
    for (const dep of [okRows([]), dbError(), okRows([deploymentRow(), deploymentRow()]), okRows([null])]) {
      const { calls } = await run(dep);
      expect(calls, JSON.stringify(dep).slice(0, 40)).toHaveLength(1);
    }
  });

  it("★ ولا استعلام ثالث بحال", async () => {
    const { calls } = await run(okRows([deploymentRow()]), okRows([versionRow()]));
    expect(calls).toHaveLength(2);
  });
});

/* ═══════════ (٢٢–٢٦) حدود الملفّ ═══════════ */

describe("★ (٢٢–٢٦) ما لا يحويه الحلّال", () => {
  it("★ (٢٢) لا select(\"*\")", () => {
    expect(SRC).not.toContain('select("*")');
    expect(SRC).not.toContain("select('*')");
  });

  it("★ (٢٣) خادميّ فقط", () => {
    expect(SRC.startsWith('import "server-only";')).toBe(true);
  });

  it("★ (٢٤) ولا يقرأ بيئة", () => {
    expect(SRC).not.toContain("process.env");
  });

  it("★ (٢٥) ولا يستورد العميل الإداريّ ولا ينشئ عميلًا", () => {
    expect(SRC).not.toContain("getAdminClient");
    expect(SRC).not.toContain("createClient");
    expect(SRC).not.toContain("SERVICE_ROLE");
  });

  it("★ (٢٦) ولا نداء شبكيًّا", () => {
    for (const bad of ["fetch(", "http://", "https://", "XMLHttpRequest"]) {
      expect(SRC, bad).not.toContain(bad);
    }
  });

  it("★ ولا تحويل نوع أعمى على صفوف القاعدة", () => {
    expect(SRC).not.toMatch(/as ModelDeploymentRecord/);
    expect(SRC).not.toMatch(/as ModelVersionRecord/);
  });

  it("★ ولا مسار نجاح يتجاوز البوابة", () => {
    const okReturns = SRC.match(/return \{ ok: true/g) ?? [];
    expect(okReturns).toHaveLength(1);
    const at = SRC.indexOf("return { ok: true");
    const before = SRC.slice(0, at);
    expect(before).toContain("if (!isServableDeployment(deployment, version)) return fail(\"not_servable\");");
  });
});

/* ═══════════ تشديد بوابة الخدمة ═══════════ */

describe("★ تشديد isServableDeployment", () => {
  it("★ الطابعان مفروضان في الدالة نفسها لا في الحلّال وحده", async () => {
    const { isServableDeployment } = await import("@/lib/ai/model-registry");
    const base = {
      id: "d",
      modelId: MODEL,
      modelVersionId: "v",
      environment: ENV,
      status: "active" as const,
      endpointAlias: "a",
      runtimeModel: "r",
      createdAt: "t",
      activatedAt: "t",
      retiredAt: null,
    };
    const ver = {
      id: "v",
      modelId: MODEL,
      version: "1",
      status: "approved" as const,
      baseModelRef: null,
      artifactRef: "art",
      createdAt: "t",
      approvedAt: "t",
      retiredAt: null,
    };
    expect(isServableDeployment(base, ver)).toBe(true);
    expect(isServableDeployment({ ...base, activatedAt: null }, ver)).toBe(false);
    expect(isServableDeployment(base, { ...ver, approvedAt: null })).toBe(false);
    expect(isServableDeployment({ ...base, activatedAt: "  " }, ver)).toBe(false);
    expect(isServableDeployment(base, { ...ver, approvedAt: "" })).toBe(false);
  });
});

/* ═══════════ لا تكامل بعد ═══════════ */

describe("★ الرقعة لا تمسّ المسار ولا المزوّدين", () => {
  it("★ مستدعٍ واحد معلوم: مزوّد YSD — لا المسار ولا السجلّ", () => {
    /**
     * ★ حُدِّث في الرقعة الخامسة. الحدّ لم يُرفَع بل صار أدقّ: مستدعٍ واحد
     * معلوم بدل «لا مستدعي». فلا يتسرّب الوصول إلى القاعدة إلى طبقاتٍ
     * لا تخصّها.
     */
    const provider = readFileSync("lib/ai/ysd.ts", "utf8");
    expect(provider).toContain("model-registry-resolver");
    expect(provider).toContain("resolveServableDeployment");

    for (const f of [
      "app/api/chat/route.ts",
      "lib/ai/registry.ts",
      "lib/ai/model-policy.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toContain("model-registry-resolver");
      expect(src, f).not.toContain("resolveServableDeployment");
    }
  });

  it("★ والعميل الإداريّ لم يُمسّ", () => {
    const admin = readFileSync("lib/supabase/admin.ts", "utf8");
    expect(admin).not.toContain("model-registry");
  });

  it("★ وysd/free ما يزال لـOpenRouter", async () => {
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });
});
