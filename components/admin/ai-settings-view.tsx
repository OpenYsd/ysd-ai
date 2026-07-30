"use client";

/**
 * إدارة الذكاء الاصطناعي (v0.8.0) — المزوّد والنموذج الافتراضيان والقائمة
 * المسموحة، مع اختبار الاتصال وتحديث النماذج.
 *
 * لا حقل مفتاح ولا حقل عنوان في هذه اللوحة إطلاقًا: الأسرار تُضبط في البيئة،
 * وحقلٌ هنا يعني سرًّا يمرّ عبر متصفح ويُخزَّن في قاعدة. وكل ما يُعرض من حالات
 * رموز مترجَمة من الخادم — لا نصّ خطأ خام ولا عنوان ولا stack trace.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wifi } from "lucide-react";

interface AdminModel {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  available: boolean;
  allowed: boolean;
}
interface AdminProvider {
  id: string;
  displayName: string;
}
interface CacheInfo {
  count: number;
  updatedAt: string | null;
}
interface Payload {
  providers: AdminProvider[];
  models: AdminModel[];
  defaultProvider: string | null;
  defaultModel: string | null;
  allowedModels: string[] | null;
  cache: Record<string, CacheInfo>;
}

/** رموز الحالة المغلقة — الخادم لا يرسل غيرها */
const HEALTH_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  connected: { text: "متصل", tone: "ok" },
  unauthorized: { text: "غير مصرح", tone: "bad" },
  no_models: { text: "لا توجد نماذج", tone: "warn" },
  unreachable: { text: "تعذر الاتصال", tone: "bad" },
  not_configured: { text: "غير مفعّل", tone: "warn" },
};

const toneClass = (tone: "ok" | "warn" | "bad") =>
  tone === "ok"
    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
    : tone === "warn"
      ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
      : "bg-rose-500/10 text-rose-300 border-rose-500/30";

export function AdminAiSettingsView() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" | "bad" } | null>(null);
  const [health, setHealth] = useState<Record<string, { status: string; modelCount: number }>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/ai-settings");
      if (r.ok) setData((await r.json()) as Payload);
      else setNotice({ text: "تعذر تحميل الإعدادات.", tone: "bad" });
    } catch {
      setNotice({ text: "تعذر تحميل الإعدادات.", tone: "bad" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** نماذج المزوّد الافتراضي المختار وحده — كما يقتضي العقد */
  const modelsOfDefault = useMemo(() => {
    if (!data) return [];
    if (!data.defaultProvider) return data.models;
    return data.models.filter((m) => m.providerId === data.defaultProvider);
  }, [data]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      setNotice(null);
      try {
        const r = await fetch("/api/admin/ai-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          setNotice({ text: "حُفظ.", tone: "ok" });
          await load();
        } else {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          setNotice({ text: j?.error ?? "تعذر الحفظ.", tone: "bad" });
        }
      } catch {
        setNotice({ text: "تعذر الحفظ.", tone: "bad" });
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  /** يمنع النقر المكرر أثناء طلب نشط — الخادم يمنعه أيضًا (حارسان) */
  const runAction = useCallback(
    async (kind: "test" | "refresh", providerId: string) => {
      const key = `${kind}:${providerId}`;
      if (busy[key]) return;
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        const path = kind === "test" ? "test" : "refresh";
        const r = await fetch(`/api/admin/ai-providers/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId }),
        });
        const j = (await r.json().catch(() => null)) as
          | { status?: string; modelCount?: number; count?: number; stale?: boolean; error?: string }
          | null;
        if (!r.ok) {
          setNotice({ text: j?.error ?? "تعذر التنفيذ.", tone: "bad" });
          return;
        }
        if (kind === "test") {
          setHealth((h) => ({
            ...h,
            [providerId]: { status: j?.status ?? "unreachable", modelCount: j?.modelCount ?? 0 },
          }));
        } else {
          setNotice(
            j?.stale
              ? { text: "تعذر التحديث — القائمة السابقة محفوظة (قديمة).", tone: "warn" }
              : { text: `حُدِّثت القائمة: ${j?.count ?? 0} نموذجًا.`, tone: "ok" },
          );
          await load();
        }
      } catch {
        setNotice({ text: "تعذر التنفيذ.", tone: "bad" });
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
    },
    [busy, load],
  );

  const toggleAllowed = useCallback(
    (id: string) => {
      if (!data) return;
      const current = data.allowedModels ?? data.models.map((m) => m.id);
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      void patch({ allowedModels: next });
    },
    [data, patch],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-ink-faint text-[13px] p-6">
        <Loader2 size={14} className="animate-spin" /> جارٍ التحميل…
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-[13px] text-rose-300">تعذر تحميل الإعدادات.</div>;
  }

  return (
    <div dir="rtl" className="p-5 space-y-5">
      <div>
        <h1 className="text-[17px] text-ink-strong">إدارة الذكاء الاصطناعي</h1>
        <p className="text-[12.5px] text-ink-faint mt-1">
          المفاتيح والعناوين تُضبط في بيئة الخادم ولا تظهر هنا.
        </p>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-2.5 text-[13px] ${toneClass(notice.tone)}`}>
          {notice.text}
        </div>
      )}

      {/* بطاقات المزوّدات */}
      <div className="grid gap-3 sm:grid-cols-2">
        {data.providers.map((p) => {
          const h = health[p.id];
          const label = h ? HEALTH_LABEL[h.status] : null;
          const cache = data.cache[p.id];
          const testKey = `test:${p.id}`;
          const refreshKey = `refresh:${p.id}`;
          return (
            <div key={p.id} className="rounded-xl border border-line bg-raised p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] text-ink-strong">{p.displayName}</div>
                {label && (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${toneClass(label.tone)}`}>
                    {label.text}
                  </span>
                )}
              </div>
              <div className="mt-2 text-[12px] text-ink-faint space-y-0.5">
                <div>
                  النماذج المكتشفة: {cache?.count ?? data.models.filter((m) => m.providerId === p.id).length}
                </div>
                <div>
                  آخر تحديث:{" "}
                  {cache?.updatedAt
                    ? new Date(cache.updatedAt).toLocaleString("ar", { hour12: false })
                    : "—"}
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void runAction("test", p.id)}
                  disabled={busy[testKey]}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink hover:border-primary/40 disabled:opacity-50"
                >
                  {busy[testKey] ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />}
                  اختبار الاتصال
                </button>
                <button
                  onClick={() => void runAction("refresh", p.id)}
                  disabled={busy[refreshKey]}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink hover:border-primary/40 disabled:opacity-50"
                >
                  {busy[refreshKey] ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  تحديث قائمة النماذج
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* المزوّد الافتراضي */}
      <section className="rounded-xl border border-line bg-raised p-4">
        <h2 className="text-[14px] text-ink-strong mb-2">المزوّد الافتراضي</h2>
        <div className="flex flex-wrap gap-2">
          {data.providers.map((p) => (
            <button
              key={p.id}
              disabled={saving}
              onClick={() => void patch({ defaultProvider: p.id })}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50 ${
                data.defaultProvider === p.id
                  ? "border-primary/50 bg-primary/10 text-ink-strong"
                  : "border-line bg-surface text-ink hover:border-primary/40"
              }`}
            >
              {p.displayName}
            </button>
          ))}
        </div>
      </section>

      {/* النموذج الافتراضي */}
      <section className="rounded-xl border border-line bg-raised p-4">
        <h2 className="text-[14px] text-ink-strong mb-2">النموذج الافتراضي</h2>
        {modelsOfDefault.length === 0 ? (
          <div className="text-[12.5px] text-ink-faint">لا توجد نماذج لهذا المزوّد.</div>
        ) : (
          <div className="space-y-1.5">
            {modelsOfDefault.map((m) => {
              const selectable = m.available && m.allowed;
              return (
                <button
                  key={m.id}
                  disabled={saving || !selectable}
                  onClick={() => void patch({ defaultModel: m.id })}
                  title={!selectable ? "غير متاح أو خارج القائمة المسموحة" : undefined}
                  className={`w-full text-start rounded-lg border px-3 py-2 transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                    data.defaultModel === m.id
                      ? "border-primary/50 bg-primary/10"
                      : "border-line bg-surface hover:border-primary/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-ink-strong truncate">{m.name}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10.5px] ${
                        selectable ? toneClass("ok") : toneClass("warn")
                      }`}
                    >
                      {selectable ? "متاح" : "غير متاح"}
                    </span>
                  </div>
                  <div className="text-[10.5px] text-ink-faint mt-0.5">{m.provider}</div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* النماذج المسموحة */}
      <section className="rounded-xl border border-line bg-raised p-4">
        <h2 className="text-[14px] text-ink-strong mb-1">النماذج المسموحة</h2>
        <p className="text-[12px] text-ink-faint mb-3">
          {data.allowedModels === null
            ? "بلا تقييد — كل النماذج المهيّأة متاحة للمستخدمين."
            : `${data.allowedModels.length} نموذجًا مسموحًا.`}
        </p>
        <div className="space-y-1.5">
          {data.models.map((m) => (
            <label
              key={m.id}
              className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 cursor-pointer hover:border-primary/40"
            >
              <input
                type="checkbox"
                checked={m.allowed}
                disabled={saving}
                onChange={() => toggleAllowed(m.id)}
                className="accent-[var(--primary,#7c3aed)]"
              />
              <span className="text-[13px] text-ink-strong truncate flex-1">{m.name}</span>
              <span className="rounded px-1.5 py-0.5 text-[10px] bg-raised border border-line text-ink-faint">
                {m.provider}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 text-[11.5px] text-ink-faint">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            إزالة نموذج لا تمسحه من المحادثات القائمة — يصير غير متاح ويُطلب من المستخدم
            اختيار بديل.
          </span>
        </div>
      </section>

      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
        <CheckCircle2 size={13} />
        الإعدادات تُحفظ في platform_settings — بلا مفاتيح ولا عناوين.
      </div>
    </div>
  );
}
