"use client";

/**
 * مراجعة بنك تحسين YSD (v0.9.5، المرحلة 2B).
 *
 * ── ما تعنيه «معتمَدة» هنا ──
 *
 * أن العيّنة **مرشَّحة للنظر** في مجموعة تدريبٍ مستقبلية. لا أنها دخلت
 * مجموعة، ولا أن نموذجًا دُرِّب، ولا أن شيئًا صُدِّر. والنصّ في الواجهة
 * يقول ذلك في كل موضع — لأن مراجِعًا يظنّ أنه «يُدرّب» يراجع بخفّةٍ أو
 * بثقلٍ في غير محلّهما.
 *
 * ── ولا حالة نجاحٍ قبل أن يؤكّدها الخادم ──
 *
 * القرار يُعاد التحقّق منه في الخادم لحظة تنفيذه: قد يكون صاحب العيّنة
 * سحب إذنه أو عدّل رسالته بين فتح الشاشة وضغط الزرّ. فما تعرضه الشاشة
 * وصفُ لحظةٍ مضت، ولا يُعلَن قرارٌ إلا بعد أن يقع.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export interface CandidateSummary {
  id: string;
  createdAt: string;
  status: string;
  privacyStatus: string;
  qualityStatus: string;
  source: string;
}

interface ReviewBody {
  ok?: unknown;
  reason?: unknown;
  approvable?: unknown;
  blockers?: unknown;
  redacted?: unknown;
  userText?: unknown;
  assistantText?: unknown;
}

type Panel =
  | { phase: "closed" }
  | { phase: "loading"; id: string }
  | {
      phase: "ready";
      id: string;
      approvable: boolean;
      blockers: string[];
      redacted: boolean;
      userText: string;
      assistantText: string;
    }
  | { phase: "invalid"; id: string; reason: string }
  | { phase: "sending"; id: string }
  | { phase: "done"; status: string }
  | { phase: "failed"; reason: string };

type Decision = "approve" | "reject_privacy" | "reject_quality";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function TrainingReviewView({
  counts,
  pending,
}: {
  counts: Record<string, number>;
  pending: CandidateSummary[];
}) {
  const { t, locale } = useI18n();
  const ar = locale === "ar";
  const [panel, setPanel] = useState<Panel>({ phase: "closed" });
  const [decided, setDecided] = useState<Record<string, string>>({});
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setPanel({ phase: "closed" });
    openerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (panel.phase === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [panel.phase, close]);

  const open = useCallback(async (id: string) => {
    setPanel({ phase: "loading", id });
    try {
      const res = await fetch(`/api/admin/training-candidates/${id}/review`);
      if (!res.ok) throw new Error("review_failed");
      const body = (await res.json()) as ReviewBody;
      if (body.ok !== true) {
        setPanel({ phase: "invalid", id, reason: str(body.reason) || "unknown" });
        return;
      }
      setPanel({
        phase: "ready",
        id,
        approvable: body.approvable === true,
        blockers: list(body.blockers),
        redacted: body.redacted === true,
        userText: str(body.userText),
        assistantText: str(body.assistantText),
      });
    } catch {
      setPanel({ phase: "failed", reason: "network" });
    }
  }, []);

  const decide = useCallback(
    async (id: string, decision: Decision) => {
      setPanel({ phase: "sending", id });
      try {
        const res = await fetch(`/api/admin/training-candidates/${id}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ★ كلمةٌ واحدة — والحقول يملكها الخادم
          body: JSON.stringify({ decision }),
        });
        const body = (await res.json().catch(() => null)) as { status?: unknown; reason?: unknown } | null;
        if (!res.ok) {
          setPanel({ phase: "failed", reason: str(body?.reason) || "unknown" });
          return;
        }
        const status = str(body?.status);
        setDecided((m) => ({ ...m, [id]: status }));
        setPanel({ phase: "done", status });
      } catch {
        setPanel({ phase: "failed", reason: "network" });
      }
    },
    [],
  );

  const busy = panel.phase === "loading" || panel.phase === "sending";
  const rows = pending.filter((c) => decided[c.id] === undefined);

  return (
    <div className="px-4 md:px-6 py-5 space-y-5">
      <div>
        <h1 className="text-[18px] font-semibold">{t("trainingBankTitle")}</h1>
        <p className="text-[12.5px] text-ink-dim mt-1">{t("trainingBankSubtitle")}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(["pending", "approved", "rejected_privacy", "rejected_quality", "revoked"] as const).map(
          (k) => (
            <div key={k} className="rounded-xl border border-line/60 bg-surface/40 px-4 py-3">
              <div className="text-[12px] text-ink-dim">{t(`trainingBankCount_${k}` as never)}</div>
              <div className="text-[22px] font-semibold mt-0.5 tabular-nums">{counts[k] ?? 0}</div>
            </div>
          ),
        )}
      </div>

      {/**
        * ★ «معتمَدة» ليست «مُدرَّبة».
        *
        * تُقال هنا لا في حاشيةٍ سفلية: من يقرأ عمود «معتمَدة» يقرأ رقمًا،
        * وما لم يُقل بجواره ما يعنيه، قرأه على معناه في اللغة العامّة.
        */}
      <p className="text-[11.5px] text-ink-faint">{t("trainingBankApprovedMeaning")}</p>

      <div className="rounded-xl border border-line/60 bg-surface/40 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-line/50 text-[13px] font-medium">
          {t("trainingBankPendingList")}
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-ink-dim">{t("trainingBankEmpty")}</div>
        ) : (
          <ul className="divide-y divide-line/40">
            {rows.map((c) => (
              <li key={c.id} className="px-4 py-3 flex items-center justify-between gap-3">
                {/**
                  * ★ بياناتٌ وصفية آمنة وحدها.
                  *
                  * لا بريد، ولا معرّف مستخدم، ولا عنوان محادثة — فالعناوين
                  * تُولَّد من أول رسالة، أي أنها نصُّ المستخدم نفسه. ولا
                  * بصمة: أداةُ مقارنةٍ داخلية لا تُفيد قارئًا.
                  */}
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-strong tabular-nums">
                    {new Date(c.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                  </div>
                  <div className="text-[11.5px] text-ink-faint mt-0.5 flex flex-wrap gap-x-2">
                    <span>{c.source}</span>
                    <span>· {t(`trainingBankPrivacy_${c.privacyStatus}` as never)}</span>
                    <span>· {t(`trainingBankQuality_${c.qualityStatus}` as never)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  data-training-review-open={c.id}
                  disabled={busy}
                  onClick={(e) => {
                    openerRef.current = e.currentTarget;
                    void open(c.id);
                  }}
                  className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                             hover:border-primary/40 transition-colors focus:outline-none
                             focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                >
                  {t("trainingBankReview")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {panel.phase !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t("trainingBankClose")}
            tabIndex={-1}
            onClick={close}
            className="absolute inset-0 bg-night/60 backdrop-blur-[2px] cursor-default"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-review-title"
            className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-line
                       bg-surface p-5 shadow-2xl"
          >
            <h2 id="training-review-title" className="text-[14px] font-medium text-ink-strong">
              {t("trainingBankReviewTitle")}
            </h2>

            {panel.phase === "loading" && (
              <p className="text-[12.5px] text-ink-dim mt-3">{t("trainingBankLoading")}</p>
            )}

            {panel.phase === "invalid" && (
              <p role="status" className="text-[12.5px] text-amber-400 mt-3 leading-relaxed">
                {panel.reason === "source_changed"
                  ? t("trainingBankSourceChanged")
                  : t("trainingBankSourceUnavailable")}
              </p>
            )}

            {(panel.phase === "ready" || panel.phase === "sending") && (
              <>
                {/**
                  * ★ التحذير قبل النصّ لا بعده.
                  *
                  * فمن قرأ ثم حُذِّر قد يكون قرأ ما لم يكن ينبغي أن يقرأه
                  * بلا انتباه. والتحذير قبله يجعل القراءة نفسها منتبهة.
                  */}
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10
                              px-3 py-2.5 text-[12px] text-amber-300 leading-relaxed">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  <span>{t("trainingBankPrivacyWarning")}</span>
                </p>

                {panel.phase === "ready" && panel.redacted && (
                  <p className="text-[11.5px] text-ink-faint mt-2">{t("trainingBankRedacted")}</p>
                )}

                {panel.phase === "ready" && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-line/60 bg-raised/40 p-3">
                      <div className="text-[11px] text-ink-faint mb-1.5">
                        {t("trainingBankUserMessage")}
                      </div>
                      <p className="text-[12.5px] text-ink whitespace-pre-wrap break-words">
                        {panel.userText}
                      </p>
                    </div>
                    <div className="rounded-xl border border-line/60 bg-raised/40 p-3">
                      <div className="text-[11px] text-ink-faint mb-1.5">
                        {t("trainingBankAssistantMessage")}
                      </div>
                      <p className="text-[12.5px] text-ink whitespace-pre-wrap break-words">
                        {panel.assistantText}
                      </p>
                    </div>
                  </div>
                )}

                {panel.phase === "ready" && !panel.approvable && (
                  <p role="status" className="text-[12px] text-amber-400 mt-3 leading-relaxed">
                    {panel.blockers.includes("privacy_finding")
                      ? t("trainingBankPrivacyBlocked")
                      : t("trainingBankQualityBlocked")}
                  </p>
                )}
              </>
            )}

            {panel.phase === "done" && (
              <p role="status" className="text-[12.5px] text-emerald-400 mt-3 leading-relaxed">
                {panel.status === "approved"
                  ? t("trainingBankApproved")
                  : t("trainingBankRejected")}
              </p>
            )}

            {panel.phase === "failed" && (
              <p role="alert" className="text-[12.5px] text-red-400 mt-3 leading-relaxed">
                {panel.reason === "conflict" || panel.reason === "already_decided"
                  ? t("trainingBankConflict")
                  : t("trainingBankFailed")}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 mt-5">
              <button
                type="button"
                data-training-review-close=""
                onClick={close}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {t("trainingBankClose")}
              </button>

              {(panel.phase === "ready" || panel.phase === "sending") && (
                <>
                  <button
                    type="button"
                    data-training-reject-quality=""
                    disabled={busy}
                    onClick={() => void decide(panel.id, "reject_quality")}
                    className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink bg-raised border border-line
                               hover:border-primary/40 transition-colors focus:outline-none
                               focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  >
                    {t("trainingBankRejectQuality")}
                  </button>
                  <button
                    type="button"
                    data-training-reject-privacy=""
                    disabled={busy}
                    onClick={() => void decide(panel.id, "reject_privacy")}
                    className="rounded-lg px-3 py-1.5 text-[12.5px] text-amber-300 bg-raised border border-amber-500/40
                               hover:border-amber-400 transition-colors focus:outline-none
                               focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                  >
                    {t("trainingBankRejectPrivacy")}
                  </button>
                  {/**
                    * ★ ولا زرَّ اعتمادٍ فوق مانعٍ حتميّ.
                    *
                    * إخفاؤه ليس تجميلًا: زرٌّ يُعرض ثم يُردّ يعلّم صاحبه أن
                    * الرفض عطبٌ يُعاد معه المحاولة. وغيابُه يقول إن هذا ليس
                    * قرارًا متاحًا. والخادم يردّه على كل حال.
                    */}
                  {panel.phase === "ready" && panel.approvable && (
                    <button
                      type="button"
                      data-training-approve=""
                      disabled={busy}
                      onClick={() => void decide(panel.id, "approve")}
                      className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                                 hover:border-primary/40 transition-colors focus:outline-none
                                 focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
                    >
                      {t("trainingBankApprove")}
                    </button>
                  )}
                </>
              )}
            </div>

            {(panel.phase === "ready" || panel.phase === "sending") && (
              <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
                {ar
                  ? "الاعتماد لا يُدخل العيّنة في تدريب ولا يُصدّرها."
                  : "Approval does not train on the sample or export it."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
