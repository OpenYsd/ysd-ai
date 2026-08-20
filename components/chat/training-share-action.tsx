"use client";

/**
 * «شارك هذه المحادثة لتحسين YSD» (v0.9.5، المرحلة 2A).
 *
 * ── الإذن ليس مشاركة، والمشاركة ليست تدريبًا ──
 *
 * ثلاث مراتب لا تُختصر واحدةٌ منها في الأخرى: أذِن في الإعدادات، ثم اختار
 * محادثةً بعينها، ثم تدخل الأجزاء المؤهّلة **موقوفةً** بانتظار فحص. ونصّ
 * كل حالةٍ هنا يقول أيّ مرتبةٍ بلغناها — ولا يقول «تم تدريب YSD» أبدًا،
 * لأن ذلك لم يقع، ولأن قوله يجعل صاحبه يظنّ أن سحب إذنه لم يعد يُجدي.
 *
 * ── ولماذا تُقرأ الموافقة عند الفتح لا عند التركيب ──
 *
 * قراءتها مع كل محادثة تُنفق طلبًا على سؤالٍ لم يُطرح بعد. وقراءتها بعد
 * التأكيد تجعل المستخدم يؤكّد ثم يُقال له إنه غير مأذون — وذلك أسوأ ترتيب.
 * فتُقرأ حين يفتح الحوار: عندها صار السؤال قائمًا، ولمّا يُتّخذ القرار.
 *
 * والخادم يبقى هو الحكم على كل حال: هذه القراءة إرشادٌ لا حراسة.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface ShareResponse {
  created?: unknown;
  duplicates?: unknown;
  beforeConsent?: unknown;
}

type Dialog =
  | { phase: "closed" }
  | { phase: "checking" }
  | { phase: "confirm" }
  | { phase: "consentRequired" }
  | { phase: "sending" }
  | { phase: "done"; created: number; beforeConsent: number }
  | { phase: "error" };

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function TrainingShareAction({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<Dialog>({ phase: "closed" });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setDialog({ phase: "closed" });
    openerRef.current?.focus();
  }, []);

  // Escape يغلق — كنمط اللوحات القائمة في هذا المسار
  useEffect(() => {
    if (dialog.phase === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dialog.phase, close]);

  const open = useCallback(async () => {
    setDialog({ phase: "checking" });
    try {
      const res = await fetch("/api/training-consent", { method: "GET" });
      if (!res.ok) throw new Error("unavailable");
      const body = (await res.json()) as { active?: unknown };
      /**
       * ★ `active` لا `enabled`.
       *
       * موافقةٌ أُعطيت لنصٍّ قديم ليست موافقةً على الحاليّ. والخادم يقيس
       * السريان لا العَلَم، فلتقس الواجهة بما يقيس به — وإلّا عرضنا تأكيدًا
       * سيرفضه الخادم بعد ضغطة.
       */
      setDialog(body.active === true ? { phase: "confirm" } : { phase: "consentRequired" });
    } catch {
      // ★ الفشل مغلق: لا يُفترض إذنٌ لم يُقرأ
      setDialog({ phase: "consentRequired" });
    }
  }, []);

  const confirm = useCallback(async () => {
    setDialog({ phase: "sending" });
    try {
      const res = await fetch(`/api/conversations/${conversationId}/training-share`, {
        method: "POST",
      });
      if (res.status === 403) {
        setDialog({ phase: "consentRequired" });
        return;
      }
      if (!res.ok) throw new Error("share_failed");
      const body = (await res.json()) as ShareResponse;
      /**
       * ★ لا حالةَ نجاحٍ قبل أن يؤكّدها الخادم.
       *
       * «تمت المشاركة» تُقرأ إقرارًا بأن شيئًا انتقل. فإن كُتبت عند الضغط
       * ثم تعثّرت الشبكة، بقي في ذهن صاحبها أنه شارك ولم يشارك — وهذا نوعٌ
       * من الكذب لا يُصلحه تراجعُ الحالة بعد لحظة.
       */
      setDialog({
        phase: "done",
        created: count(body.created),
        beforeConsent: count(body.beforeConsent),
      });
    } catch {
      setDialog({ phase: "error" });
    }
  }, [conversationId]);

  const busy = dialog.phase === "checking" || dialog.phase === "sending";

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        data-training-share-open=""
        onClick={() => void open()}
        disabled={busy}
        title={t("shareForTraining")}
        aria-label={t("shareForTraining")}
        className="rounded-lg p-1.5 text-ink-faint hover:text-ink hover:bg-raised transition-colors
                   focus:outline-none focus:ring-2 focus:ring-primary/50
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Share2 size={15} />
      </button>

      {dialog.phase !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t("shareForTrainingCancel")}
            tabIndex={-1}
            onClick={close}
            className="absolute inset-0 bg-night/60 backdrop-blur-[2px] cursor-default"
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-share-title"
            className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <h2 id="training-share-title" className="text-[14px] font-medium text-ink-strong">
              {t("shareForTrainingConfirmTitle")}
            </h2>

            {(dialog.phase === "checking" ||
              dialog.phase === "confirm" ||
              dialog.phase === "sending") && (
              <>
                <p className="text-[12.5px] text-ink-dim mt-3 leading-relaxed">
                  {t("shareForTrainingConfirmBody")}
                </p>
                {/**
                  * ★ الملاحظة تُعرض **قبل** القرار لا بعده.
                  *
                  * فمن يقرأ قبل أن يضغط أحقّ بها ممن ضغط. وتأخيرها إلى شاشة
                  * النتيجة يجعلها اعتذارًا عن فعلٍ وقع، لا معلومةً تسبقه.
                  */}
                <p className="text-[12px] text-ink-faint mt-2.5 leading-relaxed">
                  {t("shareForTrainingConfirmNote")}
                </p>
              </>
            )}

            {dialog.phase === "consentRequired" && (
              <p role="status" className="text-[12.5px] text-ink-dim mt-3 leading-relaxed">
                {t("shareForTrainingConsentRequired")}
              </p>
            )}

            {dialog.phase === "done" && (
              <div role="status" className="mt-3">
                <p className="text-[12.5px] text-ink-dim leading-relaxed">
                  {dialog.created > 0
                    ? t("shareForTrainingSuccess")
                    : t("shareForTrainingNothingNew")}
                </p>
                {dialog.beforeConsent > 0 && (
                  <p className="text-[12px] text-ink-faint mt-2">
                    {t("shareForTrainingOlderSkipped")}
                  </p>
                )}
              </div>
            )}

            {dialog.phase === "error" && (
              <p role="alert" className="text-[12.5px] text-red-400 mt-3">
                {t("shareForTrainingError")}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                type="button"
                data-training-share-cancel=""
                onClick={close}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised
                           transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {dialog.phase === "done" || dialog.phase === "consentRequired"
                  ? t("shareForTrainingClose")
                  : t("shareForTrainingCancel")}
              </button>
              {(dialog.phase === "checking" ||
                dialog.phase === "confirm" ||
                dialog.phase === "sending" ||
                dialog.phase === "error") && (
                <button
                  type="button"
                  data-training-share-confirm=""
                  onClick={() => void confirm()}
                  disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-strong bg-raised border border-line
                             hover:border-primary/40 transition-colors focus:outline-none
                             focus:ring-2 focus:ring-primary/50
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("shareForTrainingConfirmAction")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
