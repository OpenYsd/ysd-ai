"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface Job {
  id: string;
  user_id: string;
  file_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  heartbeat_at: string | null;
  progress_current: number;
  progress_total: number;
  error_code: string | null;
  durationMs: number | null;
  isStuck: boolean;
  created_at: string;
}

export function AdminRagView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [byStatus, setByStatus] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [stuckOnly, setStuckOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (statusFilter) p.set("status", statusFilter);
    if (stuckOnly) p.set("stuck", "true");
    p.set("page", String(page));
    const res = await fetch(`/api/admin/rag?${p.toString()}`);
    if (!res.ok) { setError("تعذّر الجلب"); setLoading(false); return; }
    const j = await res.json();
    setJobs(j.jobs); setTotal(j.total); setByStatus(j.byStatus ?? {});
    setLoading(false);
  }, [statusFilter, stuckOnly, page]);
  useEffect(() => { void load(); }, [load]);

  async function op(id: string, operation: "requeue" | "cancel") {
    setError(null);
    const res = await fetch(`/api/admin/rag/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: operation }),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "فشل"); return; }
    await load();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const dur = (ms: number | null) => (ms == null ? "—" : ms < 60000 ? `${Math.round(ms / 1000)}ث` : `${Math.round(ms / 60000)}د`);

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">وظائف RAG</h1>

      <div className="flex gap-2 flex-wrap text-[11.5px]">
        {Object.entries(byStatus).map(([s, c]) => (
          <span key={s} className="px-2 py-1 rounded-lg bg-raised border border-line text-ink-dim">{s}: <b className="text-ink" dir="ltr">{c}</b></span>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        <select value={statusFilter} onChange={(e) => { setPage(0); setStatusFilter(e.target.value); }} className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink">
          <option value="">كل الحالات</option>
          {["queued", "running", "retrying", "completed", "failed", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={() => { setPage(0); setStuckOnly((v) => !v); }} className={`px-3 py-2 rounded-xl text-[12.5px] border ${stuckOnly ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-line bg-raised text-ink-dim"}`}>
          العالقة فقط
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-raised/50 animate-pulse" />)}</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-14 text-[13px] text-ink-dim">لا وظائف.</div>
      ) : (
        <div className="rounded-2xl border border-line/70 divide-y divide-line/40">
          {jobs.map((j) => (
            <div key={j.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              {j.isStuck && <AlertTriangle size={14} className="text-amber-400" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className={`px-1.5 py-0.5 rounded-md border text-[10.5px] ${statusTone(j.status)}`}>{j.status}</span>
                  <span className="text-ink-faint" dir="ltr">job {j.id.slice(0, 8)}</span>
                  <span className="text-ink-faint" dir="ltr">file {j.file_id.slice(0, 8)}</span>
                </div>
                <div className="text-[11px] text-ink-faint mt-1" dir="ltr">
                  attempts {j.attempts}/{j.max_attempts} · {j.progress_current}/{j.progress_total} chunks · {dur(j.durationMs)}{j.error_code ? ` · ${j.error_code}` : ""}
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {["failed", "cancelled", "retrying"].includes(j.status) && (
                  <button onClick={() => op(j.id, "requeue")} className="text-[11.5px] px-2.5 py-1 rounded-lg text-white" style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}>إعادة</button>
                )}
                {["queued", "running", "retrying"].includes(j.status) && (
                  <button onClick={() => op(j.id, "cancel")} className="text-[11.5px] px-2.5 py-1 rounded-lg text-ink bg-raised border border-line hover:border-red-500/40">إلغاء</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-[12px] text-ink-dim">
        <span>{total.toLocaleString("en-US")} وظيفة</span>
        <div className="flex items-center gap-2">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">السابق</button>
          <span dir="ltr">{page + 1}/{totalPages}</span>
          <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">التالي</button>
        </div>
      </div>
      <p className="text-[10.5px] text-ink-faint">لا يُعرض نص الملف أو المقاطع هنا — بيانات تشغيلية فقط.</p>
    </div>
  );
}

function statusTone(s: string) {
  if (s === "completed") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "failed") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (s === "running" || s === "retrying") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-raised text-ink-dim border-line";
}
