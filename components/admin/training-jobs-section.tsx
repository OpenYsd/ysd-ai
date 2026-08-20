"use client";

/**
 * مهامّ التدريب — القسم الإداريّ (v0.9.8، المرحلة 4A).
 *
 * ── ما يعرضه ──
 *
 * قرارًا لا بيانات: أيّ مجموعة، وأيّ نموذجٍ أساسيّ، وبأيّ أرقام. ولا نصَّ
 * عيّنةٍ، ولا مسار تخزين، ولا بصمةَ أثرٍ ولا مواصفة، ولا هوّية صاحب بيانات.
 *
 * ── و«مُجهَّزة» ليست «تُدرَّب» ──
 *
 * تُشرح حيث تُقرأ لا في حاشية: من يرى الكلمة وحدها يظنّ أن شيئًا انطلق.
 * وما يعنيه أن المواصفة ثبتت — ويبقى فحصٌ جديد قبل أيّ تسليم.
 */

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface TrainingJobRow {
  id: string;
  version: string;
  status: string;
  baseModelId: string;
  presetId: string;
  method: string;
  seed: number;
  datasetVersion: string | null;
  sampleCount: number | null;
  createdAt: string;
  preparedAt: string | null;
}

export interface ArtifactChoice {
  artifactId: string;
  datasetVersion: string;
  sampleCount: number;
}

export interface BaseModelChoice {
  id: string;
  family: string;
  source: string;
  pinned: boolean;
}

type Dialog = { phase: "closed" } | { phase: "confirm"; artifactId: string };

type Action =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "created"; version: string }
  | { phase: "prepared"; version: string }
  | { phase: "cancelled"; version: string }
  | { phase: "failed"; reason: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const stamp = (iso: string | null) =>
  iso === null ? "—" : new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export function TrainingJobsSection({
  jobs,
  artifacts,
  baseModels,
  presets,
}: {
  jobs: TrainingJobRow[];
  artifacts: ArtifactChoice[];
  baseModels: BaseModelChoice[];
  presets: string[];
}) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action>({ phase: "idle" });
  const [dialog, setDialog] = useState<Dialog>({ phase: "closed" });
  const [baseModelId, setBaseModelId] = useState(
    baseModels.find((m) => m.pinned)?.id ?? "",
  );
  const [presetId, setPresetId] = useState(presets[0] ?? "");
  const [moved, setMoved] = useState<Record<string, string>>({});

  const busy = action.phase === "busy";

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

  const create = useCallback(
    async (artifactId: string) => {
      setDialog({ phase: "closed" });
      setAction({ phase: "busy" });
      try {
        const res = await fetch("/api/admin/training-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          /** ★ ثلاثة معرّفات — ولا رقمَ واحد */
          body: JSON.stringify({ artifactId, baseModelId, presetId }),
        });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!res.ok) {
          setAction({ phase: "failed", reason: str(body?.reason) || "unknown" });
          return;
        }
        /** ★ ولا حالة نجاحٍ قبل أن يؤكّدها الخادم */
        setAction({ phase: "created", version: str(body?.version) });
      } catch {
        setAction({ phase: "failed", reason: "network" });
      }
    },
    [baseModelId, presetId],
  );

  const act = useCallback(async (id: string, what: "prepare" | "cancel") => {
    setAction({ phase: "busy" });
    try {
      const res = await fetch(`/api/admin/training-jobs/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: what }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setAction({ phase: "failed", reason: str(body?.reason) || "unknown" });
        return;
      }
      const status = str(body?.status);
      setMoved((m) => ({ ...m, [id]: status }));
      setAction(
        what === "prepare"
          ? { phase: "prepared", version: str(body?.version) }
          : { phase: "cancelled", version: str(body?.version) },
      );
    } catch {
      setAction({ phase: "failed", reason: "network" });
    }
  }, []);

  return (
    <div className="rounded-xl border border-line/60 bg-surface/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line/50 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] font-medium">{t("jobsSection")}</span>
        {artifacts.length > 0 && baseModels.some((m) => m.pinned) && (
          <div className="flex flex-wrap items-center gap-2">
            {/**
              * ★ اختيارٌ من قائمة — لا حقلٌ يُكتب فيه.
              *
              * فحقلٌ حرٌّ لاسم نموذجٍ أساسيّ يجعل مصدر الأوزان شيئًا يختاره
              * من يفتح الصفحة. والقائمة من الخادم، والخادم يردّ ما ليس فيها.
              */}
            <select
              data-job-base-model=""
              value={baseModelId}
              disabled={busy}
              onChange={(e) => setBaseModelId(e.target.value)}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                         focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            >
              {/**
                * ★ وغير المثبَّت يُعرض معطَّلًا لا يُخفى.
                *
                * فإخفاؤه يجعل المشرف لا يعرف أنه موجود ولا لماذا لا يُختار.
                * وعرضُه بحاله يقول: هذا نموذج، ولم يُتحقَّق من هوّية أوزانه.
                */}
              {baseModels.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.pinned}>
                  {m.id} — {m.pinned ? t("jobsPinned") : t("jobsUnpinned")}
                </option>
              ))}
            </select>
            <select
              data-job-preset=""
              value={presetId}
              disabled={busy}
              onChange={(e) => setPresetId(e.target.value)}
              className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                         focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            >
              {presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-job-create=""
              disabled={busy}
              onClick={() => setDialog({ phase: "confirm", artifactId: artifacts[0]!.artifactId })}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                         hover:border-primary/40 transition-colors focus:outline-none
                         focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            >
              {t("jobsCreate")}
            </button>
          </div>
        )}
      </div>

      <p className="px-4 pt-3 text-[11.5px] text-ink-faint leading-relaxed">{t("jobsMeaning")}</p>
      {baseModels.some((m) => !m.pinned) && (
        <p className="px-4 pt-1.5 text-[11.5px] text-ink-faint leading-relaxed">
          {t("jobsUnpinnedNote")}
        </p>
      )}
      <p className="px-4 pt-1.5 text-[11.5px] text-ink-faint leading-relaxed">
        {t("jobsPreparedMeaning")}
      </p>

      {action.phase === "created" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-emerald-400">
          {t("jobsCreatedOk")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "prepared" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-emerald-400">
          {t("jobsPreparedOk")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "cancelled" && (
        <p role="status" className="px-4 pt-3 text-[12px] text-ink-dim">
          {t("jobsCancelledOk")} <span className="tabular-nums">{action.version}</span>
        </p>
      )}
      {action.phase === "failed" && (
        <p role="alert" className="px-4 pt-3 text-[12px] text-red-400">
          {action.reason === "base_model_unpinned"
            ? t("jobsUnpinnedError")
            : action.reason === "artifact_invalid"
            ? t("jobsArtifactInvalid")
            : action.reason === "conflict" || action.reason === "not_draft"
              ? t("jobsConflict")
              : t("jobsFailed")}
        </p>
      )}

      {jobs.length === 0 ? (
        <div className="px-4 py-6 text-[13px] text-ink-dim">{t("jobsEmpty")}</div>
      ) : (
        <ul className="divide-y divide-line/40 mt-3">
          {jobs.map((j) => {
            const status = moved[j.id] ?? j.status;
            return (
              <li key={j.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-strong tabular-nums">{j.version}</div>
                  <div className="text-[11.5px] text-ink-faint mt-0.5 flex flex-wrap gap-x-2">
                    <span>{t(`jobStatus_${status}` as never)}</span>
                    <span>· {t("jobsBaseModel")}: {j.baseModelId}</span>
                    <span>· {t("jobsMethod")}: {j.method}</span>
                    <span>· {t("jobsPreset")}: {j.presetId}</span>
                    <span>· {t("jobsSeed")}: <span className="tabular-nums">{j.seed}</span></span>
                  </div>
                  <div className="text-[11.5px] text-ink-faint mt-0.5 flex flex-wrap gap-x-2">
                    {j.datasetVersion && <span>{t("jobsDataset")}: {j.datasetVersion}</span>}
                    {typeof j.sampleCount === "number" && (
                      <span>· {t("jobsSamples")}: <span className="tabular-nums">{j.sampleCount}</span></span>
                    )}
                    <span>· {t("jobsCreated")}: {stamp(j.createdAt)}</span>
                    {j.preparedAt && <span>· {t("jobsPrepared")}: {stamp(j.preparedAt)}</span>}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {status === "draft" && (
                    <button
                      type="button"
                      data-job-prepare={j.id}
                      disabled={busy}
                      onClick={() => void act(j.id, "prepare")}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                                 hover:border-primary/40 transition-colors focus:outline-none
                                 focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                    >
                      {t("jobsPrepareAction")}
                    </button>
                  )}
                  {status !== "cancelled" && (
                    <button
                      type="button"
                      data-job-cancel={j.id}
                      disabled={busy}
                      onClick={() => void act(j.id, "cancel")}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim bg-raised border border-line
                                 hover:border-primary/40 transition-colors focus:outline-none
                                 focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                    >
                      {t("jobsCancelAction")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog.phase === "confirm" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t("jobsCancel")}
            tabIndex={-1}
            onClick={() => setDialog({ phase: "closed" })}
            className="absolute inset-0 bg-night/60 backdrop-blur-[2px] cursor-default"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-confirm-title"
            className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <h2 id="job-confirm-title" className="text-[14px] font-medium text-ink-strong">
              {t("jobsConfirmTitle")}
            </h2>
            <p className="text-[12.5px] text-ink-dim mt-3 leading-relaxed">{t("jobsConfirmBody")}</p>
            {/**
              * ★ وما يُختار يُعرض قبل القرار.
              *
              * فمن يضغط «إنشاء» يستحقّ أن يرى على أيّ نموذجٍ وأيّ إعداد —
              * لا أن يكتشفه في السطر بعد أن وقع.
              */}
            <p className="text-[12px] text-ink-faint mt-2.5 leading-relaxed">
              {t("jobsBaseModel")}: {baseModelId} · {t("jobsPreset")}: {presetId}
            </p>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                type="button"
                data-job-cancel-dialog=""
                onClick={() => setDialog({ phase: "closed" })}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {t("jobsCancel")}
              </button>
              <button
                type="button"
                data-job-confirm=""
                disabled={busy}
                onClick={() => void create(dialog.artifactId)}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                           hover:border-primary/40 transition-colors focus:outline-none
                           focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {t("jobsConfirmAction")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
