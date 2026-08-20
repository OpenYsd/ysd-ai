import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { validateTrainingReadiness, type ReadinessVerdict } from "./readiness";
import {
  TRAINING_RUNTIME_STACK,
  canonicalRuntimeStack,
  type RuntimeStack,
} from "./runtime-stack";

/**
 * خطّة تنفيذ التدريب (v0.9.10، المرحلة 4B-1) — **وصفٌ لا تشغيل**.
 *
 * ── ما هي ──
 *
 * جوابٌ مكتوب لسؤال: لو سلّمنا هذه المواصفة إلى عتاد، فبأيّ عتادٍ وأيّ
 * نسخٍ وأيّ مدخلات؟ وقيمتُها أن تُقرأ **قبل** أن يُنفق شيء.
 *
 * ── وما ليست ──
 *
 * ليست أمرًا يُنفَّذ. لا يُنشأ منها وعاءٌ ولا نقطةُ خدمة ولا عاملٌ ولا
 * قرص، ولا يُطلب بها عتاد، ولا يُنادى بها مزوّد. ولا يوجد في هذه الرقعة
 * دالّةٌ تُرسل شيئًا إلى RunPod — ولا مفتاحٌ تُرسل به.
 *
 * ── ولماذا A100-80GB ──
 *
 * لأن المثال الرسميّ في TRL يمرّر `Mxfp4Config(dequantize=True)`: أوزان
 * الخبراء المضغوطة تُفكّ إلى bf16 قبل التدريب. فرقمُ «١٦ ج.ب» في بطاقة
 * النموذج رقمُ **استدلال**؛ وعشرون مليار معامل في بايتين ≈ ٤٢ ج.ب للأوزان
 * وحدها، قبل حالة المُحسِّن والتنشيطات.
 *
 * فالثمانون أوّل حجمٍ يتّسع لِما نعرف أنه سيقع — لا الأفضل ولا الأسرع.
 * وH100 وما فوقها تُترك حتى يوجد قياسٌ يطلبها: اختيارُ الأغلى بلا قياس
 * إنفاقٌ لا هندسة.
 */

export const EXECUTOR_VERSION = "ysd-executor-v1";

/** المزوّد المستهدَف لأوّل طيّار — ولا نداءَ له في هذه المرحلة */
export type TrainingProvider = "runpod";

export interface GpuProfile {
  id: string;
  vendor: string;
  memoryGb: number;
  count: number;
}

export const RUNPOD_A100_80GB: GpuProfile = {
  id: "A100-80GB",
  vendor: "nvidia",
  memoryGb: 80,
  count: 1,
};

/**
 * ★ تقديرُ كلفةٍ — إعلاميّ، ولا يدخل بصمةً.
 *
 * السعر يتغيّر، وإعادةُ إنتاج تدريبٍ لا علاقة لها بما كلّف يومها. ومن
 * يُدخله في البصمة يجعل خطّتين متطابقتين تختلفان لأن سعرًا تحرّك.
 *
 * والقيم من صفحة تسعير RunPod الرسمية بتاريخ 2026-08-20، سحابة المجتمع —
 * وتُعرض موسومةً بأنها تقدير.
 */
export const RUNPOD_PRICE_REFERENCE = Object.freeze({
  observedOn: "2026-08-20",
  source: "runpod.io/pricing",
  a100PcieUsdPerHour: 1.19,
  a100SxmUsdPerHour: 1.39,
  binding: false,
});

export interface ExecutionPlan {
  executorVersion: string;
  provider: TrainingProvider;
  gpuProfile: string;
  gpuCount: number;
  baseModel: string;
  revision: string;
  method: string;
  trainingConfigVersion: string;
  preset: string;
  seed: number;
  datasetVersion: string;
  sampleCount: number;
  runtimeStackVersion: string;
  dependencyVersions: Readonly<Record<string, string>>;
  expectedOutputType: string;
  /** أهذه الخطّة صالحةٌ للتسليم؟ — وفي هذه المرحلة: لا، دائمًا */
  executable: false;
}

export type PlanFailure = "job_not_found" | "not_prepared" | "database_error";

export interface PlanResult {
  plan: ExecutionPlan;
  planHash: string;
  readiness: ReadinessVerdict;
}

export interface PlanDependencies {
  getAdminClient: typeof getAdminClient;
  checkReadiness: typeof validateTrainingReadiness;
  stack: RuntimeStack;
}

const DEFAULTS: PlanDependencies = {
  getAdminClient,
  checkReadiness: validateTrainingReadiness,
  stack: TRAINING_RUNTIME_STACK,
};

interface JobFacts {
  version: string;
  base_model_id: string;
  base_model_revision: string | null;
  method: string;
  preset_id: string;
  config_version: string;
  config_hash: string | null;
  seed: number;
  status: string;
  dataset_artifact_id: string;
}

/**
 * ★ الصياغة المعياريّة للخطّة — مرتَّبةٌ فرضًا لا عَرَضًا.
 *
 * ── ما يدخل البصمة ──
 *
 * بصمةُ المواصفة (وفيها الأثر والنموذج والمراجعة والأرقام)، ونسخُ المكدّس،
 * وملمحُ العتاد، ونسخةُ المُنفِّذ. لأن هذه الأربعة هي ما يجعل تشغيلتَين
 * تُنتجان الشيء نفسه — أو لا تُنتجانه.
 *
 * ── وما لا يدخلها ──
 *
 * السعر، ووقتُ الإنشاء، وهوّيةُ المشرف. فخطّتان متطابقتان بُنيتا في يومين
 * **هما نفسها**، وبصمةٌ تختلف لاختلاف اليوم تُفقد القدرة على قول ذلك.
 */
export function canonicalExecutionPlan(
  plan: ExecutionPlan,
  configHash: string,
  stack: RuntimeStack = TRAINING_RUNTIME_STACK,
): string {
  /**
   * ★ وصياغة المكدّس من وحدته لا نسخةً منها.
   *
   * فنسختان تعنيان أن أوّل تشديدٍ على إحداهما يترك الأخرى — فتختلف البصمة
   * عن مكدّسٍ لم يتغيّر.
   */
  const lines = [
    `executorVersion\t${plan.executorVersion}`,
    `configHash\t${configHash}`,
    `provider\t${plan.provider}`,
    `gpuProfile\t${plan.gpuProfile}`,
    `gpuCount\t${plan.gpuCount}`,
    canonicalRuntimeStack(stack).trimEnd(),
    `expectedOutputType\t${plan.expectedOutputType}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function hashExecutionPlan(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * ★ يبني خطّةً للقراءة — ولا يُسلّمها إلى أحد.
 *
 * ويُشغّل حارس الجاهزية ويُعيد حكمه كما هو: من يقرأ الخطّة يقرأ معها
 * **أَيَحسُن أن تُنفَّذ**، فلا تُقرأ الخطّة وحدها فتُفهم إذنًا.
 */
export async function buildTrainingExecutionPlan(
  jobId: string,
  deps: Partial<PlanDependencies> = {},
): Promise<{ ok: true; result: PlanResult } | { ok: false; reason: PlanFailure }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  let job: JobFacts;
  try {
    const { data, error } = await db
      .from("training_jobs")
      .select(
        "version, base_model_id, base_model_revision, method, preset_id, config_version, " +
          "config_hash, seed, status, dataset_artifact_id",
      )
      .eq("id", jobId)
      .limit(2);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as unknown as JobFacts[];
    if (rows.length === 0) return { ok: false, reason: "job_not_found" };
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    job = rows[0]!;
  } catch {
    return { ok: false, reason: "database_error" };
  }

  if (job.status !== "prepared" || job.config_hash === null) {
    return { ok: false, reason: "not_prepared" };
  }

  const readiness = await d.checkReadiness(jobId);

  let datasetVersion = "";
  let sampleCount = 0;
  if (readiness.facts) {
    datasetVersion = readiness.facts.datasetVersion ?? "";
    sampleCount = readiness.facts.sampleCount ?? 0;
  }

  const plan: ExecutionPlan = {
    executorVersion: EXECUTOR_VERSION,
    provider: "runpod",
    gpuProfile: RUNPOD_A100_80GB.id,
    gpuCount: RUNPOD_A100_80GB.count,
    baseModel: job.base_model_id,
    /**
     * ★ المراجعة من **المهمّة** لا من الفهرس.
     *
     * فما وُقّع عليه هو ما يُسلَّم. ولو قُرئت من الفهرس لتغيّرت خطّةُ مهمّةٍ
     * قديمة كلّما تقدّم — وهي لم تتغيّر.
     */
    revision: job.base_model_revision ?? "",
    method: job.method,
    trainingConfigVersion: job.config_version,
    preset: job.preset_id,
    seed: job.seed,
    datasetVersion,
    sampleCount,
    runtimeStackVersion: d.stack.version,
    dependencyVersions: d.stack.packages,
    expectedOutputType: "lora_adapter",
    /**
     * ★ ثابتةٌ `false` بالنوع لا بالقيمة.
     *
     * فحقلٌ منطقيّ يُحسب يومًا يصير `true` بسطرٍ يُبدَّل. والنوع الحرفيّ
     * يجعل جعلَها `true` خطأَ بناءٍ لا خطأ مراجعة.
     */
    executable: false,
  };

  const canonical = canonicalExecutionPlan(plan, job.config_hash, d.stack);
  return {
    ok: true,
    result: { plan, planHash: hashExecutionPlan(canonical), readiness },
  };
}
