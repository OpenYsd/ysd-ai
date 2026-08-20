import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { getAdminClient } from "@/lib/supabase/admin";
import { countTrainingCandidates } from "@/lib/training/decision";
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
const PAGE_SIZE = 50;

export default async function AdminTrainingPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");

  let counts: Record<string, number> = {};
  let pending: CandidateSummary[] = [];

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
    }
  } catch {
    /* لوحةٌ فارغة خيرٌ من صفحةٍ ساقطة — والأعداد تبقى أصفارًا */
  }

  return <TrainingReviewView counts={counts} pending={pending} />;
}
