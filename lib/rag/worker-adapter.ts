/**
 * واجهة العامل المستقل (Adapter) — مُجهّزة وغير مُفعّلة.
 *
 * الوضع الحالي: request-driven (RequestDrivenWorker) — التنفيذ داخل الطلب المصادَق
 * عبر جلسته، وPostgreSQL مصدر الحقيقة للطابور.
 *
 * الوضع المستقبلي: StandaloneWorker — عملية مستقلة تستطلع الطابور عبر كل المستخدمين.
 * يتطلب service role (تجاوز RLS) — غير مُضاف بانتظار الموافقة. لا يُفعَّل الآن.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { drainOwnJobs } from "./worker";

export interface RagWorkerAdapter {
  readonly id: string;
  readonly mode: "request-driven" | "standalone";
  /** هل يعالج وظائف مستخدم واحد (الجلسة) أم كل المستخدمين؟ */
  readonly scope: "current-user" | "all-users";
  /** تصريف الوظائف المتاحة ضمن ميزانية */
  drain(opts: { deadlineMs?: number; maxJobs?: number }): Promise<{
    processed: number;
    lastStatus: string | null;
  }>;
}

/** المُفعّل حاليًا: يصرّف وظائف المستخدم الحالي عبر جلسته (RLS نافذ) */
export class RequestDrivenWorker implements RagWorkerAdapter {
  readonly mode = "request-driven" as const;
  readonly scope = "current-user" as const;
  constructor(
    private supabase: SupabaseClient,
    readonly id: string,
  ) {}
  drain(opts: { deadlineMs?: number; maxJobs?: number }) {
    return drainOwnJobs(this.supabase, {
      workerId: this.id,
      deadlineMs: opts.deadlineMs,
      maxJobs: opts.maxJobs,
    });
  }
}

/**
 * StandaloneWorker — غير مُفعّل. يبقى كعقد واجهة فقط.
 * تفعيله يتطلب: (1) موافقتك، (2) SUPABASE_SERVICE_ROLE_KEY آمن على الخادم،
 * (3) دالة التقاط إدارية عبر كل المستخدمين (claim_rag_job_admin).
 */
export const STANDALONE_WORKER_REQUIREMENTS = {
  activated: false,
  needsServiceRole: true,
  needsAdminClaimRpc: true,
  note: "عامل مستقل عبر كل المستخدمين — يتطلب service role وموافقة صريحة.",
} as const;
