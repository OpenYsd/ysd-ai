"use client";

import { useEffect, useState } from "react";

interface Limit {
  tier: string;
  monthly_messages: number; monthly_tokens: number; daily_messages: number;
  max_file_mb: number; max_files: number; max_storage_mb: number;
  max_chunks_per_file: number; max_total_chunks: number;
}

const FIELDS: { key: keyof Limit; label: string }[] = [
  { key: "monthly_messages", label: "رسائل/شهر" },
  { key: "daily_messages", label: "رسائل/يوم" },
  { key: "monthly_tokens", label: "tokens/شهر" },
  { key: "max_file_mb", label: "حجم ملف MB" },
  { key: "max_files", label: "عدد الملفات" },
  { key: "max_storage_mb", label: "تخزين MB" },
  { key: "max_chunks_per_file", label: "مقاطع/ملف" },
  { key: "max_total_chunks", label: "إجمالي المقاطع" },
];

export function AdminUsageView() {
  const [limits, setLimits] = useState<Limit[]>([]);
  const [edited, setEdited] = useState<Record<string, Limit>>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/admin/usage-limits");
    if (!res.ok) { setError("تعذّر الجلب"); setLoading(false); return; }
    const j = await res.json();
    setLimits(j.limits);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  function setField(tier: string, key: keyof Limit, value: number) {
    setEdited((e) => {
      const base = e[tier] ?? limits.find((l) => l.tier === tier)!;
      return { ...e, [tier]: { ...base, [key]: value } };
    });
  }

  async function save(tier: string) {
    const l = edited[tier] ?? limits.find((x) => x.tier === tier);
    if (!l) return;
    if (!window.confirm(`حفظ حدود باقة ${tier}؟`)) return;
    setError(null);
    const res = await fetch("/api/admin/usage-limits", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(l),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "فشل"); return; }
    setToast(`حُفظت باقة ${tier}`); setTimeout(() => setToast(null), 1800);
    setEdited((e) => { const c = { ...e }; delete c[tier]; return c; });
    await load();
  }

  if (loading) return <div className="px-6 py-5"><div className="h-40 rounded-2xl bg-raised/50 animate-pulse" /></div>;

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">الاستهلاك والحدود</h1>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}
      {toast && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[13px] text-emerald-300">{toast}</div>}

      <div className="space-y-3">
        {limits.map((base) => {
          const cur = edited[base.tier] ?? base;
          const dirty = Boolean(edited[base.tier]);
          return (
            <div key={base.tier} className="rounded-2xl border border-line/70 bg-surface/60 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[14px] font-medium text-primary-glow">{base.tier}</span>
                <button onClick={() => save(base.tier)} disabled={!dirty} className="text-[12px] px-3 py-1.5 rounded-lg text-white disabled:opacity-40" style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}>حفظ</button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                {FIELDS.map((f) => (
                  <label key={f.key} className="block">
                    <span className="text-[10.5px] text-ink-faint block mb-0.5">{f.label}</span>
                    <input
                      type="number" min={0} value={cur[f.key] as number}
                      onChange={(e) => setField(base.tier, f.key, Math.max(0, Number(e.target.value)))}
                      className="w-full rounded-lg bg-raised border border-line px-2 py-1.5 text-[12px] text-ink-strong focus:outline-none focus:border-primary tabular-nums"
                      dir="ltr"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[10.5px] text-ink-faint">التحقق على الخادم (Zod + RPC): لا قيم سالبة، وتأكيد قبل الحفظ، وكل تعديل يُسجّل في التدقيق.</p>
    </div>
  );
}
