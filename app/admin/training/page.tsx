import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { getAdminClient } from "@/lib/supabase/admin";
import { countTrainingCandidates } from "@/lib/training/decision";
import type { DatasetRelease } from "@/components/admin/training-datasets-section";
import {
  TrainingJobsSection,
  type ArtifactChoice,
  type TrainingJobRow,
} from "@/components/admin/training-jobs-section";
import { describeBaseModel, listBaseModels } from "@/lib/training/base-models";
import { listTrainingPresets } from "@/lib/training/job-config";
import { validateTrainingReadiness } from "@/lib/training/readiness";
import {
  TrainingReviewView,
  type CandidateSummary,
} from "@/components/admin/training-review-view";

export const dynamic = "force-dynamic";

/**
 * بنك تحسين YSD — المراجعة اليدوية (v0.9.5، المرحلة 2B).
 *
 * ── لماذا تُقرأ الصفوف بعميل الخدمة ──
 *
 * لأن `training_candidates` مسحوبةُ الامتيازات من `authenticated`: سياسة
 * القراءة للمشرف قائمة، لكن الدور نفسه لا يملك `select`. فالقراءة عبر
 * `service_role` هي الطريق الوحيد — بعد أن يكون `getAdminContext` قد أثبت
 * الصلاحية بجلسةٍ حقيقية.
 *
 * وترتيب السطرين ليس تفصيلًا: لا يُطلب عميل الخدمة قبل إثبات الصلاحية.
 */

const LIST_COLUMNS = "id, created_at, status, privacy_status, quality_status, source";
/** ★ ولا `manifest_hash` ولا `manifest` ولا `created_by` — لا تُفيد قارئًا */
const RELEASE_COLUMNS = "id, version, status, sample_count, created_at, frozen_at";
/** ★ ولا `storage_path` ولا `artifact_sha256`: الأوّل يقول أين يقع كلام
 *  الناس، والثاني لا يقول لقارئٍ شيئًا. */
const ARTIFACT_COLUMNS = "dataset_release_id, status, sample_count, byte_size";
/** ★ ولا `config_hash` ولا مسار: قرارٌ يُعرض، لا بصمةٌ ولا مكان */
const JOB_COLUMNS =
  "id, version, status, dataset_artifact_id, base_model_id, method, preset_id, seed, " +
  "created_at, prepared_at";
const PAGE_SIZE = 50;

export default async function AdminTrainingPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");

  let counts: Record<string, number> = {};
  let pending: CandidateSummary[] = [];
  let releases: DatasetRelease[] = [];
  let jobs: TrainingJobRow[] = [];
  let artifactChoices: ArtifactChoice[] = [];

  try {
    const counted = await countTrainingCandidates();
    if (counted) counts = counted;

    const db = getAdminClient();
    if (db) {
      const { data } = await db
        .from("training_candidates")
        .select(LIST_COLUMNS)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(PAGE_SIZE);
      pending = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        createdAt: String(r.created_at),
        status: String(r.status),
        privacyStatus: String(r.privacy_status),
        qualityStatus: String(r.quality_status),
        source: String(r.source),
      }));

      const { data: rel } = await db
        .from("training_dataset_releases")
        .select(RELEASE_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);
      releases = ((rel ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        version: String(r.version),
        status: String(r.status),
        sampleCount: Number(r.sample_count ?? 0),
        createdAt: String(r.created_at),
        frozenAt: r.frozen_at === null || r.frozen_at === undefined ? null : String(r.frozen_at),
      }));

      const { data: arts } = await db
        .from("training_dataset_artifacts")
        .select(ARTIFACT_COLUMNS)
        .neq("status", "purged")
        .limit(PAGE_SIZE);
      const byRelease = new Map<string, Record<string, unknown>>();
      for (const a of (arts ?? []) as Record<string, unknown>[]) {
        byRelease.set(String(a.dataset_release_id), a);
      }
      releases = releases.map((r) => {
        const a = byRelease.get(r.id);
        if (!a) return r;
        return {
          ...r,
          artifactStatus: String(a.status),
          artifactSampleCount: Number(a.sample_count ?? 0),
          artifactByteSize: a.byte_size === null || a.byte_size === undefined
            ? null : Number(a.byte_size),
        };
      });

      /**
       * ★ والآثار الجاهزة وحدها تصلح مصدرًا لمواصفة.
       *
       * والخادم يُعيد إجازتها عند الإنشاء على كل حال — وهذا يمنع عرض
       * خيارٍ يُردّ بعد ضغطة.
       */
      const { data: readyArts } = await db
        .from("training_dataset_artifacts")
        .select("id, dataset_release_id, sample_count")
        .eq("status", "ready")
        .limit(PAGE_SIZE);
      const versionOf = new Map(releases.map((r) => [r.id, r.version]));
      artifactChoices = ((readyArts ?? []) as Record<string, unknown>[]).map((a) => ({
        artifactId: String(a.id),
        datasetVersion: versionOf.get(String(a.dataset_release_id)) ?? "—",
        sampleCount: Number(a.sample_count ?? 0),
      }));

      const { data: jobRows } = await db
        .from("training_jobs")
        .select(JOB_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);
      const releaseOfArtifact = new Map(
        ((readyArts ?? []) as Record<string, unknown>[]).map((a) => [
          String(a.id),
          { version: versionOf.get(String(a.dataset_release_id)) ?? null,
            samples: Number(a.sample_count ?? 0) },
        ]),
      );
      jobs = ((jobRows ?? []) as unknown as Record<string, unknown>[]).map((j) => {
        const src = releaseOfArtifact.get(String(j.dataset_artifact_id));
        return {
          id: String(j.id),
          version: String(j.version),
          status: String(j.status),
          baseModelId: String(j.base_model_id),
          presetId: String(j.preset_id),
          method: String(j.method),
          seed: Number(j.seed ?? 0),
          datasetVersion: src?.version ?? null,
          sampleCount: src?.samples ?? null,
          createdAt: String(j.created_at),
          preparedAt: j.prepared_at === null || j.prepared_at === undefined
            ? null : String(j.prepared_at),
        };
      });

      /**
       * ★ الجاهزية تُحسب في الخادم — للمُجهَّزة وحدها.
       *
       * ولا تُحسب في المتصفّح: الحدّ سياسةٌ يملكها الخادم، وحسابُه هناك
       * يجعله رقمًا يبدّله من يفتح الأدوات فيرى «جاهزة».
       *
       * وللمُجهَّزة وحدها: مسوَّدةٌ لم تُجهَّز لا معنى لسؤالها، وكل نداءٍ
       * يقرأ الأثر والمجموعة ويُعيد فحص العيّنات.
       */
      jobs = await Promise.all(
        jobs.map(async (j) => {
          if (j.status !== "prepared") return j;
          const verdict = await validateTrainingReadiness(j.id);
          return {
            ...j,
            readyForExecution: verdict.ready,
            readinessReason: verdict.ready ? null : verdict.reason,
            sampleCount2: verdict.facts?.sampleCount ?? null,
            minimumSamples: verdict.facts?.minimumSamples ?? null,
          };
        }),
      );
    }
  } catch {
    /* لوحةٌ فارغة خيرٌ من صفحةٍ ساقطة — والأعداد تبقى أصفارًا */
  }

  return (
    <>
      <TrainingReviewView counts={counts} pending={pending} releases={releases} />
      <div className="px-4 md:px-6 pb-5">
        <TrainingJobsSection
          jobs={jobs}
          artifacts={artifactChoices}
          baseModels={listBaseModels().map(describeBaseModel)}
          presets={listTrainingPresets().map((p) => p.id)}
        />
      </div>
    </>
  );
}
