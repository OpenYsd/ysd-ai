import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { getAdminClient } from "@/lib/supabase/admin";
import { countTrainingCandidates } from "@/lib/training/decision";
import type { DatasetRelease } from "@/components/admin/training-datasets-section";
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
const PAGE_SIZE = 50;

export default async function AdminTrainingPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");

  let counts: Record<string, number> = {};
  let pending: CandidateSummary[] = [];
  let releases: DatasetRelease[] = [];

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
    }
  } catch {
    /* لوحةٌ فارغة خيرٌ من صفحةٍ ساقطة — والأعداد تبقى أصفارًا */
  }

  return <TrainingReviewView counts={counts} pending={pending} releases={releases} />;
}
