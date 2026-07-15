import { getAdminContext } from "@/lib/admin/guard";

/** تقرير Beta أسبوعي (آخر 7 أيام) — بيانات حقيقية مجمّعة، بلا محتوى مستخدمين */
export async function BetaReport() {
  const ctx = await getAdminContext();
  if (!ctx) return null;
  const s = ctx.supabase;
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [activeUsers, usageRows, ragFailed, ragTotal, files] = await Promise.all([
    // مستخدمون نشطون: أنشأوا رسالة خلال الأسبوع
    s.from("usage_events").select("user_id").gte("created_at", weekAgo),
    s.from("usage_events").select("model_id, input_tokens, output_tokens").gte("created_at", weekAgo),
    s.from("rag_jobs").select("id", { count: "exact", head: true }).eq("status", "failed").gte("created_at", weekAgo),
    s.from("rag_jobs").select("id", { count: "exact", head: true }).gte("created_at", weekAgo),
    s.from("files").select("size_bytes").is("deleted_at", null),
  ]);

  const active = new Set((activeUsers.data ?? []).map((r) => r.user_id)).size;
  const byModel = new Map<string, number>();
  let tokens = 0;
  for (const u of usageRows.data ?? []) {
    byModel.set(u.model_id ?? "?", (byModel.get(u.model_id ?? "?") ?? 0) + 1);
    tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  const storageMb = ((files.data ?? []).reduce((a, f) => a + (f.size_bytes ?? 0), 0) / 1024 / 1024).toFixed(1);
  const failRate = (ragTotal.count ?? 0) ? Math.round(((ragFailed.count ?? 0) / (ragTotal.count ?? 1)) * 100) : 0;

  return (
    <div className="rounded-2xl border border-line/70 bg-surface/60 p-4">
      <h2 className="text-[13px] font-medium text-ink-strong mb-3">تقرير Beta — آخر ٧ أيام</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
        {[
          ["مستخدمون نشطون", active],
          ["Tokens", tokens],
          ["وظائف RAG فاشلة", ragFailed.count ?? 0],
          ["معدل فشل RAG", `${failRate}%`],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded-xl bg-raised/50 border border-line/50 py-2.5">
            <div className="text-[18px] font-bold text-ink-strong tabular-nums" dir="ltr">
              {typeof v === "number" ? v.toLocaleString("en-US") : v}
            </div>
            <div className="text-[10.5px] text-ink-faint mt-0.5">{l}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-[11.5px] text-ink-dim">
        <span>مساحة التخزين الإجمالية: <b dir="ltr">{storageMb} MB</b></span>
        <span>نماذج مستخدمة: <b dir="ltr">{byModel.size}</b></span>
      </div>
    </div>
  );
}
