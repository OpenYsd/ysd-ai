"use client";

import { useEffect, useState } from "react";

interface Setting { key: string; value: unknown; owner_only: boolean }

const LABELS: Record<string, string> = {
  maintenance_mode: "وضع الصيانة",
  allow_registration: "السماح بالتسجيل",
  rag_enabled: "تفعيل RAG",
  default_model_id: "النموذج الافتراضي",
  announcement: "إعلان عام",
};

export function AdminSettingsView({ isOwner }: { isOwner: boolean }) {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch("/api/admin/settings");
    if (!res.ok) { setError("تعذّر الجلب"); setLoading(false); return; }
    const j = await res.json();
    setSettings(j.settings);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function save(key: string, value: unknown, ownerOnly: boolean) {
    if (ownerOnly && !window.confirm("إعداد حرج — تأكيد الحفظ؟")) return;
    setError(null);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }),
    });
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "فشل"); return; }
    setToast("حُفظ"); setTimeout(() => setToast(null), 1500);
    await load();
  }

  if (loading) return <div className="px-6 py-5"><div className="h-40 rounded-2xl bg-raised/50 animate-pulse" /></div>;

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">إعدادات المنصة</h1>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}
      {toast && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[13px] text-emerald-300">{toast}</div>}

      <div className="rounded-2xl border border-line/70 divide-y divide-line/40">
        {settings.map((st) => {
          const locked = st.owner_only && !isOwner;
          const isBool = typeof st.value === "boolean";
          return (
            <div key={st.key} className="px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <span className="text-[13px] text-ink-strong">{LABELS[st.key] ?? st.key}</span>
                {st.owner_only && <span className="ms-2 text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-400 border border-amber-500/30">owner</span>}
                {locked && <span className="ms-2 text-[10px] text-ink-faint">للمالك فقط</span>}
              </div>
              {isBool ? (
                <button
                  onClick={() => save(st.key, !st.value, st.owner_only)}
                  disabled={locked}
                  className={`rounded-full transition-colors disabled:opacity-40 ${st.value ? "bg-primary" : "bg-raised border border-line"}`}
                  style={{ height: 22, width: 40, position: "relative" }}
                >
                  <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ insetInlineStart: st.value ? 20 : 3 }} />
                </button>
              ) : (
                <InlineText value={String(st.value)} disabled={locked} onSave={(v) => save(st.key, v, st.owner_only)} />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10.5px] text-ink-faint">الإعدادات مركزية في جدول <code dir="ltr">platform_settings</code> — لا داخل ملفات الواجهة. الإعدادات الحرجة owner-only (تُفرض على الخادم).</p>
    </div>
  );
}

function InlineText({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="flex items-center gap-1.5">
      <input value={v} onChange={(e) => setV(e.target.value)} disabled={disabled} className="rounded-lg bg-raised border border-line px-2 py-1 text-[12px] text-ink-strong w-40 focus:outline-none focus:border-primary disabled:opacity-50" dir="ltr" />
      <button onClick={() => onSave(v)} disabled={disabled || v === value} className="text-[11.5px] px-2 py-1 rounded-lg text-white disabled:opacity-40" style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}>حفظ</button>
    </div>
  );
}
