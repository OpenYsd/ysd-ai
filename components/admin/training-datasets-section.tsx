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

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface DatasetRelease {
  id: string;
  version: string;
  status: string;
  sampleCount: number;
  createdAt: string;
  frozenAt: string | null;
  /**
   * ★ وصفٌ آمن للأثر — ولا مسار تخزين ولا بصمة ولا رابط.
   *
   * فالمسار يقول أين يقع كلامُ الناس، والبصمة لا تقول لقارئٍ شيئًا.
   * وما يحتاجه المشرف أن يعرف أنّ أثرًا قائم، وكم فيه، وكم يزن.
   */
  artifactStatus?: string | null;
  artifactSampleCount?: number | null;
  artifactByteSize?: number | null;
}

type Dialog = { phase: "closed" } | { phase: "confirm"; id: string };

type Action =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "preview"; eligible: number; examined: number; skipped: Record<string, number> }
  | { phase: "created"; version: string; sampleCount: number }
  | { phase: "frozen"; version: string; sampleCount: number }
  | { phase: "none" }
  | { phase: "artifact"; version: string; sampleCount: number; byteSize: number }
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

/** الحجم بالكيلوبايت — رقمٌ يفهمه قارئ، ولا بصمة ولا مسار */
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

const stamp = (iso: string | null) =>
  iso === null ? "—" : new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export function TrainingDatasetsSection({ releases }: { releases: DatasetRelease[] }) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action>({ phase: "idle" });
  const [frozen, setFrozen] = useState<Record<string, true>>({});
  const [madeArtifact, setMadeArtifact] = useState<Record<string, true>>({});
  const [dialog, setDialog] = useState<Dialog>({ phase: "closed" });

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

  useEffect(() => {
    if (dialog.phase === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setDialog({ phase: "closed" });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dialog.phase]);

  const createArtifact = useCallback(async (id: string) => {
    setDialog({ phase: "closed" });
    setAction({ phase: "busy" });
    try {
      const res = await fetch(`/api/admin/training-datasets/${id}/artifact`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setAction({ phase: "failed", reason: str(body?.reason) || "unknown" });
        return;
      }
      /** ★ ولا حالة نجاحٍ قبل أن يؤكّدها الخادم */
      setMadeArtifact((m) => ({ ...m, [id]: true }));
      setAction({
        phase: "artifact",
        version: str(body?.version),
        sampleCount: num(body?.sampleCount),
        byteSize: num(body?.byteSize),
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
      {action.phase === "artifact" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-emerald-400">
          {t("artifactSuccess")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "failed" && (
        <p role="alert" className="px-4 pt-3 text-[12px] text-red-400">
          {action.reason === "revalidation_failed" || action.reason === "release_invalid"
            ? action.reason === "release_invalid"
              ? t("artifactInvalid")
              : t("datasetsRevalidationFailed")
            : action.reason === "already_exists" || action.reason === "storage_conflict"
              ? t("artifactExists")
              : action.reason === "conflict" || action.reason === "not_draft"
                ? t("datasetsConflict")
                : action.reason === "not_frozen" || action.reason === "manifest_mismatch"
                  || action.reason === "upload_failed"
                  ? t("artifactFailed")
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
                  {(madeArtifact[r.id] || r.artifactStatus === "ready") && (
                    <span className="text-emerald-400" data-artifact-ready={r.id}>
                      · {t("artifactReady")}
                      {typeof r.artifactByteSize === "number" && (
                        <> · {t("artifactSize")}: {kb(r.artifactByteSize)}</>
                      )}
                    </span>
                  )}
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

              {/**
                * ★ ولا زرَّ أثرٍ إلا لمجمَّدٍ لا أثر له.
                *
                * المسوَّدة لا أثر لها، والمُبطَل كذلك، والذي له أثرٌ لا
                * يُستبدل. والخادم يردّ الثلاثة على كل حال.
                */}
              {(r.status === "frozen" || frozen[r.id]) &&
                !madeArtifact[r.id] &&
                r.artifactStatus !== "ready" && (
                  <button
                    type="button"
                    data-artifact-create={r.id}
                    disabled={busy}
                    onClick={() => setDialog({ phase: "confirm", id: r.id })}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised
                               border border-line hover:border-primary/40 transition-colors
                               focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  >
                    {t("artifactCreate")}
                  </button>
                )}
            </li>
          ))}
        </ul>
      )}

      {dialog.phase === "confirm" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t("artifactCancel")}
            tabIndex={-1}
            onClick={() => setDialog({ phase: "closed" })}
            className="absolute inset-0 bg-night/60 backdrop-blur-[2px] cursor-default"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="artifact-confirm-title"
            className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <h2 id="artifact-confirm-title" className="text-[14px] font-medium text-ink-strong">
              {t("artifactConfirmTitle")}
            </h2>
            <p className="text-[12.5px] text-ink-dim mt-3 leading-relaxed">
              {t("artifactConfirmBody")}
            </p>
            {/**
              * ★ وما هو الأثر يُقال قبل القرار لا بعده.
              *
              * فمن يقرأ «إنشاء أثر تدريب» بلا شرحٍ يظنّ أن تدريبًا يبدأ.
              */}
            <p className="text-[12px] text-ink-faint mt-2.5 leading-relaxed">
              {t("artifactMeaning")}
            </p>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                type="button"
                data-artifact-cancel=""
                onClick={() => setDialog({ phase: "closed" })}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {t("artifactCancel")}
              </button>
              <button
                type="button"
                data-artifact-confirm=""
                disabled={busy}
                onClick={() => void createArtifact(dialog.id)}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                           hover:border-primary/40 transition-colors focus:outline-none
                           focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {t("artifactConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
