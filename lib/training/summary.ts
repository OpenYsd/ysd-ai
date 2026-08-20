import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { TRAINING_READINESS_POLICY } from "./readiness";

/**
 * ملخّص جمع بيانات التدريب (v0.9.11، المرحلة 5A) — **أعدادٌ لا محتوى**.
 *
 * ── ما يجيب عنه ──
 *
 * «أين نحن من الحدّ؟» و«ما الذي ينتظر مراجعة؟» و«هل ما جُمع متنوّعٌ بما
 * يكفي؟». وكلّها أسئلةُ تشغيلٍ تُجاب بعدّ، لا بقراءة كلامِ أحد.
 *
 * ── وما لا يُقرأ هنا ──
 *
 * لا نصّ عيّنة، ولا هوّيةُ صاحبها، ولا عنوانُ محادثة، ولا بصمة. والاستعلام
 * لا يطلب `content` أصلًا — فما لا يُقرأ لا يُسرَّب.
 *
 * ── والحدّ من السياسة لا من هنا ──
 *
 * `minimumSamples` يُستورَد من `TRAINING_READINESS_POLICY`. ولو كُتب رقمٌ
 * هنا لصار للنظام حدّان: واحدٌ يمنع التنفيذ وآخر يُعرض للمشرف — ويومَ
 * يتغيّر أحدهما يقرأ المشرف تقدُّمًا لا يوافق ما يمنعه الحارس.
 */

export interface TrainingSummary {
  total: number;
  approved: number;
  pending: number;
  rejectedQuality: number;
  rejectedPrivacy: number;
  rejectedDuplicate: number;
  revoked: number;

  approvedLast7Days: number;
  approvedLast30Days: number;

  minimumSamples: number;
  remaining: number;
  thresholdReached: boolean;
  readinessPolicy: string;

  /**
   * ★ تنبيهاتٌ استشاريّة — لا تمنع شيئًا.
   *
   * غرضُها أن يرى المشرف تركّزًا قد يُفسد طيّارًا: مئة عيّنةٍ من محادثتين
   * ليست مئةَ عيّنة في المعنى الذي يهمّ. وهي **لا ترفض** ولا تحجب، لأن
   * الرفض حكمٌ يحتاج قراءةً — وهذه أعدادٌ لا تقرأ.
   */
  distinctConversations: number;
  distinctContributors: number;
  warnings: readonly string[];
}

export interface SummaryDependencies {
  getAdminClient: typeof getAdminClient;
  now: () => number;
}

const DEFAULTS: SummaryDependencies = { getAdminClient, now: () => Date.now() };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 20_000;

/**
 * ★ حدُّ تركُّزٍ استشاريّ.
 *
 * إن جاء أكثر من ثلثي المعتمَد من محادثةٍ واحدة في المتوسّط، فالتنوّع
 * مشكوكٌ فيه. والرقم تقديريّ ولا يمنع — وسمّيتُه «تنبيهًا» لا «حدًّا»
 * لأنه كذلك.
 */
const CONCENTRATION_RATIO = 3;

interface CandidateRow {
  status: string;
  decided_at: string | null;
  conversation_id: string;
  user_id: string;
}

/**
 * ★ يجمع الأعداد — ولا يقرأ حرفًا من عيّنة.
 *
 * والمعرّفات تُقرأ لتُعدّ **مميَّزةً** ثم تُطرَح: تدخل `Set` وتخرج منها
 * عددًا. ولا يصل واحدٌ منها إلى متصفّح ولا إلى جواب.
 */
export async function buildTrainingSummary(
  deps: Partial<SummaryDependencies> = {},
): Promise<TrainingSummary | null> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return null;
  }
  if (!db) return null;

  let rows: CandidateRow[];
  try {
    const { data, error } = await db
      .from("training_candidates")
      /** ★ ولا `content` ولا بصمة — ما لا يُطلب لا يُقرأ */
      .select("status, decided_at, conversation_id, user_id")
      .limit(MAX_ROWS);
    if (error) return null;
    rows = (data ?? []) as CandidateRow[];
  } catch {
    return null;
  }

  const by: Record<string, number> = {};
  const conversations = new Set<string>();
  const contributors = new Set<string>();
  let approvedLast7Days = 0;
  let approvedLast30Days = 0;

  const now = d.now();
  for (const row of rows) {
    by[row.status] = (by[row.status] ?? 0) + 1;
    if (row.status !== "approved") continue;

    conversations.add(row.conversation_id);
    contributors.add(row.user_id);

    /**
     * ★ ويُقاس بوقت **القرار** لا بوقت الإنشاء.
     *
     * فالسؤال «كم اعتُمد هذا الأسبوع؟» سؤالٌ عن عمل المراجعة، لا عن متى
     * شارك الناس. وعيّنةٌ شُوركت قبل شهرٍ واعتُمدت أمس عملُ أمس.
     */
    if (row.decided_at === null) continue;
    const decided = Date.parse(row.decided_at);
    if (Number.isNaN(decided)) continue;
    if (now - decided <= 7 * DAY_MS) approvedLast7Days += 1;
    if (now - decided <= 30 * DAY_MS) approvedLast30Days += 1;
  }

  const approved = by.approved ?? 0;
  const minimumSamples = TRAINING_READINESS_POLICY.minimumSamples;

  const warnings: string[] = [];
  if (approved > 0 && conversations.size > 0) {
    if (approved >= conversations.size * CONCENTRATION_RATIO) {
      warnings.push("concentrated_conversations");
    }
  }
  if (approved >= 10 && contributors.size === 1) {
    warnings.push("single_contributor");
  }

  return {
    total: rows.length,
    approved,
    pending: by.pending ?? 0,
    rejectedQuality: by.rejected_quality ?? 0,
    rejectedPrivacy: by.rejected_privacy ?? 0,
    rejectedDuplicate: by.rejected_duplicate ?? 0,
    revoked: by.revoked ?? 0,
    approvedLast7Days,
    approvedLast30Days,
    minimumSamples,
    remaining: Math.max(0, minimumSamples - approved),
    thresholdReached: approved >= minimumSamples,
    readinessPolicy: TRAINING_READINESS_POLICY.version,
    distinctConversations: conversations.size,
    distinctContributors: contributors.size,
    warnings,
  };
}
