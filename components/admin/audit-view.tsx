"use client";

import { useCallback, useEffect, useState } from "react";
import { Search } from "lucide-react";

interface Log {
  id: string;
  adminName: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}

export function AdminAuditView() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (action.trim()) p.set("action", action.trim());
    p.set("page", String(page));
    const res = await fetch(`/api/admin/audit?${p.toString()}`);
    if (res.ok) {
      const j = await res.json();
      setLogs(j.logs); setTotal(j.total);
    }
    setLoading(false);
  }, [action, page]);
  useEffect(() => { void load(); }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fmt = (o: Record<string, unknown> | null) => (o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ") : "—");

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">سجل التدقيق</h1>

      <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 max-w-sm">
        <Search size={13} className="text-ink-faint" />
        <input value={action} onChange={(e) => { setPage(0); setAction(e.target.value); }} placeholder="بحث بالعملية (مثل user.role)" className="bg-transparent w-full text-[13px] text-ink placeholder-ink-faint focus:outline-none" />
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-xl bg-raised/50 animate-pulse" />)}</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-14 text-[13px] text-ink-dim">لا سجلات.</div>
      ) : (
        <div className="rounded-2xl border border-line/70 divide-y divide-line/40 overflow-x-auto">
          {logs.map((l) => (
            <div key={l.id} className="px-4 py-2.5 text-[12px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary-glow border border-primary/30 text-[10.5px]" dir="ltr">{l.action}</span>
                <span className="text-ink-strong">{l.adminName}</span>
                {l.target_type && <span className="text-ink-faint" dir="ltr">→ {l.target_type} {l.target_id?.slice(0, 8) ?? ""}</span>}
                <span className="text-ink-faint ms-auto" dir="ltr">{new Date(l.created_at).toLocaleString("en-GB")}</span>
              </div>
              {(l.before || l.after) && (
                <div className="text-[10.5px] text-ink-faint mt-1" dir="ltr">
                  {l.before && <span>before: {fmt(l.before)} </span>}
                  {l.after && <span>after: {fmt(l.after)}</span>}
                  {l.ip && <span> · ip {l.ip}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-[12px] text-ink-dim">
        <span>{total.toLocaleString("en-US")} سجل</span>
        <div className="flex items-center gap-2">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">السابق</button>
          <span dir="ltr">{page + 1}/{totalPages}</span>
          <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">التالي</button>
        </div>
      </div>
    </div>
  );
}
