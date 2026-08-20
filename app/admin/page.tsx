import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { StatCard, StatusPill } from "@/components/admin/stat-card";
import { AdminRangeFilter } from "@/components/admin/range-filter";
import { BetaReport } from "@/components/admin/beta-report";
import { aggregateUsageEvents } from "@/lib/usage/aggregate";

export const dynamic = "force-dynamic";

function rangeStart(range: string): Date | null {
  const now = new Date();
  if (range === "today") {
    now.setHours(0, 0, 0, 0);
    return now;
  }
  if (range === "7d") return new Date(Date.now() - 7 * 86400_000);
  if (range === "30d") return new Date(Date.now() - 30 * 86400_000);
  return null; // all
}

export default async function AdminOverview({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  const { range = "30d" } = await searchParams;
  const since = rangeStart(range);
  const sinceIso = since?.toISOString();
  const s = ctx.supabase;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // عدّادات (head:true → عدد فقط، بلا بيانات) — RLS يسمح للمشرف
  const countIn = (q: ReturnType<typeof s.from>) => q;
  const [
    totalUsers, newToday, newMonth,
    conversations, messages, projects,
    filesReady, filesFailed, allFiles,
    usageRows, ragStatuses,
  ] = await Promise.all([
    s.from("profiles").select("id", { count: "exact", head: true }),
    s.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", todayStart.toISOString()),
    s.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", monthStart.toISOString()),
    sinceIso
      ? s.from("conversations").select("id", { count: "exact", head: true }).is("deleted_at", null).gte("created_at", sinceIso)
      : s.from("conversations").select("id", { count: "exact", head: true }).is("deleted_at", null),
    sinceIso
      ? s.from("messages").select("id", { count: "exact", head: true }).gte("created_at", sinceIso)
      : s.from("messages").select("id", { count: "exact", head: true }),
    s.from("projects").select("id", { count: "exact", head: true }).is("deleted_at", null),
    s.from("files").select("id", { count: "exact", head: true }).eq("status", "ready_for_rag").is("deleted_at", null),
    s.from("files").select("id", { count: "exact", head: true }).eq("status", "rag_failed").is("deleted_at", null),
    s.from("files").select("size_bytes").is("deleted_at", null),
    aggregateUsageEvents(s, { since: sinceIso ?? null }, { withModels: true }),
    s.from("rag_jobs").select("status"),
  ]);
  void countIn;

  const storageBytes = ((allFiles.data ?? []) as { size_bytes: number | null }[]).reduce(
    (a, f) => a + (f.size_bytes ?? 0),
    0,
  );
  const tokens = usageRows.tokens;
  const modelUse = new Map<string, number>(
    [...usageRows.byModel].map(([model, v]) => [model, v.requests]),
  );
  const jobsBy: Record<string, number> = {};
  for (const r of ragStatuses.data ?? []) jobsBy[r.status] = (jobsBy[r.status] ?? 0) + 1;
  const jobsTotal = Object.values(jobsBy).reduce((a, b) => a + b, 0);
  const errorRate = jobsTotal ? Math.round(((jobsBy.failed ?? 0) / jobsTotal) * 100) : 0;
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="px-4 md:px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold text-ink-strong">نظرة عامة</h1>
        <AdminRangeFilter current={range} />
      </div>

      <BetaReport />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="إجمالي المستخدمين" value={totalUsers.count ?? 0} />
        <StatCard label="جدد اليوم" value={newToday.count ?? 0} />
        <StatCard label="جدد هذا الشهر" value={newMonth.count ?? 0} />
        <StatCard label="المشاريع" value={projects.count ?? 0} />
        <StatCard label="المحادثات" value={conversations.count ?? 0} sub={`في النطاق`} />
        <StatCard label="الرسائل" value={messages.count ?? 0} sub={`في النطاق`} />
        <StatCard label="التخزين" value={mb(storageBytes)} />
        <StatCard label="Tokens" value={tokens} sub="في النطاق" />
        <StatCard label="ملفات جاهزة RAG" value={filesReady.count ?? 0} />
        <StatCard label="ملفات فشلت RAG" value={filesFailed.count ?? 0} />
        <StatCard label="معدل أخطاء الوظائف" value={`${errorRate}%`} />
        <StatCard label="نماذج مستخدمة" value={modelUse.size} />
      </div>

      <div>
        <h2 className="text-[13px] font-medium text-ink-strong mb-2">وظائف RAG</h2>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <StatusPill label="queued" count={jobsBy.queued ?? 0} tone="border-line bg-raised/60 text-ink" />
          <StatusPill label="running" count={jobsBy.running ?? 0} tone="border-amber-500/30 bg-amber-500/10 text-amber-300" />
          <StatusPill label="retrying" count={jobsBy.retrying ?? 0} tone="border-amber-500/30 bg-amber-500/10 text-amber-300" />
          <StatusPill label="completed" count={jobsBy.completed ?? 0} tone="border-emerald-500/30 bg-emerald-500/10 text-emerald-300" />
          <StatusPill label="failed" count={jobsBy.failed ?? 0} tone="border-red-500/30 bg-red-500/10 text-red-300" />
          <StatusPill label="cancelled" count={jobsBy.cancelled ?? 0} tone="border-line bg-raised/60 text-ink-dim" />
        </div>
      </div>

      {modelUse.size > 0 && (
        <div>
          <h2 className="text-[13px] font-medium text-ink-strong mb-2">استخدام النماذج (طلبات)</h2>
          <div className="rounded-2xl border border-line/70 bg-surface/60 divide-y divide-line/40">
            {[...modelUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, c]) => (
              <div key={m} className="flex items-center justify-between px-4 py-2 text-[12.5px]">
                <span className="text-ink truncate" dir="ltr">{m}</span>
                <span className="text-ink-dim tabular-nums" dir="ltr">{c.toLocaleString("en-US")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-ink-faint">
        حالة الخدمات المباشرة عبر <code dir="ltr">/api/health</code>.
      </p>
    </div>
  );
}
