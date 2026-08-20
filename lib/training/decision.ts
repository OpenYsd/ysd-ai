import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { readTrainingConsent } from "./consent";
import { revalidateTrainingCandidate, type RevalidationFailure } from "./revalidate";

/**
 * قرار المراجعة على مرشّح تدريب (v0.9.5، المرحلة 2B).
 *
 * ── القرار يُعاد التحقّق منه، لا يُبنى على شاشةٍ فُتحت ──
 *
 * بين فتح المراجِع للعيّنة وضغطه الزرَّ دقائق. وفيها يستطيع صاحبها أن
 * يسحب إذنه، أو يعدّل رسالته، أو يحذفها. فالشاشةُ التي أمامه صارت وصفًا
 * لماضٍ، وقرارُه عليها قرارٌ على ما لم يعد قائمًا.
 *
 * ولذلك يُعاد الفحص كاملًا **داخل** طلب القرار. والفتح فحصٌ للعرض لا
 * للإذن — من فحص عند الفتح وحده حرس اللحظة الخطأ.
 *
 * ── والاعتماد لا ينقض حكمًا حتميًّا ──
 *
 * المراجعة اليدوية تُضيف حكمًا حيث لا يملك الفحص حكمًا. وحيث يملكه —
 * بريدٌ أو مفتاحٌ أو ردٌّ مقطوع — فلا تجاوز.
 */

export type Decision = "approve" | "reject_privacy" | "reject_quality";

export type DecisionFailure =
  | RevalidationFailure
  | "privacy_blocked"
  | "quality_blocked"
  | "conflict";

export type DecisionResult =
  | { ok: true; status: string; decidedAt: string }
  | { ok: false; reason: DecisionFailure };

export interface DecisionDependencies {
  getAdminClient: typeof getAdminClient;
  revalidate: typeof revalidateTrainingCandidate;
  readConsent: typeof readTrainingConsent;
}

const DEFAULTS: DecisionDependencies = {
  getAdminClient,
  revalidate: revalidateTrainingCandidate,
  readConsent: readTrainingConsent,
};

/**
 * ★ يطبّق قرارًا — والحقول كلّها من الخادم.
 *
 * لا يقبل `status` ولا `privacy_status` ولا `quality_status` ولا
 * `decided_at` من أحد. المراجِع يختار **أيّ** قرار، لا **ماذا يُكتب**.
 */
export async function decideTrainingCandidate(
  candidateId: string,
  decision: Decision,
  deps: Partial<DecisionDependencies> = {},
): Promise<DecisionResult> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  /**
   * ★ (١) الفحص كاملًا الآن — و`requirePending` يجعل المحسوم يُردّ مبكرًا.
   *
   * وهذا لا يُغني عن الشرط عند الكتابة أدناه: بين هذه القراءة وتلك الكتابة
   * نافذةٌ يمرّ منها مراجِعٌ آخر. القراءةُ تعطي رسالةً مفهومة، والكتابةُ
   * وحدها هي التي تحسم.
   */
  const check = await d.revalidate(candidateId, { requirePending: true });
  if (!check.ok) return { ok: false, reason: check.reason };

  const now = new Date().toISOString();
  let update: Record<string, unknown>;

  if (decision === "approve") {
    /**
     * ★ ولا اعتماد فوق مانعٍ حتميّ.
     *
     * والقاعدة تحرس هذا كذلك: `status='approved'` يشترط `privacy_status`
     * و`quality_status` كليهما `passed` مع `decided_at`. فحتى لو سقط هذا
     * السطر يومًا، لا يمرّ صفٌّ معتمَدٌ ببوّابةٍ مغلقة.
     */
    if (check.blockers.includes("privacy_finding")) {
      return { ok: false, reason: "privacy_blocked" };
    }
    if (check.blockers.includes("quality_rejected")) {
      return { ok: false, reason: "quality_blocked" };
    }
    /**
     * ★ و`privacy_status: "passed"` هنا **حكمُ إنسان** لا نتيجةُ فحص.
     *
     * `screenPrivacy` لا تمنح `passed` أبدًا — تقول «لم أجد ما أرفضه، ولم
     * أطمئنّ». والذي يطمئنّ هو من قرأ. فتُكتب `passed` لحظة قراءته، لا
     * قبلها، ولا بأثرٍ من فحصٍ آليّ.
     */
    update = {
      status: "approved",
      privacy_status: "passed",
      quality_status: "passed",
      decided_at: now,
      updated_at: now,
    };
  } else if (decision === "reject_privacy") {
    update = {
      status: "rejected_privacy",
      privacy_status: "rejected",
      decided_at: now,
      updated_at: now,
    };
  } else {
    update = {
      status: "rejected_quality",
      quality_status: "rejected",
      decided_at: now,
      updated_at: now,
    };
  }

  /**
   * ★ (٢) الكتابة مشروطةٌ بأن الحالة **ما تزال** `pending`.
   *
   * فمراجِعان فتحا العيّنة نفسها: أوّلُ من يكتب يطابق الشرط فيصيب صفًّا،
   * والثاني لا يطابق فيصيب صفرًا — لا لأننا فحصنا قبله، بل لأن الشرط
   * جزءٌ من الكتابة نفسها. وهذا `compare-and-set` بلا معاملةٍ ولا قفل.
   *
   * وقراءةُ الحالة ثم الكتابة كانت ستترك بينهما نافذةً يفوز فيها الاثنان.
   */
  try {
    const { data, error } = await db
      .from("training_candidates")
      .update(update)
      .eq("id", candidateId)
      .eq("status", "pending")
      .select("id, status, decided_at");
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as { id: string; status: string; decided_at: string | null }[];
    if (rows.length === 0) return { ok: false, reason: "conflict" };
    const row = rows[0]!;
    return { ok: true, status: row.status, decidedAt: row.decided_at ?? now };
  } catch {
    return { ok: false, reason: "database_error" };
  }
}

/** أعدادٌ لكل حالة — لا صفوف ولا نصوص */
export async function countTrainingCandidates(
  deps: Partial<DecisionDependencies> = {},
): Promise<Record<string, number> | null> {
  const d = { ...DEFAULTS, ...deps };
  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return null;
  }
  if (!db) return null;

  try {
    const { data, error } = await db.from("training_candidates").select("status").limit(10_000);
    if (error) return null;
    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as { status: string }[]) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  } catch {
    return null;
  }
}
