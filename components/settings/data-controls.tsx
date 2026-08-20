"use client";

/**
 * ضوابط البيانات (v0.9.16، المرحلة 6E) — **فعلٌ مدمّر خلف بابين**.
 *
 * ── لماذا كتابة عبارة لا ضغطة تأكيد ──
 *
 * ضغطتان متتاليتان يفعلهما الإصبع بلا أن يقرأ العقل. وكتابةُ عبارةٍ تُجبر
 * صاحبها على أن يقرأ ما يفعله ويُعيد كتابته — وهي أرخص حاجزٍ يمنع ندمًا لا
 * رجعة فيه.
 *
 * والعبارة بلغة الواجهة: مطالبةُ من يقرأ العربية بكتابة `DELETE MY DATA`
 * حاجزٌ لغويّ لا حاجزُ تأكيد.
 *
 * ── ولماذا لا `window.confirm` ──
 *
 * لا يقبل نصًّا، ولا يعرض ما سيُحذف وما يبقى — وهو ما يجب أن يُقرأ هنا.
 *
 * ── والحوار حوارٌ فعلًا ──
 *
 * `role="dialog"` و`aria-modal` صحيحان هنا لأنه يحجب ما تحته ويُغلق
 * بـEscape ويعيد التركيز إلى فاتحه — على نمط لوحة المصدر القائمة.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { SUPPORT_PATH } from "@/lib/public-support";

type Phase = "idle" | "confirming" | "working" | "done" | "failed";

export function DataControls() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** يمنع الإرسال المكرّر داخل الدورة الواحدة — راجع `purge` */
  const submittingRef = useRef(false);
  const titleId = useId();
  const descId = useId();

  const phrase = t("deleteConfirmPhrase");
  const matches = typed.trim() === phrase;
  /**
   * ★ و«تمّ» يبقى الحوار مفتوحًا للحظته.
   *
   * فإغلاقُه فور النجاح يجعل المستخدم يرى الصفحة تُعاد تحميلها بلا أن
   * يقرأ أن ما طلبه وقع.
   */
  const open = phase !== "idle";

  const close = useCallback(() => {
    submittingRef.current = false;
    setPhase("idle");
    setTyped("");
    openerRef.current?.focus();
  }, []);

  /**
   * ★ Escape يُغلق **قبل التنفيذ** لا أثناءه.
   *
   * فإغلاقُ الحوار وسط طلبٍ جارٍ يُخفي نتيجته عن صاحبه، ويجعله يظنّ أنه
   * ألغى ما لا يُلغى.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phase === "working") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, phase, close]);

  useEffect(() => {
    if (phase === "confirming") inputRef.current?.focus();
  }, [phase]);

  const purge = useCallback(async () => {
    /**
     * ★ الحارس مرجعٌ لا حالة — وهذا فرقٌ كشفه اختبار.
     *
     * `phase` قيمةٌ مُغلقة على الرسم الحالي: ثلاث ضغطاتٍ في نفس الدورة
     * تقرأها كلُّها `"confirming"` لأن React لم يُعد الرسم بينها. فيمرّ
     * ثلاثةُ طلباتِ حذف. والمرجع يتغيّر في اللحظة نفسها، فيمنع الثانية.
     */
    if (submittingRef.current || !matches) return;
    submittingRef.current = true;
    setPhase("working");
    try {
      const res = await fetch("/api/account/purge-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // التأكيد وحده — والهوية من الجلسة، فلا معرّف في الجسم
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!res.ok) {
        /** ويُفكّ الحارس عند الفشل — وإلا صار الفشل نهائيًّا بلا إعادة */
        submittingRef.current = false;
        setPhase("failed");
        return;
      }
      setPhase("done");
      /**
       * ★ إعادةُ تحميلٍ كاملة بعد النجاح.
       *
       * فالمحادثات والمشاريع والملفّات التي يرسمها التطبيق الآن لم تعد
       * موجودة، وذاكرةُ الموجّه تحتفظ بها. وتنقّلٌ داخليّ يعرض ما حُذف.
       */
      window.location.assign("/chat");
    } catch {
      submittingRef.current = false;
      setPhase("failed");
    }
  }, [matches]);

  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow";

  return (
    <section
      data-data-controls=""
      className="rounded-2xl border border-red-500/25 bg-red-500/[0.04] p-5"
    >
      <h2 className="flex items-center gap-2 text-[13px] font-medium text-ink-strong mb-2">
        <AlertTriangle size={14} aria-hidden className="text-red-400" />
        {t("dataControlsTitle")}
      </h2>
      <p className="text-[12.5px] text-ink-dim leading-relaxed">{t("deleteMyDataIntro")}</p>

      <button
        ref={openerRef}
        type="button"
        onClick={() => setPhase("confirming")}
        data-open-purge=""
        className={`${focusRing} mt-4 inline-flex items-center gap-2 rounded-xl border border-red-500/40
                    px-4 py-2 text-[13px] text-red-300 transition-colors hover:bg-red-500/10`}
      >
        <Trash2 size={14} aria-hidden />
        {t("deleteMyData")}
      </button>

      {/* ═══ طلب حذف الحساب بالكامل — إلى الدعم، لا فعلٌ هنا ═══ */}
      <div className="mt-5 border-t border-line/60 pt-4">
        <p className="text-[12.5px] text-ink-dim leading-relaxed">
          {t("requestAccountDeletionHint")}
        </p>
        {/*
          ولا يحمل الرابط بريدًا ولا معرّفًا: ما يُوضع في عنوانٍ يُسجَّل في
          وكلاء وسجلّاتِ خوادم لا نملكها.
        */}
        <Link
          href={`${SUPPORT_PATH}?topic=account-deletion`}
          data-request-account-deletion=""
          className={`${focusRing} mt-2 inline-block rounded-lg text-[13px] text-primary-glow hover:brightness-125`}
        >
          {t("requestAccountDeletion")}
        </Link>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && phase !== "working") close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            data-purge-dialog=""
            className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <h3 id={titleId} className="text-[14.5px] font-semibold text-ink-strong">
              {t("deleteMyData")}
            </h3>

            <div id={descId} className="mt-3 space-y-3 text-[12.5px] leading-relaxed">
              <div>
                <p className="font-medium text-ink">{t("deleteWhatGoesTitle")}</p>
                <ul className="mt-1 list-disc ms-5 space-y-1 text-ink-dim">
                  <li>{t("deleteItemConversations")}</li>
                  <li>{t("deleteItemProjects")}</li>
                  <li>{t("deleteItemFiles")}</li>
                  <li>{t("deleteItemRag")}</li>
                  <li>{t("deleteItemTraining")}</li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-ink">{t("deleteWhatStaysTitle")}</p>
                <ul className="mt-1 list-disc ms-5 space-y-1 text-ink-dim">
                  <li>{t("deleteStaysAccount")}</li>
                  <li>{t("deleteStaysUsage")}</li>
                </ul>
              </div>
              <p className="text-amber-300">{t("deleteIrreversible")}</p>
            </div>

            <label className="mt-4 block">
              <span className="block text-[12.5px] text-ink-dim">{t("deleteTypeToConfirm")}</span>
              <code
                dir="auto"
                className="mt-1 inline-block rounded-md border border-line bg-raised px-2 py-1 text-[12.5px] text-ink-strong"
              >
                {phrase}
              </code>
              <input
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={phase === "working"}
                aria-label={t("deleteTypeToConfirm")}
                data-purge-confirm-input=""
                className={`${focusRing} mt-2 w-full rounded-xl border border-line bg-raised px-3 py-2
                            text-[13px] text-ink-strong placeholder-ink-faint disabled:opacity-50`}
                placeholder={t("deleteConfirmPlaceholder")}
              />
            </label>

            {typed.trim().length > 0 && !matches && (
              <p role="alert" className="mt-2 text-[12px] text-red-400">
                {t("deleteConfirmMismatch")}
              </p>
            )}
            {phase === "failed" && (
              <p role="alert" className="mt-2 text-[12px] text-red-400">
                {t("deleteFailed")}
              </p>
            )}
            {phase === "done" && (
              <p role="status" className="mt-2 text-[12px] text-emerald-400">
                {t("deleteDone")}
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={phase === "working"}
                className={`${focusRing} rounded-xl px-3 py-2 text-[13px] text-ink-dim hover:text-ink disabled:opacity-50`}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={() => void purge()}
                disabled={!matches || phase === "working"}
                aria-disabled={!matches || phase === "working"}
                data-purge-confirm=""
                className={`${focusRing} rounded-xl bg-red-500/20 px-4 py-2 text-[13px] text-red-200
                            transition-colors hover:bg-red-500/30 disabled:opacity-40`}
              >
                {phase === "working" ? t("deleteInProgress") : t("deleteMyData")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
