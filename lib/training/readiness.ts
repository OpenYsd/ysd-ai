import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { validateTrainingJobForExecution } from "./job";
import { isStackPinned, TRAINING_RUNTIME_STACK } from "./runtime-stack";

/**
 * بوّابة جاهزية التدريب (v0.9.10، المرحلة 4B-1).
 *
 * ── أين تقع ──
 *
 *   validateTrainingJobForExecution   ⇦ أصحيحةٌ المواصفة؟
 *          ↓
 *   validateTrainingReadiness         ⇦ أَيَحسُن أن نبدأ؟
 *          ↓
 *   [مُنفِّذ — لم يُبنَ]
 *
 * والفرق بين السؤالين حقيقيّ: مواصفةٌ **صحيحة** قد تكون **غير حكيمة**.
 * الأولى تسأل: أهذا ما وُقّع عليه؟ والثانية: أيُنتج هذا شيئًا، أم يُنفق
 * عتادًا ومالًا على لا شيء — أو أسوأ؟
 *
 * ── ولماذا حدٌّ أدنى للعيّنات ──
 *
 * ── وهذه ليست دعوى جودة ──
 *
 *   مئة عيّنةٍ **ليست** وعدًا بنموذجٍ جيّد.
 *
 * هي **أرضيةٌ تشغيليّة**: دون ذلك، ما يقع ليس تعلّمًا بل حِفظًا. فالنموذج
 * يمرّ على العيّنات القليلة مرارًا فيستطيع أن يُخرجها كما كُتبت — وعيّناتنا
 * كلامُ أناسٍ أذنوا بأن **يُتعلَّم** منه، لا بأن يُستظهَر.
 *
 * فالحدّ حمايةٌ لصاحب الكلام قبل أن يكون حمايةً لجودة النموذج. ومن يرفعه
 * أو يخفضه يقرّر في ذلك، لا في رقمٍ إداريّ — ولذلك يعيش في الخادم، ولا
 * يمرّره متصفّح.
 */

/** نسخة السياسة — تُرفع إن تغيّر الحدّ أو معناه */
export const READINESS_POLICY_VERSION = "ysd-training-readiness-v1";

export interface ReadinessPolicy {
  version: string;
  /**
   * ★ أرضيةٌ تشغيليّة لا ضمانُ جودة.
   *
   * والمئة اختيارٌ متحفّظ لأوّل طيّار: تكفي لأن يكون المرور على المجموعة
   * تعميمًا لا استظهارًا، ولا تدّعي أن ما دونها بقليل عديمُ الفائدة ولا
   * أن ما فوقها بقليل كافٍ. وتُراجَع بالقياس حين يوجد ما يُقاس.
   */
  minimumSamples: number;
}

export const TRAINING_READINESS_POLICY: ReadinessPolicy = {
  version: READINESS_POLICY_VERSION,
  minimumSamples: 100,
};

export type ReadinessReason =
  | "job_not_found"
  | "not_prepared"
  | "cancelled"
  | "execution_invalid"
  | "insufficient_training_data"
  | "artifact_not_ready"
  | "dataset_not_frozen"
  | "sample_count_mismatch"
  | "dependency_stack_unverified"
  | "database_error";

export interface ReadinessFacts {
  jobVersion: string;
  datasetVersion: string;
  sampleCount: number;
  minimumSamples: number;
  policyVersion: string;
}

export type ReadinessVerdict =
  | { ready: true; facts: ReadinessFacts }
  | {
      ready: false;
      reason: ReadinessReason;
      facts?: Partial<ReadinessFacts>;
      /** أسبابُ بطلانٍ مجمَّعة من حارس التنفيذ — أعدادٌ لا نصوص */
      invalid?: Record<string, number>;
    };

export interface ReadinessDependencies {
  getAdminClient: typeof getAdminClient;
  validateExecution: typeof validateTrainingJobForExecution;
  stackPinned: () => boolean;
  stackVerified: () => boolean;
}

const DEFAULTS: ReadinessDependencies = {
  getAdminClient,
  validateExecution: validateTrainingJobForExecution,
  stackPinned: () => isStackPinned(),
  stackVerified: () => TRAINING_RUNTIME_STACK.verified,
};

/**
 * ★ أَيَحسُن أن نبدأ؟ — ولا يُنادى مُنفِّذٌ قبل أن تُجيب.
 *
 * ── الترتيب مقصود ──
 *
 * صحّةُ المواصفة أوّلًا: فلا معنى لسؤال «أتكفي العيّنات؟» عن مهمّةٍ لم
 * تُجهَّز أو بطل أثرُها. ثم عددُ العيّنات، ثم اتّساقُ ما يصفه الأثر مع ما
 * تصفه المجموعة، ثم المكدّس.
 *
 * وعددُ العيّنات قبل المكدّس عمدًا: هو السبب الذي يخصّ **البيانات**، وهو
 * ما ينبغي أن يقرأه المشرف اليوم — لا تفصيلٌ في نسخِ مكتبات.
 */
export async function validateTrainingReadiness(
  jobId: string,
  deps: Partial<ReadinessDependencies> = {},
): Promise<ReadinessVerdict> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ready: false, reason: "database_error" };
  }
  if (!db) return { ready: false, reason: "database_error" };

  /**
   * ★ (١) المواصفة صحيحة — بالحارس نفسه لا بنسخةٍ منه.
   *
   * وهو يفحص: الحالة `prepared`، وإجازة الأثر (وفيها الإذن والمصدر
   * والبيان)، وبصمة المواصفة، والنموذج الأساسيّ ومراجعته المتحقَّق منها.
   */
  const exec = await d.validateExecution(jobId);
  if (!exec.ok) {
    const reason: ReadinessReason =
      exec.reason === "job_not_found"
        ? "job_not_found"
        : exec.reason === "not_prepared"
          ? "not_prepared"
          : exec.reason === "cancelled"
            ? "cancelled"
            : "execution_invalid";
    return { ready: false, reason, invalid: exec.invalid };
  }

  // ── (٢) ما يصفه الأثر والمجموعة ──
  let sampleCount: number;
  let datasetVersion: string;
  let artifactStatus: string;
  let releaseStatus: string;
  let releaseSamples: number;
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .select("status, sample_count, dataset_release_id")
      .eq("id", exec.artifactId)
      .limit(2);
    if (error) return { ready: false, reason: "database_error" };
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length !== 1) return { ready: false, reason: "database_error" };
    artifactStatus = String(rows[0]!.status);
    sampleCount = Number(rows[0]!.sample_count ?? 0);

    const { data: rel, error: relError } = await db
      .from("training_dataset_releases")
      .select("version, status, sample_count")
      .eq("id", String(rows[0]!.dataset_release_id))
      .limit(2);
    if (relError) return { ready: false, reason: "database_error" };
    const relRows = (rel ?? []) as Record<string, unknown>[];
    if (relRows.length !== 1) return { ready: false, reason: "database_error" };
    datasetVersion = String(relRows[0]!.version);
    releaseStatus = String(relRows[0]!.status);
    releaseSamples = Number(relRows[0]!.sample_count ?? 0);
  } catch {
    return { ready: false, reason: "database_error" };
  }

  const facts: ReadinessFacts = {
    jobVersion: exec.version,
    datasetVersion,
    sampleCount,
    minimumSamples: TRAINING_READINESS_POLICY.minimumSamples,
    policyVersion: TRAINING_READINESS_POLICY.version,
  };

  /**
   * ★ (٣) العيّنات — والسبب الذي يخصّ البيانات يُقال أوّلًا.
   *
   * فمشرفٌ يقرأ «١ / ١٠٠» يعرف ما ينقصه ويعرف ماذا يفعل. ومن يقرأ رمزًا
   * عن نسخةِ مكتبةٍ لا يعرف أن المسألة أصلًا في عدد ما شارك الناس به.
   */
  if (sampleCount < TRAINING_READINESS_POLICY.minimumSamples) {
    return { ready: false, reason: "insufficient_training_data", facts };
  }

  if (artifactStatus !== "ready") {
    return { ready: false, reason: "artifact_not_ready", facts };
  }
  if (releaseStatus !== "frozen") {
    return { ready: false, reason: "dataset_not_frozen", facts };
  }
  /** والأثر يصف المجموعة نفسها — عددان مختلفان يعنيان أن أحدهما ليس هي */
  if (releaseSamples !== sampleCount) {
    return { ready: false, reason: "sample_count_mismatch", facts };
  }

  /**
   * ★ (٤) والمكدّس مثبَّتٌ **ومُتحقَّقٌ منه**.
   *
   * فنسخٌ موجودة لا تعني نسخًا تعمل معًا. والتحقّق تشغيلةٌ تنجح، لا سطرٌ
   * يُبدَّل — وحتى تقع، لا يُسلَّم شيءٌ إلى مُنفِّذ.
   */
  if (!d.stackPinned() || !d.stackVerified()) {
    return { ready: false, reason: "dependency_stack_unverified", facts };
  }

  return { ready: true, facts };
}
