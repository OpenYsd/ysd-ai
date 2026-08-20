/**
 * جاهزية التدريب وخطّة التنفيذ (v0.9.10، المرحلة 4B-1).
 *
 * ── سؤالان لا واحد ──
 *
 *   أصحيحةٌ المواصفة؟   ← `validateTrainingJobForExecution`
 *   أَيَحسُن أن نبدأ؟     ← `validateTrainingReadiness`
 *
 * والفرق حقيقيّ: مواصفةٌ **صحيحة** قد تكون **غير حكيمة**. والحالة القائمة
 * في الإنتاج بالضبط كذلك — مواصفةٌ سليمة على عيّنةٍ واحدة.
 *
 * ── ولا تنفيذ ──
 *
 * لا نداءَ مزوّد، ولا عتاد، ولا مفتاح، ولا زرّ. والخطّة وصفٌ يُقرأ قبل أن
 * يُنفق شيء.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  READINESS_POLICY_VERSION,
  TRAINING_READINESS_POLICY,
  validateTrainingReadiness,
} from "@/lib/training/readiness";
import {
  EXECUTOR_VERSION,
  RUNPOD_A100_80GB,
  RUNPOD_PRICE_REFERENCE,
  buildTrainingExecutionPlan,
  canonicalExecutionPlan,
  hashExecutionPlan,
} from "@/lib/training/execution-plan";
import {
  TRAINING_RUNTIME_STACK,
  canonicalRuntimeStack,
  isPinnedVersion,
  isStackPinned,
} from "@/lib/training/runtime-stack";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const READINESS_SRC = readSrc("lib/training/readiness.ts");
const PLAN_SRC = readSrc("lib/training/execution-plan.ts");
const STACK_SRC = readSrc("lib/training/runtime-stack.ts");
const ROUTE = readSrc("app/api/admin/training-jobs/[id]/execution-plan/route.ts");
const SECTION = readSrc("components/admin/training-jobs-section.tsx");
const PAGE = readSrc("app/admin/training/page.tsx");

const JOB = "11111111-0000-4000-8000-000000000001";
const ART = "dddddddd-0000-4000-8000-000000000001";
const REL = "ffffffff-0000-4000-8000-000000000001";
const REV = "6cee5e81ee83917806bbde320786a8fb61efebee";
const CONFIG_HASH = "a".repeat(64);

interface Over {
  exec?: { ok: boolean; reason?: string; invalid?: Record<string, number> };
  artifactStatus?: string;
  artifactSamples?: number;
  releaseStatus?: string;
  releaseSamples?: number;
  jobStatus?: string;
  jobRows?: Record<string, unknown>[];
  stackPinned?: boolean;
  stackVerified?: boolean;
  dbError?: boolean;
}

function memoryDb(over: Over = {}) {
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => {
          if (over.dbError) return Promise.resolve({ data: null, error: { code: "x" } });
          if (table === "training_dataset_artifacts") {
            return Promise.resolve({
              data: [{
                status: over.artifactStatus ?? "ready",
                sample_count: over.artifactSamples ?? 1,
                dataset_release_id: REL,
              }],
              error: null,
            });
          }
          if (table === "training_dataset_releases") {
            return Promise.resolve({
              data: [{
                version: "ysd-dataset-000001",
                status: over.releaseStatus ?? "frozen",
                sample_count: over.releaseSamples ?? over.artifactSamples ?? 1,
              }],
              error: null,
            });
          }
          if (table === "training_jobs") {
            return Promise.resolve({
              data: over.jobRows ?? [{
                version: "ysd-train-000001",
                base_model_id: "openai/gpt-oss-20b",
                base_model_revision: REV,
                method: "lora_sft",
                preset_id: "ysd-lora-v1",
                config_version: "ysd-training-config-v1",
                config_hash: CONFIG_HASH,
                seed: 20260820,
                status: over.jobStatus ?? "prepared",
                dataset_artifact_id: ART,
              }],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
      });
      return chain;
    },
  };
  return { client };
}

const deps = (db: ReturnType<typeof memoryDb>, over: Over = {}) => ({
  getAdminClient: (() => db.client) as never,
  validateExecution: (async () =>
    over.exec?.ok === false
      ? { ok: false, reason: over.exec.reason ?? "artifact_invalid", invalid: over.exec.invalid }
      : {
          ok: true, jobId: JOB, version: "ysd-train-000001",
          configHash: CONFIG_HASH, artifactId: ART,
        }) as never,
  stackPinned: () => over.stackPinned ?? true,
  stackVerified: () => over.stackVerified ?? true,
});

const readiness = (over: Over = {}) => validateTrainingReadiness(JOB, deps(memoryDb(over), over));

/* ═══════════ (١) السياسة ═══════════ */

describe("★ (١) السياسة — أرضيةٌ تشغيلية لا ضمانَ جودة", () => {
  it("★ ★ نسخةٌ صريحة وحدٌّ أدنى مئة", () => {
    expect(READINESS_POLICY_VERSION).toBe("ysd-training-readiness-v1");
    expect(TRAINING_READINESS_POLICY.minimumSamples).toBe(100);
  });

  it("★ ★ ★ والمصدر يقول صراحةً إنها ليست وعدًا بجودة", () => {
    /**
     * ── وهذا أهمّ ما في السياسة ──
     *
     * مئة عيّنةٍ ليست العدد الذي يصير عنده النموذج جيّدًا. هي الحدّ الذي
     * دونه يكون ما يقع **حِفظًا لا تعلّمًا**: النموذج يمرّ على القليل مرارًا
     * فيستطيع أن يُخرجه كما كُتب. وعيّناتنا كلامُ أناسٍ أذنوا بأن يُتعلَّم
     * منه، لا بأن يُستظهَر.
     *
     * فالحدّ حمايةٌ لصاحب الكلام قبل أن يكون حمايةً لجودة نموذج.
     */
    expect(READINESS_SRC).toMatch(/ليست\*\* وعدًا بنموذجٍ جيّد|ليست دعوى جودة/);
    expect(READINESS_SRC).toMatch(/أرضيةٌ تشغيليّة/);
    expect(READINESS_SRC).toMatch(/حِفظًا/);
  });

  it("★ ★ والحدّ في الخادم — لا يمرّره متصفّح", () => {
    const src = stripComments(READINESS_SRC);
    expect(src).toMatch(/minimumSamples: 100/);
    /** ولا يُقرأ من مُدخَلٍ ولا من بيئة */
    expect(src).not.toMatch(/process\.env|minimumSamples\s*[:=]\s*(input|body|params)/);
    /**
     * ★ والقياس على **مصدر** الحدّ لا على ذكر اسمه.
     *
     * فالمسار يُعيد `minimumSamples` في الجواب — وهو عددٌ حسبه الخادم من
     * السياسة، لا قيمةٌ قُرئت من طلب. والدليل أنّ المسار لا يقرأ جسمًا
     * أصلًا، ويأخذ العدد من `readiness.facts` وحدها.
     */
    const route = stripComments(ROUTE);
    expect(route).not.toMatch(/req\.json\(\)/);
    expect(route).toMatch(/minimumSamples: readiness\.facts\?\.minimumSamples/);
  });
});

/* ═══════════ (٢) عدد العيّنات ═══════════ */

describe("★ (٢) عدد العيّنات — البوّابة التي تردّ اليوم", () => {
  it("★ ★ ★ صفر · واحد · تسعٌ وتسعون ⇒ `insufficient_training_data`", async () => {
    for (const n of [0, 1, 50, 99]) {
      const r = await readiness({ artifactSamples: n });
      expect(r.ready).toBe(false);
      if (!r.ready) {
        expect(r.reason).toBe("insufficient_training_data");
        expect(r.facts?.sampleCount).toBe(n);
        expect(r.facts?.minimumSamples).toBe(100);
      }
    }
  });

  it("★ ★ ومئةٌ فما فوق تجتاز هذه البوّابة", async () => {
    for (const n of [100, 101, 5000]) {
      const r = await readiness({ artifactSamples: n });
      expect(r.ready).toBe(true);
      if (r.ready) expect(r.facts.sampleCount).toBe(n);
    }
  });

  it("★ ★ ★ والحالة القائمة في الإنتاج ترجع بهذا الرمز بالضبط", async () => {
    /**
     * مُجهَّزة · نموذجٌ مثبَّت · أثرٌ صالح · مجموعةٌ مجمَّدة · عيّنةٌ واحدة.
     * فالمواصفة صحيحة والبدء غير حكيم — وهذا ما يقوله الرمز.
     */
    const r = await readiness({ artifactSamples: 1, releaseSamples: 1 });
    expect(r.ready).toBe(false);
    if (!r.ready) {
      expect(r.reason).toBe("insufficient_training_data");
      expect(r.facts).toMatchObject({
        sampleCount: 1,
        minimumSamples: 100,
        policyVersion: "ysd-training-readiness-v1",
      });
    }
  });
});

/* ═══════════ (٣) بقيّة البوّابات ═══════════ */

describe("★ (٣) وما دون العيّنات من حراس", () => {
  it("★ ★ مواصفةٌ غير صالحة ⇒ لا جاهزية، ولا يُسأل عن العيّنات", async () => {
    for (const [reason, expected] of [
      ["job_not_found", "job_not_found"],
      ["not_prepared", "not_prepared"],
      ["cancelled", "cancelled"],
      ["artifact_invalid", "execution_invalid"],
      ["config_mismatch", "execution_invalid"],
      ["base_model_unpinned", "execution_invalid"],
    ] as const) {
      const r = await readiness({ exec: { ok: false, reason }, artifactSamples: 5000 });
      expect(r.ready).toBe(false);
      if (!r.ready) expect(r.reason).toBe(expected);
    }
  });

  it("★ ★ والحارس المركزيّ يُنادى — لا نسخةٌ منه", () => {
    const src = stripComments(READINESS_SRC);
    expect(src).toMatch(/d\.validateExecution\(jobId\)/);
    expect(src).not.toMatch(/screenPrivacy|computeContentFingerprint|isVerifiedRevision/);
  });

  it("★ ★ وأثرٌ ليس `ready` أو مجموعةٌ ليست مجمَّدة ⇒ لا جاهزية", async () => {
    const a = await readiness({ artifactSamples: 200, artifactStatus: "pending" });
    expect(a.ready).toBe(false);
    if (!a.ready) expect(a.reason).toBe("artifact_not_ready");

    const b = await readiness({ artifactSamples: 200, releaseStatus: "draft" });
    expect(b.ready).toBe(false);
    if (!b.ready) expect(b.reason).toBe("dataset_not_frozen");
  });

  it("★ ★ وعددان مختلفان بين الأثر والمجموعة ⇒ أحدهما ليس هي", async () => {
    const r = await readiness({ artifactSamples: 200, releaseSamples: 199 });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("sample_count_mismatch");
  });

  it("★ ★ ★ ومكدّسٌ غير مُتحقَّقٍ منه ⇒ لا جاهزية", async () => {
    /**
     * فنسخٌ موجودة لا تعني نسخًا تعمل معًا. والتحقّق تشغيلةٌ تنجح، لا سطرٌ
     * يُبدَّل — وحتى تقع، لا يُسلَّم شيءٌ إلى مُنفِّذ.
     */
    const r = await readiness({ artifactSamples: 200, stackVerified: false });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("dependency_stack_unverified");
  });

  it("★ ★ والعيّنات تُفحص **قبل** المكدّس", async () => {
    /**
     * فالسبب الذي يخصّ البيانات هو ما ينبغي أن يقرأه المشرف — لا تفصيلٌ
     * في نسخِ مكتبات.
     */
    const r = await readiness({ artifactSamples: 1, stackVerified: false });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("insufficient_training_data");
  });

  it("★ وعطلُ القاعدة عطلٌ صريح", async () => {
    const r = await readiness({ dbError: true });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("database_error");
  });
});

/* ═══════════ (٤) المكدّس ═══════════ */

describe("★ (٤) المكدّس — مثبَّتٌ وغير مُتحقَّقٍ منه بعد", () => {
  it("★ ★ ★ ولا `latest` ولا `main`", () => {
    /**
     * فمكدّسٌ يقول «الأحدث» يبني اليوم شيئًا وغدًا آخر، ويجعل «أعِد إنتاج
     * هذا التدريب» جملةً بلا معنى.
     */
    expect(isStackPinned()).toBe(true);
    for (const bad of ["latest", "main", "master", "nightly", "dev", "*", ""]) {
      expect(isPinnedVersion(bad)).toBe(false);
    }
    for (const v of Object.values(TRAINING_RUNTIME_STACK.packages)) {
      expect(v).toMatch(/^\d+\.\d+/);
    }
  });

  it("★ ★ ★ و`verified: false` — لأن التوافق لم يُثبَت", () => {
    /**
     * ── والصدق هنا أهمّ من الاكتمال ──
     *
     * كلّ نسخةٍ إصدارٌ منشور تحقّقتُ من وجوده. أما أنها تعمل معًا لـgpt-oss
     * فدعوى تحتاج تشغيلًا يُثبتها، ولم يقع. ولو كُتبت `true` اليوم لكانت
     * دعوى لا يسندها شيء — وهي أخطر من غيابها، لأن من يقرؤها يبني عليها.
     */
    expect(TRAINING_RUNTIME_STACK.verified).toBe(false);
    expect(STACK_SRC).toMatch(/وما لم يثبت/);
  });

  it("★ ★ والدليل مذكورٌ بمصدره", () => {
    const ev = TRAINING_RUNTIME_STACK.evidence.join(" | ");
    expect(ev).toMatch(/GptOssForCausalLM/);
    expect(ev).toMatch(/transformers_version 4\.55/);
    expect(ev).toMatch(/sft_gpt_oss\.py/);
    expect(ev).toMatch(/Mxfp4Config\(dequantize=True\)/);
  });

  it("★ ★ والحزم تشمل ما يطلبه المثال الرسميّ", () => {
    const p = TRAINING_RUNTIME_STACK.packages;
    for (const name of ["torch", "transformers", "trl", "peft", "accelerate", "datasets", "kernels"]) {
      expect(p[name]).toBeDefined();
    }
  });

  it("★ والصياغة حتميّة ومرتَّبةٌ أبجديًّا", () => {
    const a = canonicalRuntimeStack();
    expect(a).toBe(canonicalRuntimeStack());
    const names = a.split("\n").filter((l) => l.startsWith("pkg\t")).map((l) => l.split("\t")[1]!);
    expect(names).toEqual([...names].sort());
  });
});

/* ═══════════ (٥) خطّة التنفيذ ═══════════ */

describe("★ (٥) الخطّة — وصفٌ لا أمر", () => {
  it("★ ★ تُبنى للمُجهَّزة وتحمل العتاد والمراجعة", async () => {
    const db = memoryDb();
    const r = await buildTrainingExecutionPlan(JOB, {
      getAdminClient: (() => db.client) as never,
      checkReadiness: (async () => ({
        ready: false, reason: "insufficient_training_data",
        facts: { jobVersion: "v", datasetVersion: "ysd-dataset-000001", sampleCount: 1,
                 minimumSamples: 100, policyVersion: READINESS_POLICY_VERSION },
      })) as never,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.plan.provider).toBe("runpod");
      expect(r.result.plan.gpuProfile).toBe("A100-80GB");
      expect(r.result.plan.gpuCount).toBe(1);
      expect(r.result.plan.revision).toBe(REV);
      expect(r.result.plan.expectedOutputType).toBe("lora_adapter");
      expect(r.result.plan.executable).toBe(false);
      expect(r.result.planHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("★ ★ ★ و`executable` ثابتةٌ `false` بالنوع", () => {
    /**
     * فحقلٌ منطقيّ يُحسب يومًا يصير `true` بسطرٍ يُبدَّل. والنوع الحرفيّ
     * يجعل جعلَها `true` خطأَ بناءٍ لا خطأ مراجعة.
     */
    expect(PLAN_SRC).toMatch(/executable: false;/);
    expect(stripComments(PLAN_SRC)).not.toMatch(/executable:\s*true/);
  });

  it("★ ★ ومسوَّدةٌ لا خطّة لها", async () => {
    const db = memoryDb({ jobStatus: "draft" });
    const r = await buildTrainingExecutionPlan(JOB, {
      getAdminClient: (() => db.client) as never,
      checkReadiness: (async () => ({ ready: false, reason: "not_prepared" })) as never,
    });
    expect(r).toEqual({ ok: false, reason: "not_prepared" });
  });

  it("★ ★ والخطّة تحمل حكم الجاهزية معها", async () => {
    /**
     * فلا تُقرأ الخطّة وحدها فتُفهم إذنًا. من يقرأ «ماذا سيجري» يقرأ معه
     * «أَيَحسُن أن يجري».
     */
    const db = memoryDb();
    const r = await buildTrainingExecutionPlan(JOB, {
      getAdminClient: (() => db.client) as never,
      checkReadiness: (async () => ({
        ready: false, reason: "insufficient_training_data",
        facts: { sampleCount: 1, minimumSamples: 100 },
      })) as never,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.readiness.ready).toBe(false);
  });
});

/* ═══════════ (٦) بصمة الخطّة ═══════════ */

describe("★ (٦) البصمة — وما يدخلها وما لا يدخلها", () => {
  const plan = {
    executorVersion: EXECUTOR_VERSION,
    provider: "runpod" as const,
    gpuProfile: RUNPOD_A100_80GB.id,
    gpuCount: 1,
    baseModel: "openai/gpt-oss-20b",
    revision: REV,
    method: "lora_sft",
    trainingConfigVersion: "ysd-training-config-v1",
    preset: "ysd-lora-v1",
    seed: 20260820,
    datasetVersion: "ysd-dataset-000001",
    sampleCount: 1,
    runtimeStackVersion: TRAINING_RUNTIME_STACK.version,
    dependencyVersions: TRAINING_RUNTIME_STACK.packages,
    expectedOutputType: "lora_adapter",
    executable: false as const,
  };

  it("★ ★ نفس الخطّة ⇒ نفس البصمة", () => {
    const a = hashExecutionPlan(canonicalExecutionPlan(plan, CONFIG_HASH));
    const b = hashExecutionPlan(canonicalExecutionPlan({ ...plan }, CONFIG_HASH));
    expect(a).toBe(b);
    expect(a).toBe(createHash("sha256")
      .update(canonicalExecutionPlan(plan, CONFIG_HASH), "utf8").digest("hex"));
  });

  it("★ ★ وبصمةُ مواصفةٍ مختلفة ⇒ خطّةٌ مختلفة", () => {
    expect(hashExecutionPlan(canonicalExecutionPlan(plan, "b".repeat(64))))
      .not.toBe(hashExecutionPlan(canonicalExecutionPlan(plan, CONFIG_HASH)));
  });

  it("★ ★ وعتادٌ مختلف أو نسخةُ مُنفِّذٍ مختلفة ⇒ خطّةٌ مختلفة", () => {
    const base = hashExecutionPlan(canonicalExecutionPlan(plan, CONFIG_HASH));
    expect(hashExecutionPlan(canonicalExecutionPlan({ ...plan, gpuProfile: "H100-80GB" }, CONFIG_HASH)))
      .not.toBe(base);
    expect(hashExecutionPlan(canonicalExecutionPlan({ ...plan, gpuCount: 2 }, CONFIG_HASH)))
      .not.toBe(base);
    expect(hashExecutionPlan(canonicalExecutionPlan({ ...plan, executorVersion: "v2" }, CONFIG_HASH)))
      .not.toBe(base);
  });

  it("★ ★ ونسخةُ تبعيّةٍ مختلفة ⇒ خطّةٌ مختلفة", () => {
    const other = { ...TRAINING_RUNTIME_STACK, packages: { ...TRAINING_RUNTIME_STACK.packages, torch: "2.12.0" } };
    expect(hashExecutionPlan(canonicalExecutionPlan(plan, CONFIG_HASH, other)))
      .not.toBe(hashExecutionPlan(canonicalExecutionPlan(plan, CONFIG_HASH)));
  });

  it("★ ★ ★ والسعرُ لا يدخلها", () => {
    /**
     * فالسعر يتغيّر، وإعادةُ إنتاج تدريبٍ لا علاقة لها بما كلّف يومها. ومن
     * يُدخله يجعل خطّتين متطابقتين تختلفان لأن سعرًا تحرّك.
     */
    const canonical = canonicalExecutionPlan(plan, CONFIG_HASH);
    expect(canonical).not.toMatch(/1\.19|1\.39|usd|price|cost/i);
    for (const leak of ["Date", "createdAt", "createdBy", "admin", "observedOn"]) {
      expect(canonical).not.toContain(leak);
    }
    expect(RUNPOD_PRICE_REFERENCE.binding).toBe(false);
  });

  it("★ ★ ولا سرَّ ولا نصَّ ولا مسارَ في الخطّة", () => {
    const json = JSON.stringify(plan);
    for (const leak of ["storage", "signed", "http", "token", "key", "secret", "userText", "messages"]) {
      expect(json.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

/* ═══════════ (٧) لا تنفيذ ═══════════ */

describe("★ (٧) ★ ولا تنفيذ — ولا سبيلَ إليه", () => {
  const ALL = [READINESS_SRC, PLAN_SRC, STACK_SRC, ROUTE, SECTION, PAGE];

  it("★ ★ ★ ولا نداءَ شبكةٍ إلى RunPod", () => {
    for (const src of ALL) {
      const s = stripComments(src);
      expect(s).not.toMatch(/api\.runpod\.io|runpod\.io\/graphql|rest\.runpod/i);
      expect(s).not.toMatch(/fetch\(\s*["'`]https?:/);
    }
  });

  it("★ ★ ★ ولا إنشاءَ عتادٍ ولا وعاءٍ ولا نقطةِ خدمة", () => {
    for (const src of ALL) {
      const s = stripComments(src);
      expect(s).not.toMatch(/createPod|deployPod|podFindAndDeploy|createEndpoint|startWorker|allocateGpu|createVolume/i);
    }
  });

  it("★ ★ ★ ولا مفتاحَ ولا سرَّ ولا متغيّرَ بيئة", () => {
    for (const src of ALL) {
      const s = stripComments(src);
      expect(s).not.toMatch(/RUNPOD_API_KEY|HF_TOKEN|HUGGINGFACE_TOKEN/);
      expect(s).not.toMatch(/process\.env/);
    }
  });

  it("★ ★ ★ ولا مسارَ `POST` للتنفيذ", () => {
    const s = stripComments(ROUTE);
    expect(s).toMatch(/export async function GET/);
    expect(s).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it("★ ★ ★ ولا زرَّ «تشغيل» ولا «تدريب» ولا «إطلاق»", () => {
    const ui = SECTION;
    for (const bad of [/data-job-(start|run|launch|train)/, /Start training/i, /Launch/i]) {
      expect(ui).not.toMatch(bad);
    }
    /** والزرّ الوحيد المتعلّق بالخطّة قراءةٌ */
    expect(ui).toMatch(/data-job-plan=/);
  });

  it("★ ★ ولا تنفيذَ لأمرٍ ولا تحميلَ أوزان", () => {
    for (const src of ALL) {
      const s = stripComments(src);
      expect(s).not.toMatch(/child_process|execSync|spawn\(|snapshot_download|from_pretrained/i);
    }
  });

  it("★ ★ ولا ترحيلةَ جديدة", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(45);
  });
});

/* ═══════════ (٨) المسار والواجهة ═══════════ */

describe("★ (٨) المسار — قراءةٌ للمشرف وحده", () => {
  const s = stripComments(ROUTE);

  it("★ ★ بلا جلسة ⇒ 401 · بلا صلاحية ⇒ 403", () => {
    expect(s).toMatch(/getAdminContext/);
    expect(s).toMatch(/unauthorized\(\)/);
    expect(s).toMatch(/forbidden\(\)/);
  });

  it("★ ★ والحكم يُعاد مع الخطّة", () => {
    expect(s).toMatch(/readyForExecution: readiness\.ready/);
    expect(s).toMatch(/minimumSamples/);
  });

  it("★ ★ ولا مسارَ تخزينٍ ولا رابطَ ولا بايتة", () => {
    for (const leak of ["storage_path", "storagePath", "signedUrl", "createSignedUrl", "bucket"]) {
      expect(s).not.toMatch(new RegExp(leak, "i"));
    }
  });

  it("★ ★ والسعرُ موسومٌ بأنه تقدير", () => {
    expect(s).toMatch(/costEstimate/);
    expect(PLAN_SRC).toMatch(/binding: false/);
  });

  it("★ ★ والجاهزية تُحسب في الخادم لا في المتصفّح", () => {
    expect(stripComments(PAGE)).toMatch(/validateTrainingReadiness\(j\.id\)/);
    const ui = stripComments(SECTION);
    expect(ui).not.toMatch(/minimumSamples\s*=\s*\d|< *100|100 *>/);
  });

  it("★ ★ ولا تسجيلَ لمحتوى", () => {
    for (const src of [READINESS_SRC, PLAN_SRC, ROUTE]) {
      for (const m of stripComments(src).match(/console\.\w+\([^)]*\)/g) ?? []) {
        expect(m).not.toMatch(/content|userText|canonical|hash|sample/i);
      }
    }
  });
});
