import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminContext, forbidden } from "@/lib/admin/guard";
import { adminJson as json } from "@/lib/admin/rpc";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["queued", "running", "retrying", "completed", "failed", "cancelled"]).optional(),
  stuck: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(0).max(100000).default(0),
});
const PAGE = 25;
/** وظيفة تتجاوز هذه المدة (بالدقائق) في running = عالقة */
const STUCK_MINUTES = 10;

/** وظائف RAG — للمشرفين. أعمدة آمنة فقط (لا نص ملف/مقاطع). */
export async function GET(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);
  const { status, stuck, page } = parsed.data;

  let q = ctx.supabase
    .from("rag_jobs")
    .select(
      "id, user_id, file_id, status, attempts, max_attempts, heartbeat_at, started_at, completed_at, progress_current, progress_total, progress_percent, error_code, correlation_id, created_at, updated_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (status) q = q.eq("status", status);
  if (stuck) {
    const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
    q = q.eq("status", "running").lt("heartbeat_at", cutoff);
  }

  const { data, count, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
  if (error) return json({ error: "تعذّر جلب الوظائف | Failed" }, 500);

  // تنبيه: احسب المدة والعالقة
  const now = Date.now();
  const jobs = (data ?? []).map((j) => {
    const durationMs = j.started_at
      ? (j.completed_at ? new Date(j.completed_at).getTime() : now) - new Date(j.started_at).getTime()
      : null;
    const isStuck =
      j.status === "running" &&
      j.heartbeat_at != null &&
      now - new Date(j.heartbeat_at).getTime() > STUCK_MINUTES * 60_000;
    return { ...j, durationMs, isStuck };
  });

  // إحصاء حسب الحالة
  const { data: allStatuses } = await ctx.supabase.from("rag_jobs").select("status");
  const byStatus: Record<string, number> = {};
  for (const r of allStatuses ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return json({ jobs, total: count ?? 0, page, pageSize: PAGE, byStatus }, 200);
}
