"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

interface UserRow {
  id: string;
  display_name: string | null;
  role: string;
  status: string;
  tier: string;
  created_at: string;
}

const ROLES = ["user", "admin", "owner"];
const TIERS = ["free", "plus", "pro", "business"];
const STATUSES = ["active", "banned", "ai_suspended"];

export function AdminUsersView({ isOwner, selfId }: { isOwner: boolean; selfId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserRow | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (roleFilter) p.set("role", roleFilter);
    if (statusFilter) p.set("status", statusFilter);
    p.set("page", String(page));
    const res = await fetch(`/api/admin/users?${p.toString()}`);
    if (!res.ok) {
      setError("تعذّر جلب المستخدمين");
      setLoading(false);
      return;
    }
    const j = (await res.json()) as { users: UserRow[]; total: number };
    setUsers(j.users);
    setTotal(j.total);
    setLoading(false);
  }, [search, roleFilter, statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(userId: string, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      setError(j?.error ?? "فشلت العملية");
      return false;
    }
    setToast("تم الحفظ");
    setTimeout(() => setToast(null), 1800);
    await load();
    return true;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="px-4 md:px-6 py-5 space-y-4">
      <h1 className="text-[17px] font-semibold text-ink-strong">المستخدمون</h1>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 flex-1">
          <Search size={13} className="text-ink-faint" />
          <input
            value={search}
            onChange={(e) => {
              setPage(0);
              setSearch(e.target.value);
            }}
            placeholder="بحث بالاسم"
            className="bg-transparent w-full text-[13px] text-ink placeholder-ink-faint focus:outline-none"
          />
        </div>
        <select value={roleFilter} onChange={(e) => { setPage(0); setRoleFilter(e.target.value); }} className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink">
          <option value="">كل الأدوار</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => { setPage(0); setStatusFilter(e.target.value); }} className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink">
          <option value="">كل الحالات</option>
          {STATUSES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">{error}</div>}
      {toast && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[13px] text-emerald-300">{toast}</div>}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-xl bg-raised/50 animate-pulse" />)}</div>
      ) : users.length === 0 ? (
        <div className="text-center py-14 text-[13px] text-ink-dim">لا مستخدمين مطابقين.</div>
      ) : (
        <>
          {/* جدول على الكمبيوتر */}
          <div className="hidden md:block rounded-2xl border border-line/70 overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-surface text-ink-dim">
                <tr>
                  <th className="text-start px-3 py-2 font-medium">الاسم</th>
                  <th className="text-start px-3 py-2 font-medium">الدور</th>
                  <th className="text-start px-3 py-2 font-medium">الباقة</th>
                  <th className="text-start px-3 py-2 font-medium">الحالة</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-raised/40">
                    <td className="px-3 py-2 text-ink-strong">{u.display_name ?? "—"}{u.id === selfId && <span className="text-ink-faint"> (أنت)</span>}</td>
                    <td className="px-3 py-2">{u.role}</td>
                    <td className="px-3 py-2">{u.tier}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-3 py-2 text-end">
                      <button onClick={() => setDetail(u)} className="text-[12px] px-2.5 py-1 rounded-lg text-primary-glow hover:bg-raised">إدارة</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* بطاقات على الجوال */}
          <div className="md:hidden space-y-2">
            {users.map((u) => (
              <div key={u.id} className="rounded-xl border border-line/70 bg-surface/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-ink-strong">{u.display_name ?? "—"}</span>
                  <button onClick={() => setDetail(u)} className="text-[12px] text-primary-glow">إدارة</button>
                </div>
                <div className="flex gap-2 mt-1.5 text-[11px] text-ink-dim">
                  <span>{u.role}</span><span>·</span><span>{u.tier}</span><span>·</span><StatusBadge status={u.status} />
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between text-[12px] text-ink-dim">
            <span>{total.toLocaleString("en-US")} مستخدم</span>
            <div className="flex items-center gap-2">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">السابق</button>
              <span dir="ltr">{page + 1}/{totalPages}</span>
              <button disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-2.5 py-1 rounded-lg bg-raised border border-line disabled:opacity-40">التالي</button>
            </div>
          </div>
        </>
      )}

      {detail && (
        <UserDetailModal
          user={detail}
          isOwner={isOwner}
          isSelf={detail.id === selfId}
          onClose={() => setDetail(null)}
          onAct={act}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : status === "banned"
        ? "bg-red-500/15 text-red-400 border-red-500/30"
        : "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return <span className={`text-[10.5px] px-1.5 py-0.5 rounded-md border ${cls}`}>{status}</span>;
}

function UserDetailModal({
  user,
  isOwner,
  isSelf,
  onClose,
  onAct,
}: {
  user: UserRow;
  isOwner: boolean;
  isSelf: boolean;
  onClose: () => void;
  onAct: (id: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [detail, setDetail] = useState<{ counts?: Record<string, number>; usage?: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/admin/users/${user.id}`);
      if (res.ok) setDetail(await res.json());
    })();
  }, [user.id]);

  async function confirmAct(label: string, body: Record<string, unknown>) {
    if (!window.confirm(label)) return;
    setBusy(true);
    const ok = await onAct(user.id, body);
    setBusy(false);
    if (ok) onClose();
  }

  // owner لا يُعدّله إلا owner؛ ودور owner لا يُمنح إلا من owner
  const canEditRole = !isSelf && (isOwner || user.role !== "owner");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-ink-strong">{user.display_name ?? "—"}</h2>
          <button onClick={onClose} className="p-1 text-ink-faint hover:text-ink"><X size={16} /></button>
        </div>

        {detail?.counts && (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["محادثات", detail.counts.conversations], ["ملفات", detail.counts.files], ["مشاريع", detail.counts.projects]].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-raised/60 border border-line/60 py-2">
                <div className="text-[16px] font-bold text-ink-strong tabular-nums">{v}</div>
                <div className="text-[10.5px] text-ink-faint">{l}</div>
              </div>
            ))}
          </div>
        )}
        {detail?.usage && (
          <div className="text-[11.5px] text-ink-dim">استهلاك الشهر: {detail.usage.monthMessages} رسالة · {detail.usage.monthTokens?.toLocaleString("en-US")} tokens · اليوم: {detail.usage.dayMessages}</div>
        )}

        {/* الدور */}
        <Field label="الدور">
          <select
            defaultValue={user.role}
            disabled={!canEditRole || busy}
            onChange={(e) => confirmAct(`تغيير الدور إلى ${e.target.value}؟`, { op: "role", role: e.target.value })}
            className="rounded-lg bg-raised border border-line px-2.5 py-1.5 text-[12.5px] text-ink disabled:opacity-50"
          >
            {ROLES.map((r) => <option key={r} value={r} disabled={r === "owner" && !isOwner}>{r}</option>)}
          </select>
        </Field>

        {/* الباقة */}
        <Field label="الباقة">
          <select
            defaultValue={user.tier}
            disabled={busy}
            onChange={(e) => confirmAct(`تغيير الباقة إلى ${e.target.value}؟`, { op: "tier", tier: e.target.value })}
            className="rounded-lg bg-raised border border-line px-2.5 py-1.5 text-[12.5px] text-ink disabled:opacity-50"
          >
            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>

        {/* الحالة */}
        <Field label="الحالة">
          <select
            defaultValue={user.status}
            disabled={isSelf || busy}
            onChange={(e) => confirmAct(`تغيير الحالة إلى ${e.target.value}؟`, { op: "status", status: e.target.value })}
            className="rounded-lg bg-raised border border-line px-2.5 py-1.5 text-[12.5px] text-ink disabled:opacity-50"
          >
            {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </Field>

        <button
          disabled={busy}
          onClick={() => confirmAct("إعادة تعيين استهلاك الشهر لهذا المستخدم؟", { op: "reset_usage" })}
          className="w-full text-[12.5px] px-3 py-2 rounded-xl text-ink bg-raised border border-line hover:border-primary/40 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin inline" /> : "إعادة تعيين استهلاك الشهر"}
        </button>
        <p className="text-[10.5px] text-ink-faint">حذف حساب المصادقة يتطلب service role (غير مُفعّل). حذف البيانات عبر طلب المستخدم فقط.</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12.5px] text-ink-dim">{label}</span>
      {children}
    </div>
  );
}
