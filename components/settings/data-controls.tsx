"use client";

/**
 * ضوابط البيانات (v0.9.17، المرحلة 6F) — **فعلان مدمّران، لكلٍّ بابه**.
 *
 * ── لماذا اثنان لا واحد ──
 *
 * «حذف بياناتي» يُبقي تسجيل الدخول قائمًا؛ و«حذف حسابي نهائيًا» يُذهبه.
 * ودمجُهما في زرٍّ واحد يجعل من أراد تنظيف محادثاته يفقد حسابه. فيبقيان
 * منفصلين: نصًّا، وعبارةَ تأكيد، ومسارَ خادم.
 *
 * ── ولماذا كتابة عبارة لا ضغطة تأكيد ──
 *
 * ضغطتان متتاليتان يفعلهما الإصبع بلا أن يقرأ العقل. وكتابةُ عبارةٍ تُجبر
 * صاحبها على أن يقرأ ما يفعله ويُعيد كتابته — وهي أرخص حاجزٍ يمنع ندمًا لا
 * رجعة فيه. والعبارتان مختلفتان عمدًا: من حفظ الأولى لا تمرّ به الثانية.
 *
 * والعبارة بلغة الواجهة: مطالبةُ من يقرأ العربية بكتابة `DELETE MY ACCOUNT`
 * حاجزٌ لغويّ لا حاجزُ تأكيد.
 *
 * ── والحوار حوارٌ فعلًا ──
 *
 * `role="dialog"` و`aria-modal` صحيحان هنا لأنه يحجب ما تحته ويُغلق
 * بـEscape ويعيد التركيز إلى فاتحه — على نمط لوحة المصدر القائمة.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Trash2, UserX } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { SUPPORT_PATH } from "@/lib/public-support";

type Phase = "idle" | "confirming" | "working" | "done" | "failed";
/** `data` يُبقي الحساب؛ `account` يُذهبه. ولا ثالث. */
type Mode = "data" | "account";

interface Flow {
  endpoint: string;
  confirm: string;
  phraseKey: "deleteConfirmPhrase" | "deleteAccountConfirmPhrase";
  titleKey: "deleteMyData" | "deleteAccount";
  busyKey: "deleteInProgress" | "deleteAccountInProgress";
  doneKey: "deleteDone" | "deleteAccountDone";
  failedKey: "deleteFailed" | "deleteAccountFailed";
  irreversibleKey: "deleteIrreversible" | "deleteAccountIrreversible";
}

const FLOWS: Record<Mode, Flow> = {
  data: {
    endpoint: "/api/account/purge-data",
    confirm: "DELETE",
    phraseKey: "deleteConfirmPhrase",
    titleKey: "deleteMyData",
    busyKey: "deleteInProgress",
    doneKey: "deleteDone",
    failedKey: "deleteFailed",
    irreversibleKey: "deleteIrreversible",
  },
  account: {
    /** ★ تأكيدٌ آخر لمسارٍ آخر — فلا يُعاد استعمال تأكيد الأخفّ في الأثقل */
    endpoint: "/api/account/delete-account",
    confirm: "DELETE_ACCOUNT",
    phraseKey: "deleteAccountConfirmPhrase",
    titleKey: "deleteAccount",
    busyKey: "deleteAccountInProgress",
    doneKey: "deleteAccountDone",
    failedKey: "deleteAccountFailed",
    irreversibleKey: "deleteAccountIrreversible",
  },
};

export function DataControls() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** يمنع الإرسال المكرّر داخل الدورة الواحدة — راجع `submit` */
  const submittingRef = useRef(false);
  const titleId = useId();
  const descId = useId();

  const flow = mode ? FLOWS[mode] : null;
  const phrase = flow ? t(flow.phraseKey) : "";
  const matches = flow !== null && typed.trim() === phrase;
  /**
   * ★ و«تمّ» يبقى الحوار مفتوحًا للحظته.
   *
   * فإغلاقُه فور النجاح يجعل المستخدم يرى الصفحة تُعاد تحميلها بلا أن
   * يقرأ أن ما طلبه وقع.
   */
  const open = mode !== null;

  const close = useCallback(() => {
    submittingRef.current = false;
    setMode(null);
    setPhase("idle");
    setTyped("");
    openerRef.current?.focus();
  }, []);

  const openFlow = useCallback((next: Mode, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
    submittingRef.current = false;
    setTyped("");
    setMode(next);
    setPhase("confirming");
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
  }, [phase, mode]);

  const submit = useCallback(async () => {
    /**
     * ★ الحارس مرجعٌ لا حالة — وهذا فرقٌ كشفه اختبار.
     *
     * `phase` قيمةٌ مُغلقة على الرسم الحالي: ثلاث ضغطاتٍ في نفس الدورة
     * تقرأها كلُّها `"confirming"` لأن React لم يُعد الرسم بينها. فيمرّ
     * ثلاثةُ طلباتِ حذف. والمرجع يتغيّر في اللحظة نفسها، فيمنع الثانية.
     */
    if (submittingRef.current || !matches || !flow) return;
    submittingRef.current = true;
    setPhase("working");
    try {
      const res = await fetch(flow.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // التأكيد وحده — والهوية من الجلسة، فلا معرّف في الجسم
        body: JSON.stringify({ confirm: flow.confirm }),
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
       *
       * ★ وبعد حذف الحساب لا تُقصد صفحةٌ محميّة: الهوية ذهبت، فقصدُ
       * `/chat` يعني تحويلًا إلى `/login` من حسابٍ لم يعد له وجود. فتُقصد
       * الصفحة العامّة مباشرةً.
       */
      window.location.assign(mode === "account" ? "/" : "/chat");
    } catch {
      submittingRef.current = false;
      setPhase("failed");
    }
  }, [matches, flow, mode]);

  const focusRing =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow";
  const dangerButton = `${focusRing} inline-flex items-center gap-2 rounded-xl border border-red-500/40
                        px-4 py-2 text-[13px] text-red-300 transition-colors hover:bg-red-500/10`;

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
        type="button"
        onClick={(e) => openFlow("data", e.currentTarget)}
        data-open-purge=""
        className={`${dangerButton} mt-4`}
      >
        <Trash2 size={14} aria-hidden />
        {t("deleteMyData")}
      </button>

      {/* ═══ حذف الحساب — فعلٌ أثقل، خلف بابه ═══ */}
      <div className="mt-5 border-t border-line/60 pt-4">
        <p className="text-[12.5px] text-ink-dim leading-relaxed">{t("deleteAccountIntro")}</p>
        <button
          type="button"
          onClick={(e) => openFlow("account", e.currentTarget)}
          data-open-delete-account=""
          className={`${dangerButton} mt-3`}
        >
          <UserX size={14} aria-hidden />
          {t("deleteAccount")}
        </button>

        {/*
          ★ والدعم يبقى — لمن لا يستطيع الدخول أصلًا.

          فمن فقد الوصول إلى حسابه لا يبلغ هذا الزرّ، وإزالةُ الطريق الآخر
          تتركه بلا سبيل. ولا يحمل الرابط بريدًا ولا معرّفًا: ما يُوضع في
          عنوانٍ يُسجَّل في وكلاء وسجلّاتِ خوادم لا نملكها.
        */}
        <p className="mt-3 text-[12px] text-ink-faint leading-relaxed">
          {t("requestAccountDeletionHint")}
        </p>
        <Link
          href={`${SUPPORT_PATH}?topic=account-deletion`}
          data-request-account-deletion=""
          className={`${focusRing} mt-1 inline-block rounded-lg text-[13px] text-primary-glow hover:brightness-125`}
        >
          {t("requestAccountDeletion")}
        </Link>
      </div>

      {open && flow && (
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
            data-purge-mode={mode}
            className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl"
          >
            <h3 id={titleId} className="text-[14.5px] font-semibold text-ink-strong">
              {t(flow.titleKey)}
            </h3>

            <div id={descId} className="mt-3 space-y-3 text-[12.5px] leading-relaxed">
              <div>
                <p className="font-medium text-ink">{t("deleteWhatGoesTitle")}</p>
                <ul className="mt-1 list-disc ms-5 space-y-1 text-ink-dim">
                  {mode === "data" ? (
                    <>
                      <li>{t("deleteItemConversations")}</li>
                      <li>{t("deleteItemProjects")}</li>
                      <li>{t("deleteItemFiles")}</li>
                      <li>{t("deleteItemRag")}</li>
                      <li>{t("deleteItemTraining")}</li>
                    </>
                  ) : (
                    <>
                      <li>{t("deleteAccountItemAppData")}</li>
                      <li>{t("deleteAccountItemIdentity")}</li>
                      <li>{t("deleteAccountItemUsage")}</li>
                      <li>{t("deleteAccountItemTraining")}</li>
                    </>
                  )}
                </ul>
              </div>

              {mode === "data" ? (
                <div>
                  <p className="font-medium text-ink">{t("deleteWhatStaysTitle")}</p>
                  <ul className="mt-1 list-disc ms-5 space-y-1 text-ink-dim">
                    <li>{t("deleteStaysAccount")}</li>
                    <li>{t("deleteStaysUsage")}</li>
                  </ul>
                </div>
              ) : (
                /** ولا يُوعَد بمحوٍ من كل سجلٍّ تاريخيّ — بل بعدم صلاحيته */
                <p data-historical-note="" className="text-ink-dim">
                  {t("deleteAccountHistoricalNote")}
                </p>
              )}

              <p className="text-amber-300">{t(flow.irreversibleKey)}</p>
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
                {t(flow.failedKey)}
              </p>
            )}
            {phase === "done" && (
              <p role="status" className="mt-2 text-[12px] text-emerald-400">
                {t(flow.doneKey)}
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
                onClick={() => void submit()}
                disabled={!matches || phase === "working"}
                aria-disabled={!matches || phase === "working"}
                data-purge-confirm=""
                className={`${focusRing} rounded-xl bg-red-500/20 px-4 py-2 text-[13px] text-red-200
                            transition-colors hover:bg-red-500/30 disabled:opacity-40`}
              >
                {phase === "working" ? t(flow.busyKey) : t(flow.titleKey)}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
