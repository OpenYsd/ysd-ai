import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { validateDatasetArtifactForTraining } from "./artifact";
import { findBaseModel, isVerifiedRevision } from "./base-models";
import {
  TRAINING_CONFIG_VERSION,
  buildTrainingSpec,
  findTrainingPreset,
  hashTrainingConfig,
  buildCanonicalTrainingConfig,
} from "./job-config";

/**
 * مهامّ التدريب — مواصفةٌ لا تشغيل (v0.9.8، المرحلة 4A).
 *
 * ── ما تنتهي عنده هذه المرحلة ──
 *
 *   مواصفةٌ ثابتة، قابلةٌ لإعادة الإنتاج، جاهزةٌ للتسليم.
 *
 * ولا عتاد، ولا مزوّد، ولا أوزان تُحمَّل، ولا نداءَ شبكةٍ إلى أحد.
 * و«مُجهَّزة» تعني: صالحةٌ لتُسلَّم يومًا. ولا تعني: بدأ تدريب.
 *
 * ── ولا شيء يُصدَّق على حاله ──
 *
 * `artifact.status = 'ready'` لا يكفي، و`job.status = 'prepared'` لا يكفي.
 * فبين إنشاء المواصفة وتجهيزها، وبين تجهيزها وتسليمها، يستطيع صاحب أيّ
 * عيّنةٍ في الأثر أن يسحب إذنه. والحقول المخزَّنة تقول ما كان.
 *
 * فالفحص يُعاد **ثلاث مرّات**: عند الإنشاء، وعند التجهيز، وعند كل نظرٍ في
 * التنفيذ. وكلّها تمرّ من `validateDatasetArtifactForTraining` — لا من
 * نسخةٍ منه.
 */

export type JobFailure =
  | "artifact_not_found"
  | "artifact_invalid"
  | "unknown_base_model"
  | "base_model_unpinned"
  | "unknown_preset"
  | "invalid_config"
  | "job_not_found"
  | "not_draft"
  | "not_prepared"
  | "cancelled"
  | "conflict"
  | "database_error";

export type ExecutionFailure =
  | JobFailure
  | "config_mismatch"
  | "base_model_not_allowed";

export interface JobDependencies {
  getAdminClient: typeof getAdminClient;
  validateArtifact: typeof validateDatasetArtifactForTraining;
}

const DEFAULTS: JobDependencies = {
  getAdminClient,
  validateArtifact: validateDatasetArtifactForTraining,
};

const JOB_COLUMNS =
  "id, version, dataset_artifact_id, base_model_id, base_model_revision, method, " +
  "preset_id, config_version, hyperparameters, seed, status, config_hash, " +
  "created_at, prepared_at, cancelled_at";

export interface JobRow {
  id: string;
  version: string;
  dataset_artifact_id: string;
  base_model_id: string;
  base_model_revision: string | null;
  method: string;
  preset_id: string;
  config_version: string;
  hyperparameters: Record<string, number>;
  seed: number;
  status: string;
  config_hash: string | null;
}

interface ArtifactFacts {
  sha256: string;
  releaseManifestHash: string;
  datasetVersion: string;
  datasetFormatVersion: string;
  sampleCount: number;
}

/**
 * ★ يقرأ ما يلزم المواصفة من الأثر — ولا يقرأ بايتاته.
 *
 * ولا مسار تخزين: المواصفة تشير إلى الأثر بمعرّفه، ومن يبني المُنفِّذ
 * يقرأ المسار من وصف الأثر بعد أن يُجيزه الحارس.
 */
async function readArtifactFacts(
  db: SupabaseClient,
  artifactId: string,
): Promise<ArtifactFacts | null | "error"> {
  try {
    const { data, error } = await db
      .from("training_dataset_artifacts")
      .select(
        "id, artifact_sha256, release_manifest_hash, format_version, sample_count, dataset_release_id",
      )
      .eq("id", artifactId)
      .limit(2);
    if (error) return "error";
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) return "error";
    const row = rows[0]!;

    const { data: rel, error: relError } = await db
      .from("training_dataset_releases")
      .select("version")
      .eq("id", String(row.dataset_release_id))
      .limit(2);
    if (relError) return "error";
    const relRows = (rel ?? []) as { version: string }[];
    if (relRows.length !== 1) return "error";

    if (typeof row.artifact_sha256 !== "string") return null;
    return {
      sha256: row.artifact_sha256,
      releaseManifestHash: String(row.release_manifest_hash),
      datasetVersion: relRows[0]!.version,
      datasetFormatVersion: String(row.format_version),
      sampleCount: Number(row.sample_count ?? 0),
    };
  } catch {
    return "error";
  }
}

export interface DraftJobResult {
  jobId: string;
  version: string;
  baseModelId: string;
  presetId: string;
  datasetVersion: string;
  sampleCount: number;
}

/**
 * ★ يُنشئ مسوَّدة مواصفة — بعد أن يُجيز الحارس الأثر.
 *
 * ولا يقبل من مستدعٍ أرقامًا: يمرّر **اسمين** — نموذجًا أساسيًّا وإعدادًا —
 * والباقي يملكه الخادم. ومن يمرّر `learningRate` يقرّر ما يُحفَّظ وما
 * يُعمَّم، وذلك قرارٌ يمرّ من مراجعةٍ لا من حقل.
 */
export async function createTrainingJobDraft(
  artifactId: string,
  baseModelId: string,
  presetId: string,
  createdBy: string,
  deps: Partial<JobDependencies> = {},
): Promise<
  | { ok: true; draft: DraftJobResult }
  | { ok: false; reason: JobFailure; field?: string; invalid?: Record<string, number> }
> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  /**
   * ★ (١) الأثر يُجاز أوّلًا — و`ready` وحدها لا تُجيز.
   *
   * فالحارس يُعيد التحقّق من الإصدار بكلّ عيّناته: إذنٌ مسحوب، أو مصدرٌ
   * عُدِّل، أو مرشّحٌ رُفض بعد التجميد — كلّها تردّ قبل أن تُكتب مواصفة.
   */
  const gate = await d.validateArtifact(artifactId);
  if (!gate.ok) {
    return { ok: false, reason: "artifact_invalid", invalid: gate.invalid };
  }

  const facts = await readArtifactFacts(db, artifactId);
  if (facts === "error") return { ok: false, reason: "database_error" };
  if (facts === null) return { ok: false, reason: "artifact_not_found" };

  const spec = buildTrainingSpec({
    artifactSha256: facts.sha256,
    releaseManifestHash: facts.releaseManifestHash,
    datasetVersion: facts.datasetVersion,
    datasetFormatVersion: facts.datasetFormatVersion,
    sampleCount: facts.sampleCount,
    baseModelId,
    presetId,
  });
  if (!spec.ok) {
    const reason: JobFailure =
      spec.reason === "unknown_base_model"
        ? "unknown_base_model"
        : spec.reason === "base_model_unpinned"
          ? "base_model_unpinned"
          : spec.reason === "unknown_preset"
            ? "unknown_preset"
            : "invalid_config";
    return { ok: false, reason, field: spec.field };
  }

  try {
    const { data, error } = await db
      .from("training_jobs")
      /**
       * ولا `version` ولا `status` ولا `config_hash` هنا: الرقم من تسلسل
       * القاعدة، والحالة `draft` بالافتراض، والبصمة تُحسب عند التجهيز —
       * فمواصفةٌ لم تُجهَّز لا بصمة لها.
       */
      .insert({
        dataset_artifact_id: artifactId,
        base_model_id: spec.base.id,
        base_model_revision: spec.revision,
        method: spec.preset.method,
        preset_id: spec.preset.id,
        config_version: TRAINING_CONFIG_VERSION,
        hyperparameters: spec.preset.hyperparameters,
        seed: spec.preset.seed,
        created_by: createdBy,
      })
      .select("id, version")
      .limit(1);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { id: string; version: string }[];
    if (rows.length !== 1) return { ok: false, reason: "database_error" };
    return {
      ok: true,
      draft: {
        jobId: rows[0]!.id,
        version: rows[0]!.version,
        baseModelId: spec.base.id,
        presetId: spec.preset.id,
        datasetVersion: facts.datasetVersion,
        sampleCount: facts.sampleCount,
      },
    };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

async function readJob(db: SupabaseClient, jobId: string): Promise<JobRow | null | "error"> {
  try {
    const { data, error } = await db
      .from("training_jobs")
      .select(JOB_COLUMNS)
      .eq("id", jobId)
      .limit(2);
    if (error) return "error";
    const rows = (data ?? []) as unknown as JobRow[];
    if (rows.length === 0) return null;
    if (rows.length !== 1) return "error";
    return rows[0]!;
  } catch {
    return "error";
  }
}

/**
 * ★ يُجهّز مسوَّدة — بإعادة إجازةٍ للأثر، وحسابٍ جديدٍ للبصمة.
 *
 * ── ولماذا يُعاد الفحص هنا ──
 *
 * المسوَّدة تُنشأ في لحظة والتجهيز يقع في أخرى. وبينهما دقائق أو أيّام،
 * يستطيع فيها صاحب عيّنةٍ أن يسحب إذنه. ولو جُهِّزت بما فُحص سابقًا لَحملت
 * البصمةُ شهادةً على أثرٍ لم يعد يُقرأ.
 */
export async function prepareTrainingJob(
  jobId: string,
  deps: Partial<JobDependencies> = {},
): Promise<
  | { ok: true; version: string; configHash: string }
  | { ok: false; reason: JobFailure; invalid?: Record<string, number> }
> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const job = await readJob(db, jobId);
  if (job === "error") return { ok: false, reason: "database_error" };
  if (job === null) return { ok: false, reason: "job_not_found" };
  if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (job.status !== "draft") return { ok: false, reason: "not_draft" };

  const gate = await d.validateArtifact(job.dataset_artifact_id);
  if (!gate.ok) return { ok: false, reason: "artifact_invalid", invalid: gate.invalid };

  const facts = await readArtifactFacts(db, job.dataset_artifact_id);
  if (facts === "error") return { ok: false, reason: "database_error" };
  if (facts === null) return { ok: false, reason: "artifact_not_found" };

  const spec = buildTrainingSpec({
    artifactSha256: facts.sha256,
    releaseManifestHash: facts.releaseManifestHash,
    datasetVersion: facts.datasetVersion,
    datasetFormatVersion: facts.datasetFormatVersion,
    sampleCount: facts.sampleCount,
    baseModelId: job.base_model_id,
    presetId: job.preset_id,
  });
  if (!spec.ok) return { ok: false, reason: "invalid_config" };

  /**
   * ★ والكتابة مشروطةٌ بأن الحالة ما تزال `draft`.
   *
   * فتجهيزان متزامنان: أوّلهما يصيب صفًّا، والثاني يصيب صفرًا فيقرأ
   * `conflict`. والشرط جزءٌ من الكتابة لا قراءةٌ تسبقها.
   */
  try {
    const { data, error } = await db
      .from("training_jobs")
      .update({
        status: "prepared",
        config_hash: spec.configHash,
        prepared_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("status", "draft")
      .select("id, version, config_hash");
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { version: string; config_hash: string }[];
    if (rows.length === 0) return { ok: false, reason: "conflict" };
    return { ok: true, version: rows[0]!.version, configHash: spec.configHash };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

/**
 * ★ الإلغاء — يقول إن المواصفة لن تُسلَّم، ولا يمحو أنها كانت.
 *
 * ويجوز على المسوَّدة والمُجهَّزة كلتيهما: لا تنفيذ في هذه المرحلة، فلا
 * شيء يُوقَف — إنما يُعلَن القرار. والصفّ يبقى: من يحذف مهمّةً يمحو سجلَّ
 * أنها بُنيت يومًا على بيانات أناس.
 */
export async function cancelTrainingJob(
  jobId: string,
  deps: Partial<JobDependencies> = {},
): Promise<{ ok: true; version: string } | { ok: false; reason: JobFailure }> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  try {
    const { data, error } = await db
      .from("training_jobs")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", jobId)
      .in("status", ["draft", "prepared"])
      .select("id, version");
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { version: string }[];
    if (rows.length === 0) return { ok: false, reason: "conflict" };
    return { ok: true, version: rows[0]!.version };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

export type ExecutionVerdict =
  | { ok: true; jobId: string; version: string; configHash: string; artifactId: string }
  | { ok: false; reason: ExecutionFailure; invalid?: Record<string, number> };

/**
 * ★ الحارس الذي يقول «يجوز أن تُسلَّم هذه المواصفة إلى مُنفِّذ».
 *
 * ── ولا يقوله شيءٌ غيره ──
 *
 * لا `status = 'prepared'` وحدها: هي تقول إن المواصفة ثبتت، لا إن الإذن
 * قائم. ولا وجودُ ملفّ الأثر: بايتاتٌ لا تعلم بما جرى بعد كتابتها.
 *
 * ── وما يُفحص ──
 *
 *   ١ الحالة `prepared` — لا مسوَّدة ولا ملغاة.
 *   ٢ والأثر يُجاز من جديد    ← وهو يُعيد التحقّق من الإصدار بعيّناته
 *   ٣ والبصمة تُعاد وتُطابَق  ← فمواصفةٌ عُبث بها ليست هي
 *   ٤ والنموذج الأساسيّ ما يزال مسموحًا
 *   ٥ وهوّية أوزانه مثبَّتة
 *
 * والخامس يمنع التنفيذ اليوم عمدًا: لا يملك المشروع مراجعةً ثابتة لأيّ
 * نموذج، فما سيُنزَّل قد لا يكون ما وُصف. وتثبيتُها شرطُ المرحلة 4B.
 *
 *   ★ وكل مُنفِّذٍ مستقبليّ **يجب** أن يستدعي هذه قبل أن يبدأ شيئًا.
 */
export async function validateTrainingJobForExecution(
  jobId: string,
  deps: Partial<JobDependencies> = {},
): Promise<ExecutionVerdict> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  const job = await readJob(db, jobId);
  if (job === "error") return { ok: false, reason: "database_error" };
  if (job === null) return { ok: false, reason: "job_not_found" };
  if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (job.status !== "prepared") return { ok: false, reason: "not_prepared" };
  if (typeof job.config_hash !== "string") return { ok: false, reason: "not_prepared" };

  const gate = await d.validateArtifact(job.dataset_artifact_id);
  if (!gate.ok) return { ok: false, reason: "artifact_invalid", invalid: gate.invalid };

  const facts = await readArtifactFacts(db, job.dataset_artifact_id);
  if (facts === "error") return { ok: false, reason: "database_error" };
  if (facts === null) return { ok: false, reason: "artifact_not_found" };

  const base = findBaseModel(job.base_model_id);
  if (!base) return { ok: false, reason: "base_model_not_allowed" };

  const preset = findTrainingPreset(job.preset_id);
  if (!preset) return { ok: false, reason: "unknown_preset" };

  /**
   * ★ والبصمة تُعاد على **ما هو مخزَّن في المهمّة** لا على الإعداد الحاليّ.
   *
   * فلو تغيّر إعدادٌ في الشيفرة بعد التجهيز، وجب أن يُكشف ذلك لا أن يُبتلع:
   * المواصفة وُقّعت على أرقامٍ بعينها، وأرقامٌ أخرى مواصفةٌ أخرى.
   */
  const canonical = buildCanonicalTrainingConfig(
    {
      artifactSha256: facts.sha256,
      releaseManifestHash: facts.releaseManifestHash,
      datasetVersion: facts.datasetVersion,
      datasetFormatVersion: facts.datasetFormatVersion,
      sampleCount: facts.sampleCount,
      baseModelId: job.base_model_id,
      presetId: job.preset_id,
    },
    base,
    {
      id: job.preset_id,
      method: preset.method,
      seed: job.seed,
      hyperparameters: job.hyperparameters as never,
    },
    job.base_model_revision,
  );
  if (hashTrainingConfig(canonical) !== job.config_hash) {
    return { ok: false, reason: "config_mismatch" };
  }

  /**
   * ★ والفحص على مراجعة **المهمّة** لا على الفهرس.
   *
   * ── ولماذا لا تُشترط مساواةُ الفهرس ──
   *
   * لأن الفهرس يتقدّم: مهمّةٌ بُنيت على مراجعةٍ تحقّقنا منها تبقى صحيحةً
   * تاريخيًّا وإن صارت المراجعة الافتراضية غيرها. واشتراطُ المساواة يقتل
   * كل مهمّةٍ قديمة مع أوّل تحديث.
   *
   * ── ولا يكفي الشكل ──
   *
   * أربعون خانةً يكتبها أحدٌ تُشبه التزامة ولا تكون واحدة. فالشرط أن تكون
   * في قائمة ما رأيناه في المستودع الرسميّ.
   */
  if (!isVerifiedRevision(base, job.base_model_revision)) {
    return { ok: false, reason: "base_model_unpinned" };
  }

  return {
    ok: true,
    jobId: job.id,
    version: job.version,
    configHash: job.config_hash,
    artifactId: job.dataset_artifact_id,
  };
}
