"use client";

import { useCallback, useEffect, useState } from "react";

interface Provider { id: string; display_name: string; enabled: boolean; keyState: string }
interface Model { id: string; provider_id: string; display_name_ar: string; display_name_en: string; enabled: boolean }

export function AdminModelsView() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [usage, setUsage] = useState<Record<string, { requests: number; tokens: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/models");
    if (!res.ok) { setError("تعذّر الجلب"); setLoading(false); return; }
    const j = await res.json();
    setProviders(j.providers); setModels(j.models); setUsage(j.usageByModel ?? {});
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(target: "provider" | "model", id: string, enabled: boolean) {
    setError(null);
    const res = await fetch("/api/admin/models", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, id, enabled }),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "فشل"); return; }
    await load();
  }

  if (loading) return <div className="px-6 py-5"><div className="h-40 rounded-2xl bg-raised/50 animate-pulse" /></div>;

  return (
    <div className="px-4 md:px-6 py-5 space-y-5">
      <h1 className="text-[17px] font-semibold text-ink-strong">النماذج والموفرون</h1>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}

      <section>
        <h2 className="text-[13px] font-medium text-ink-strong mb-2">الموفرون</h2>
        <div className="rounded-2xl border border-line/70 divide-y divide-line/40">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <span className="text-[13px] text-ink-strong">{p.display_name}</span>
                <span className={`ms-2 text-[10.5px] px-1.5 py-0.5 rounded-md border ${p.keyState === "configured" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-amber-500/15 text-amber-400 border-amber-500/30"}`}>
                  {p.keyState === "configured" ? "مُعدّ" : "مفتاح مفقود"}
                </span>
              </div>
              <Toggle on={p.enabled} onChange={(v) => toggle("provider", p.id, v)} />
            </div>
          ))}
        </div>
        <p className="text-[10.5px] text-ink-faint mt-1.5">لا تُعرض مفاتيح API إطلاقًا — الحالة فقط (configured / missing).</p>
      </section>

      <section>
        <h2 className="text-[13px] font-medium text-ink-strong mb-2">النماذج</h2>
        <div className="rounded-2xl border border-line/70 divide-y divide-line/40">
          {models.map((m) => {
            const u = usage[m.id];
            return (
              <div key={m.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-strong truncate" dir="ltr">{m.id}</div>
                  <div className="text-[11px] text-ink-faint">{m.display_name_ar} · {m.provider_id}{u ? ` · ${u.requests} طلب · ${u.tokens.toLocaleString("en-US")} tokens` : ""}</div>
                </div>
                <Toggle on={m.enabled} onChange={(v) => toggle("model", m.id, v)} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-10 h-5.5 rounded-full transition-colors shrink-0 ${on ? "bg-primary" : "bg-raised border border-line"}`}
      style={{ height: 22, width: 40 }}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? "start-[20px]" : "start-0.5"}`} style={{ [on ? "insetInlineStart" : "insetInlineStart"]: on ? 20 : 3 }} />
    </button>
  );
}
