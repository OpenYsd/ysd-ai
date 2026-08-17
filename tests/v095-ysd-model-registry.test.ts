/**
 * سجلّ نماذج YSD — العقد والمخطط (v0.9.3، الرقعة الثانية).
 *
 * ── تقسيم العمل بين هذا الملفّ وأداة PostgreSQL ──
 *
 * القيودُ والمراجعُ والفهارس تُختبر على **قاعدة حقيقية** في
 * `scripts/v095-pg-model-registry.mjs` — لأن رفضَ إدراجٍ لا يُثبته نصّ.
 * وهنا يُختبر ما لا تراه القاعدة: تطابق أنواع TypeScript مع حالات SQL،
 * ونقاء `isServableDeployment`، وحدود الترحيلة (ألّا تمسّ ما لا يخصّها).
 *
 * فلا تكرار: كلٌّ يقيس ما يقدر عليه وحده.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import {
  isServableDeployment,
  type DeploymentEnvironment,
  type DeploymentStatus,
  type ModelDeploymentRecord,
  type ModelVersionRecord,
  type ModelVersionStatus,
} from "@/lib/ai/model-registry";

const MIGRATION_FILE = "0036_ysd_model_registry.sql";
const SQL = readFileSync(`supabase/migrations/${MIGRATION_FILE}`, "utf8");
/** الشيفرة بلا تعليقات — كي لا يقرأ الحارس شرحًا فيظنّه أمرًا */
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*(--|\*|\/\*)/.test(l))
  .join("\n");

/* ═════════ (١) الترحيلة: جديدة وحدها ═════════ */

describe("★ (١) حدود الترحيلة", () => {
  it("★ ملفّ واحد جديد، وهو التالي في الترقيم", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain(MIGRATION_FILE);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(36);
    // ولا تكرار في الترقيم
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("★ (٩) ولا تلمس ysd/free بتعديل ولا حذف ولا نقل ملكية", () => {
    /**
     * الفحص على الشيفرة لا على النصّ: الشرح يذكر `ysd/free` ليُفهم ما
     * لا تفعله الترحيلة، وحارسٌ يقرأ التعليق يمنع التوثيق لا الانحدار.
     */
    expect(CODE).not.toContain("ysd/free");
    for (const verb of ["update public.ai_models", "delete from public.ai_models"]) {
      expect(CODE.toLowerCase()).not.toContain(verb);
    }
    expect(CODE.toLowerCase()).not.toContain("default_model_id");
  });

  it("★ (١٠) ولا تزرع نسخة ولا نشرة", () => {
    expect(CODE).not.toMatch(/insert\s+into\s+public\.ai_model_versions/i);
    expect(CODE).not.toMatch(/insert\s+into\s+public\.ai_model_deployments/i);
  });

  it("★ (١١) ولا سرّ ولا عنوان في البذور", () => {
    for (const bad of ["http://", "https://", "api_key", "apikey", "secret", "token", "bearer"]) {
      expect(CODE.toLowerCase(), bad).not.toContain(bad);
    }
  });

  it("★ ولا تعدّل ترحيلة قديمة", () => {
    // الترحيلة الجديدة وحدها في هذا الإيداع — يحرسه فحص الفرق قبل الإيداع،
    // وهنا نتأكد أنها لا تُسقط أو تُعيد تعريف كائنات ترحيلات سابقة
    expect(CODE.toLowerCase()).not.toContain("drop table");
    expect(CODE.toLowerCase()).not.toContain("alter table public.ai_models");
    expect(CODE.toLowerCase()).not.toContain("alter table public.ai_providers");
  });
});

/* ═════════ (٢–٥) بنية الجدولين ═════════ */

describe("★ (٢–٥) المخطط", () => {
  it("★ (٢) النسخ: مرجع، وتفرّد، وحالات", () => {
    expect(CODE).toContain("references public.ai_models(id) on delete restrict");
    expect(CODE).toContain("unique (model_id, version)");
    expect(CODE).toContain("check (status in ('draft', 'candidate', 'approved', 'retired'))");
    // والمرجع المركّب الذي تستعمله النشرة
    expect(CODE).toContain("unique (id, model_id)");
  });

  it("★ (٢′) وقيود الاعتماد والتقاعد", () => {
    expect(CODE).toMatch(/status <> 'approved'\s*\n?\s*or \(artifact_ref is not null/);
    expect(CODE).toContain("status <> 'approved' or approved_at is not null");
    expect(CODE).toContain("status <> 'retired' or retired_at is not null");
    expect(CODE).toContain("length(btrim(version)) > 0");
  });

  it("★ (٣)(٤) النشرات: المرجع المركّب يمنع الخلط بين النماذج", () => {
    expect(CODE).toContain("foreign key (model_version_id, model_id)");
    expect(CODE).toContain("references public.ai_model_versions (id, model_id)");
    // وهو ما يجعل ربط نسخة نموذجٍ آخر **مستحيلًا بنيويًّا** لا ممنوعًا اتفاقًا
  });

  it("★ (٥) ثابت النشرة النشطة الواحدة — فهرس جزئيّ", () => {
    expect(CODE).toContain("create unique index if not exists ai_model_deployments_one_active_per_env");
    expect(CODE).toContain("on public.ai_model_deployments (model_id, environment)");
    expect(CODE).toContain("where status = 'active'");
  });

  it("★ وقرار MVP موثَّق: لا توزيع حركة الآن", () => {
    // الشرح يجب أن يبقى — مخططٌ يمنع حالةً بلا أن يقول لماذا يُفكّ لاحقًا بالخطأ
    expect(SQL).toContain("canary");
  });

  it("★ ونشرة: قيود البيئة والحالة والحقول غير الفارغة", () => {
    expect(CODE).toContain("check (environment in ('development', 'staging', 'production'))");
    expect(CODE).toContain("check (status in ('inactive', 'active', 'failed', 'retired'))");
    expect(CODE).toContain("length(btrim(endpoint_alias)) > 0");
    expect(CODE).toContain("length(btrim(runtime_model)) > 0");
    expect(CODE).toContain("status <> 'active' or activated_at is not null");
  });
});

/* ═════════ (٦–٧) الأمن ═════════ */

describe("★ (٦–٧) لا وصول للعميل", () => {
  it("★ (٦) RLS مفعَّل ومفروض على الجدولين", () => {
    for (const t of ["ai_model_versions", "ai_model_deployments"]) {
      // المحاذاة في المصدر تُدخل مسافات متعدّدة — فالتعبير يتساهل معها وحدها
      expect(CODE, t).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
      expect(CODE, t).toMatch(new RegExp(`alter table public\\.${t}\\s+force\\s+row level security`));
    }
  });

  it("★ (٧) ولا سياسة واحدة — ولا صلاحية لـanon/authenticated", () => {
    expect(CODE.toLowerCase()).not.toContain("create policy");
    for (const t of ["ai_model_versions", "ai_model_deployments"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(CODE).toContain(`revoke all on table public.${t} from ${role};`);
      }
    }
    // ولا منح لأحد
    expect(CODE.toLowerCase()).not.toMatch(/grant .* on table public\.ai_model_(versions|deployments)/);
  });

  it("★ ولا RPC كتابة في هذه الرقعة", () => {
    expect(CODE.toLowerCase()).not.toContain("security definer");
  });
});

/* ═════════ (٨) البذور خاملة ═════════ */

describe("★ (٨) YSD مزروع معطَّلًا", () => {
  it("★ المزوّد والنموذج كلاهما enabled=false", () => {
    expect(CODE).toContain("values ('ysd', 'YSD', false)");
    expect(CODE).toContain(
      "('ysd/model-alpha', 'ysd', 'نموذج YSD (ألفا)', 'YSD Model (Alpha)', 'free', false)",
    );
  });

  it("★ وmin_tier مُصرَّح به لا متروك للافتراض", () => {
    /**
     * الحارس يفحص `min_tier`، وفحصُ قيمةٍ لم تُصرَّح يجعل الترحيلة تعتمد
     * على افتراض عمود قد يتغيّر في ترحيلة لاحقة.
     */
    expect(CODE).toContain(
      "(id, provider_id, display_name_ar, display_name_en, min_tier, enabled)",
    );
  });

  it("★ والإدراج لا يدهس صفًّا قائمًا", () => {
    expect((CODE.match(/on conflict \(id\) do nothing/g) ?? []).length).toBe(2);
  });

  it("★ وحارس تعارض يفشل بوضوح بدل التمرير الصامت", () => {
    expect(CODE).toContain("raise exception");
    expect(CODE).toMatch(/is distinct from/);
  });

  it("★ ★ والحارس يفحص **كل** حقل يُزرع — لا عيّنة منه", () => {
    /**
     * `on conflict do nothing` يترك الصفّ القائم صامتًا. فحارسٌ يفحص بعض
     * الحقول يمرّر تعارضًا في البقية — وهو ما كان قبل هذا التصحيح.
     *
     * فيُقارَن ما يُفحص بما يُزرع: مجموعتان يجب أن تتطابقا.
     */
    const providerFields = ["display_name", "enabled"];
    const modelFields = [
      "provider_id",
      "display_name_ar",
      "display_name_en",
      "min_tier",
      "enabled",
    ];
    for (const f of [...providerFields, ...modelFields]) {
      expect(CODE, f).toMatch(new RegExp(`v_[pm]\\.${f} is distinct from`));
    }
  });

  it("★ ويستعمل is distinct from لا <> — فالصفّ الغائب لا يفلت", () => {
    /**
     * `<>` يُعطي `null` حين يغيب الصفّ، فلا يدخل شرط `if` — فيبدو الحارس
     * صحيحًا وهو أعمى عن الحالة التي وُضع لها أصلًا.
     */
    const guard = CODE.slice(CODE.indexOf("do $$"), CODE.indexOf("end $$;"));
    expect(guard).not.toMatch(/v_[pm]\.\w+\s*<>/);
    // سبعة فحوص: اثنان للمزوّد وخمسة للنموذج
    expect((guard.match(/is distinct from/g) ?? []).length).toBe(7);
  });

  it("★ ولا يفحص created_at — طابعُ إنشاء لا هوية", () => {
    const guard = CODE.slice(CODE.indexOf("do $$"), CODE.indexOf("end $$;"));
    expect(guard).not.toContain("created_at");
  });
});

/* ═════════ (١٢) تطابق الأنواع مع SQL ═════════ */

describe("★ (١٢) اتحادات TypeScript تطابق حالات SQL", () => {
  /** يستخرج قيم `check (col in (...))` من الشيفرة */
  const extract = (col: string): string[] => {
    const m = CODE.match(new RegExp(`check \\(${col} in \\(([^)]+)\\)\\)`));
    expect(m, col).toBeTruthy();
    return m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
  };

  it("★ حالات النسخة", () => {
    const ts: ModelVersionStatus[] = ["draft", "candidate", "approved", "retired"];
    // الحالة الأولى في SQL هي حالة النسخة (الجدول الأول)
    const sqlAll = [...CODE.matchAll(/check \(status in \(([^)]+)\)\)/g)].map((m) =>
      m[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort(),
    );
    expect(sqlAll[0]).toEqual([...ts].sort());
  });

  it("★ حالات النشرة", () => {
    const ts: DeploymentStatus[] = ["inactive", "active", "failed", "retired"];
    const sqlAll = [...CODE.matchAll(/check \(status in \(([^)]+)\)\)/g)].map((m) =>
      m[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort(),
    );
    expect(sqlAll[1]).toEqual([...ts].sort());
  });

  it("★ البيئات", () => {
    const ts: DeploymentEnvironment[] = ["development", "staging", "production"];
    expect(extract("environment")).toEqual([...ts].sort());
  });
});

/* ═════════ (١٣–١٧) isServableDeployment ═════════ */

const version = (over: Partial<ModelVersionRecord> = {}): ModelVersionRecord => ({
  id: "v-1",
  modelId: "ysd/model-alpha",
  version: "1.0.0",
  status: "approved",
  baseModelRef: "base-a",
  artifactRef: "artifact-1",
  createdAt: "2026-01-01T00:00:00Z",
  approvedAt: "2026-01-02T00:00:00Z",
  retiredAt: null,
  ...over,
});

const deployment = (over: Partial<ModelDeploymentRecord> = {}): ModelDeploymentRecord => ({
  id: "d-1",
  modelId: "ysd/model-alpha",
  modelVersionId: "v-1",
  environment: "production",
  status: "active",
  endpointAlias: "ysd-inference-primary",
  runtimeModel: "rt-a",
  createdAt: "2026-01-03T00:00:00Z",
  activatedAt: "2026-01-03T00:00:00Z",
  retiredAt: null,
  ...over,
});

describe("★ (١٣–١٧) بوابة الخدمة", () => {
  it("★ (١٣) معتمدة + نشطة ⇒ true", () => {
    expect(isServableDeployment(deployment(), version())).toBe(true);
  });

  it("★ (١٤) نسخة مرشّحة (أو مسوّدة أو متقاعدة) ⇒ false", () => {
    for (const s of ["draft", "candidate", "retired"] as const) {
      expect(isServableDeployment(deployment(), version({ status: s })), s).toBe(false);
    }
  });

  it("★ (١٥) نشرة غير نشطة ⇒ false", () => {
    for (const s of ["inactive", "failed", "retired"] as const) {
      expect(isServableDeployment(deployment({ status: s }), version()), s).toBe(false);
    }
  });

  it("★ (١٦) اختلاف النموذج المنطقيّ ⇒ false", () => {
    expect(
      isServableDeployment(deployment({ modelId: "ysd/other" }), version()),
    ).toBe(false);
    // وحتى لو تطابق النموذج واختلف معرّف النسخة
    expect(isServableDeployment(deployment({ modelVersionId: "v-9" }), version())).toBe(false);
  });

  it("★ (١٧) غياب النتاج أو معرّف التشغيل أو الاسم المستعار ⇒ false", () => {
    expect(isServableDeployment(deployment(), version({ artifactRef: null }))).toBe(false);
    expect(isServableDeployment(deployment(), version({ artifactRef: "   " }))).toBe(false);
    expect(isServableDeployment(deployment({ runtimeModel: "  " }), version())).toBe(false);
    expect(isServableDeployment(deployment({ endpointAlias: "" }), version())).toBe(false);
  });

  it("★ دالة نقيّة: لا قاعدة ولا شبكة ولا بيئة", () => {
    const SRC = readFileSync("lib/ai/model-registry.ts", "utf8");
    for (const bad of ["supabase", "fetch(", "process.env", "http"]) {
      expect(SRC.toLowerCase(), bad).not.toContain(bad);
    }
  });

  it("★ ونتيجتها لا تتغيّر بتكرار النداء — بلا حالة", () => {
    const d = deployment();
    const v = version();
    expect(isServableDeployment(d, v)).toBe(isServableDeployment(d, v));
  });
});

/* ═════════ لا تكامل مع المحادثة ═════════ */

describe("★ الرقعة لا تمسّ مسار المحادثة", () => {
  it("★ السجلّ يصل مزوّد YSD وحده — لا المسار ولا سياسة النماذج", () => {
    /**
     * ★ حُدِّث في الرقعة الخامسة: مزوّد YSD صار يستورد أنواع السجلّ ويحلّ
     * نشرته. والمسار وسياسة النماذج ما زالا لا يعرفانه — وذلك ما يهمّ.
     */
    const YSD = readFileSync("lib/ai/ysd.ts", "utf8");
    expect(YSD).toContain("model-registry");

    const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
    const POLICY = readFileSync("lib/ai/model-policy.ts", "utf8");
    for (const [name, src] of [["route", ROUTE], ["policy", POLICY]] as const) {
      expect(src, name).not.toContain("model-registry");
      expect(src, name).not.toContain("isServableDeployment");
    }
  });
});
