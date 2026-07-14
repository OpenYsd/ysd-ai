/**
 * طبقة وظائف RAG — PostgreSQL مصدر الحقيقة الوحيد للحالة والأقفال والمحاولات.
 * الذاكرة لا تُستخدم كطابور؛ فقط جدول rag_jobs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type RagJobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export interface RagJob {
  id: string;
  user_id: string;
  file_id: string;
  job_type: string;
  status: RagJobStatus;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_by: string | null;
  heartbeat_at: string | null;
  progress_current: number;
  progress_total: number;
  progress_percent: number;
  error_code: string | null;
  error_message: string | null;
  correlation_id: string;
  metadata: Record<string, unknown>;
}

export const JOB_FIELDS =
  "id, user_id, file_id, job_type, status, idempotency_key, attempts, max_attempts, available_at, locked_by, heartbeat_at, progress_current, progress_total, progress_percent, error_code, error_message, correlation_id, metadata";

const ACTIVE: RagJobStatus[] = ["queued", "running", "retrying"];

/** تصنيف الأخطاء — يحدد إعادة المحاولة */
export type ErrorClass = "transient" | "permanent" | "cancelled";

/** backoff أُسّي (ثوانٍ) مع سقف */
export function backoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

/**
 * إدراج وظيفة (idempotent): إن وُجدت وظيفة نشطة لنفس (الملف, النوع) تُعاد،
 * وإن وُجدت وظيفة مكتملة لنفس المحتوى (idempotency_key) تُعاد أيضًا.
 */
export async function enqueueRagJob(
  supabase: SupabaseClient,
  params: {
    userId: string;
    fileId: string;
    contentHash: string;
    jobType?: string;
    maxAttempts?: number;
  },
): Promise<{ job: RagJob; created: boolean } | { error: string }> {
  const jobType = params.jobType ?? "rag_prepare";
  const idempotencyKey = `${params.fileId}:${params.contentHash}:${jobType}`;

  // وظيفة نشطة قائمة؟
  const { data: active } = await supabase
    .from("rag_jobs")
    .select(JOB_FIELDS)
    .eq("file_id", params.fileId)
    .eq("job_type", jobType)
    .in("status", ACTIVE)
    .maybeSingle();
  if (active) return { job: active as RagJob, created: false };

  // مكتملة لنفس المحتوى؟ (لا تكرار عمل بلا تغيير)
  const { data: done } = await supabase
    .from("rag_jobs")
    .select(JOB_FIELDS)
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "completed")
    .maybeSingle();
  if (done) return { job: done as RagJob, created: false };

  const { data, error } = await supabase
    .from("rag_jobs")
    .insert({
      user_id: params.userId,
      file_id: params.fileId,
      job_type: jobType,
      idempotency_key: idempotencyKey,
      max_attempts: params.maxAttempts ?? 4,
      status: "queued",
    })
    .select(JOB_FIELDS)
    .single();

  if (error) {
    // سباق: فهرس فريد جزئي رفض الإدراج — أعد قراءة الوظيفة النشطة
    const { data: raced } = await supabase
      .from("rag_jobs")
      .select(JOB_FIELDS)
      .eq("file_id", params.fileId)
      .eq("job_type", jobType)
      .in("status", ACTIVE)
      .maybeSingle();
    if (raced) return { job: raced as RagJob, created: false };
    return { error: "تعذّر إنشاء وظيفة التجهيز." };
  }
  return { job: data as RagJob, created: true };
}

/** التقاط ذري لوظيفة عبر RPC (FOR UPDATE SKIP LOCKED) */
export async function claimRagJob(
  supabase: SupabaseClient,
  workerId: string,
  leaseSeconds = 120,
): Promise<RagJob | null> {
  const { data, error } = await supabase.rpc("claim_rag_job", {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    console.error(`[rag-jobs] claim failed: code=${error.code}`);
    return null;
  }
  const rows = (data ?? []) as RagJob[];
  return rows[0] ?? null;
}

/** نبضة + تقدم — بشرط ملكية القفل */
export async function heartbeatRagJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  progress: { current: number; total: number },
): Promise<boolean> {
  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;
  const { data, error } = await supabase
    .from("rag_jobs")
    .update({
      heartbeat_at: new Date().toISOString(),
      progress_current: progress.current,
      progress_total: progress.total,
      progress_percent: percent,
    })
    .eq("id", jobId)
    .eq("locked_by", workerId)
    .in("status", ["running"])
    .select("id")
    .maybeSingle();
  if (error) return false;
  // لا صف مُحدَّث ⇒ فقدنا القفل (أُلغيت أو أعيد التقاطها) → أوقف العمل
  return Boolean(data);
}

/** هل ما زلنا نملك القفل؟ (يُستخدم لكشف الإلغاء/الحذف أثناء العمل) */
export async function stillOwnsJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("rag_jobs")
    .select("status, locked_by")
    .eq("id", jobId)
    .maybeSingle();
  return Boolean(data && data.status === "running" && data.locked_by === workerId);
}

export async function completeRagJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  total: number,
): Promise<void> {
  await supabase
    .from("rag_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      progress_current: total,
      progress_total: total,
      progress_percent: 100,
      error_code: null,
      error_message: null,
    })
    .eq("id", jobId)
    .eq("locked_by", workerId);
}

/**
 * فشل وظيفة: transient → retrying مع backoff ما لم تُستنفد المحاولات؛
 * permanent/استنفاد → failed. رسالة آمنة فقط.
 */
export async function failRagJob(
  supabase: SupabaseClient,
  job: RagJob,
  workerId: string,
  errorClass: ErrorClass,
  errorCode: string,
  safeMessage: string,
): Promise<void> {
  const canRetry = errorClass === "transient" && job.attempts < job.max_attempts;
  if (canRetry) {
    const delay = backoffSeconds(job.attempts);
    await supabase
      .from("rag_jobs")
      .update({
        status: "retrying",
        locked_by: null,
        locked_at: null,
        available_at: new Date(Date.now() + delay * 1000).toISOString(),
        error_code: errorCode,
        error_message: safeMessage,
      })
      .eq("id", job.id)
      .eq("locked_by", workerId);
    return;
  }
  await supabase
    .from("rag_jobs")
    .update({
      status: errorClass === "cancelled" ? "cancelled" : "failed",
      locked_by: null,
      locked_at: null,
      error_code: errorCode,
      error_message: safeMessage,
    })
    .eq("id", job.id)
    .eq("locked_by", workerId);
}

/** إلغاء كل وظائف ملف النشطة (عند الحذف أو إعادة التعيين) */
export async function cancelJobsForFile(
  supabase: SupabaseClient,
  fileId: string,
  userId: string,
): Promise<void> {
  await supabase
    .from("rag_jobs")
    .update({ status: "cancelled", locked_by: null, error_code: "cancelled" })
    .eq("file_id", fileId)
    .eq("user_id", userId)
    .in("status", ACTIVE);
}

/** الوظيفة الحالية (نشطة أو آخر منتهية) لملف — للعرض في الواجهة */
export async function getLatestJobForFile(
  supabase: SupabaseClient,
  fileId: string,
  userId: string,
): Promise<RagJob | null> {
  const { data } = await supabase
    .from("rag_jobs")
    .select(JOB_FIELDS)
    .eq("file_id", fileId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RagJob) ?? null;
}
