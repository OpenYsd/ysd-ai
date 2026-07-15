"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";

interface Invite {
  id: string;
  code_hint: string | null;
  label: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  status: string;
}

export function AdminInvitesView() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState<number | "">(30);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const res = await fetch("/api/admin/invites");
    if (res.ok) setInvites((await res.json()).invites);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setCreating(true);
    setError(null);
    setNewCode(null);
    const res = await fetch("/api/admin/invites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim() || undefined, maxUses, expiresInDays: expiresInDays === "" ? null : expiresInDays }),
    });
    setCreating(false);
    if (!res.ok) { const j = await res.json().catch(() => null); setError(j?.error ?? "فشل"); return; }
    const j = await res.json();
    setNewCode(j.code); // يُعرض مرة واحدة
    setLabel("");
    await load();
  }

  async function revoke(id: string) {
    if (!window.confirm("إلغاء هذه الدعوة؟")) return;
    const res = await fetch(`/api/admin/invites/${id}`, { method: "POST" });
    if (res.ok) await load();
  }

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">دعوات Beta</h1>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}

      {/* إنشاء */}
      <div className="rounded-2xl border border-line/70 bg-surface/60 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ملاحظة (اختياري)" className="rounded-xl bg-raised border border-line px-3 py-2 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:border-primary" />
          <label className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink-dim">
            حد الاستخدام
            <input type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value)))} className="bg-transparent w-16 text-ink-strong focus:outline-none tabular-nums" dir="ltr" />
          </label>
          <label className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink-dim">
            ينتهي بعد (يوم)
            <input type="number" min={1} max={365} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value === "" ? "" : Math.max(1, Number(e.target.value)))} placeholder="بلا" className="bg-transparent w-16 text-ink-strong focus:outline-none tabular-nums" dir="ltr" />
          </label>
        </div>
        <button onClick={create} disabled={creating} className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-medium text-white disabled:opacity-50" style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}>
          <Plus size={14} /> إنشاء دعوة
        </button>

        {newCode && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="text-[12px] text-emerald-300 mb-1.5">الكود يُعرض مرة واحدة فقط — انسخه الآن (لا يُخزَّن الكود الخام):</div>
            <div className="flex items-center gap-2">
              <code className="text-[15px] font-bold text-ink-strong tracking-wider" dir="ltr">{newCode}</code>
              <button
                onClick={() => { navigator.clipboard?.writeText(newCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="p-1.5 rounded-lg text-ink-dim hover:text-ink hover:bg-raised"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* القائمة */}
      {loading ? (
        <div className="h-40 rounded-2xl bg-raised/50 animate-pulse" />
      ) : invites.length === 0 ? (
        <div className="text-center py-12 text-[13px] text-ink-dim">لا دعوات بعد.</div>
      ) : (
        <div className="rounded-2xl border border-line/70 divide-y divide-line/40">
          {invites.map((inv) => (
            <div key={inv.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <code className="text-[12.5px] text-ink-faint" dir="ltr">••••-{inv.code_hint}</code>
              {inv.label && <span className="text-[12px] text-ink">{inv.label}</span>}
              <span className={`text-[10.5px] px-1.5 py-0.5 rounded-md border ${statusTone(inv.status)}`}>{inv.status}</span>
              <span className="text-[11.5px] text-ink-faint" dir="ltr">{inv.used_count}/{inv.max_uses}</span>
              {inv.expires_at && <span className="text-[11px] text-ink-faint">ينتهي {new Date(inv.expires_at).toLocaleDateString("en-GB")}</span>}
              <div className="flex-1" />
              {inv.status === "active" && (
                <button onClick={() => revoke(inv.id)} className="text-[12px] px-2.5 py-1 rounded-lg text-red-400/80 hover:text-red-400 hover:bg-red-500/10">إلغاء</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusTone(s: string) {
  if (s === "active") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "revoked" || s === "expired") return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-raised text-ink-faint border-line";
}
