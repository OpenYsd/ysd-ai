"use client";

/**
 * إصدارات مجموعة التدريب — القسم الإداريّ (v0.9.6، المرحلة 3A).
 *
 * ── ما يعرضه ──
 *
 * وصفٌ آمن: الرقم، والحالة، وعدد العيّنات، والتواريخ. ولا محتوى عيّنةٍ
 * إطلاقًا — النصّ يبقى في شاشة مراجعة المرشّحين وحدها، حيث يُعرض بتحذيرٍ
 * ولغرضٍ محدّد. وصفحةٌ تعرض عشرات العيّنات لأجل «نظرةٍ عامّة» تكشف بلا
 * سبب.
 *
 * ── ولا بصمة ──
 *
 * بصمة البيان أداةُ مقارنةٍ خادميّة. وعرضُها يجعلها قيمةً في الشبكة، ولا
 * تقول لقارئٍ شيئًا لا يقوله عدد العيّنات.
 */

import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface DatasetRelease {
  id: string;
  version: string;
  status: string;
  sampleCount: number;
  createdAt: string;
  frozenAt: string | null;
}

type Action =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "preview"; eligible: number; examined: number; skipped: Record<string, number> }
  | { phase: "created"; version: string; sampleCount: number }
  | { phase: "frozen"; version: string; sampleCount: number }
  | { phase: "none" }
  | { phase: "failed"; reason: string };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const counts = (v: unknown): Record<string, number> => {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
};

const stamp = (iso: string | null) =>
  iso === null ? "—" : new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export function TrainingDatasetsSection({ releases }: { releases: DatasetRelease[] }) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action>({ phase: "idle" });
  const [frozen, setFrozen] = useState<Record<string, true>>({});

  const busy = action.phase === "busy";

  const preview = useCallback(async () => {
    setAction({ phase: "busy" });
    try {
      const res = await fetch("/api/admin/training-datasets");
      if (!res.ok) throw new Error("preview_failed");
      const body = (await res.json()) as Record<string, unknown>;
      setAction({
        phase: "preview",
        eligible: num(body.eligible),
        examined: num(body.examined),
        skipped: counts(body.skipped),
      });
    } catch {
      setAction({ phase: "failed", reason: "network" });
    }
  }, []);

  const createDraft = useCallback(async () => {
    setAction({ phase: "busy" });
    try {
      const res = await fetch("/api/admin/training-datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // ★ جسمٌ فارغ — لا معرّفات، ولا عدد، ولا بصمة، ولا حالة
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 409 && str(body?.reason) === "no_eligible_candidates") {
        setAction({ phase: "none" });
        return;
      }
      if (!res.ok) throw new Error("create_failed");
      setAction({
        phase: "created",
        version: str(body?.version),
        sampleCount: num(body?.sampleCount),
      });
    } catch {
      setAction({ phase: "failed", reason: "network" });
    }
  }, []);

  const freeze = useCallback(async (id: string) => {
    setAction({ phase: "busy" });
    try {
      const res = await fetch(`/api/admin/training-datasets/${id}/freeze`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setAction({ phase: "failed", reason: str(body?.reason) || "unknown" });
        return;
      }
      setFrozen((m) => ({ ...m, [id]: true }));
      setAction({
        phase: "frozen",
        version: str(body?.version),
        sampleCount: num(body?.sampleCount),
      });
    } catch {
      setAction({ phase: "failed", reason: "network" });
    }
  }, []);

  return (
    <div className="rounded-xl border border-line/60 bg-surface/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line/50 flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{t("datasetsSection")}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-dataset-preview=""
            disabled={busy}
            onClick={() => void preview()}
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                       hover:border-primary/40 transition-colors focus:outline-none
                       focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          >
            {t("datasetsPreview")}
          </button>
          <button
            type="button"
            data-dataset-create=""
            disabled={busy}
            onClick={() => void createDraft()}
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                       hover:border-primary/40 transition-colors focus:outline-none
                       focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
          >
            {t("datasetsCreateDraft")}
          </button>
        </div>
      </div>

      <p className="px-4 pt-3 text-[11.5px] text-ink-faint leading-relaxed">
        {t("datasetsMeaning")}
      </p>

      {action.phase === "preview" && (
        <div role="status" className="px-4 pt-3 text-[12px] text-ink-dim">
          <span className="tabular-nums">
            {t("datasetsEligible")}: {action.eligible} / {action.examined}
          </span>
          {Object.keys(action.skipped).length > 0 && (
            <span className="text-ink-faint">
              {" · "}
              {t("datasetsSkipped")}:{" "}
              {Object.entries(action.skipped)
                .map(([k, n]) => `${k}=${n}`)
                .join(" · ")}
            </span>
          )}
        </div>
      )}

      {action.phase === "none" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-ink-dim">
          {t("datasetsNoEligible")}
        </p>
      )}
      {action.phase === "created" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-emerald-400">
          {t("datasetsCreated_ok")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "frozen" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-emerald-400">
          {t("datasetsFrozen_ok")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "failed" && (
        <p role="alert" className="px-4 pt-3 text-[12px] text-red-400">
          {action.reason === "revalidation_failed"
            ? t("datasetsRevalidationFailed")
            : action.reason === "conflict" || action.reason === "not_draft"
              ? t("datasetsConflict")
              : t("datasetsFailed")}
        </p>
      )}

      {releases.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-ink-dim">{t("datasetsEmpty")}</div>
      ) : (
        <ul className="divide-y divide-line/40 mt-3">
          {releases.map((r) => (
            <li key={r.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] text-ink-strong tabular-nums">{r.version}</div>
                <div className="text-[11.5px] text-ink-faint mt-0.5 flex flex-wrap gap-x-2">
                  <span>{t(`datasetStatus_${frozen[r.id] ? "frozen" : r.status}` as never)}</span>
                  <span>
                    · {t("datasetsSamples")}: <span className="tabular-nums">{r.sampleCount}</span>
                  </span>
                  <span>· {t("datasetsCreated")}: {stamp(r.createdAt)}</span>
                  {r.frozenAt && <span>· {t("datasetsFrozen")}: {stamp(r.frozenAt)}</span>}
                </div>
              </div>
              {/**
                * ★ ولا زرَّ تجميدٍ لغير المسوَّدة.
                *
                * والخادم يردّه على كل حال — لكن زرًّا يُعرض ثم يُردّ يعلّم
                * صاحبه أن الرفض عطبٌ يُعاد معه المحاولة.
                */}
              {r.status === "draft" && !frozen[r.id] && (
                <button
                  type="button"
                  data-dataset-freeze={r.id}
                  disabled={busy}
                  onClick={() => void freeze(r.id)}
                  className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                             hover:border-primary/40 transition-colors focus:outline-none
                             focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                >
                  {t("datasetsFreeze")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
