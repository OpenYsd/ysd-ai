"use client";

/**
 * شريطٌ صغير فوق شريط الكتابة لمهارةٍ جاءت من صفحتها (المرحلة 3B).
 *
 * ثلاث حالات، ولا إطار حواراتٍ جديد:
 * - **قرار**: للمستخدم مسودةٌ لم تُرسل — فلا تُمسّ حتى يختار: استبدالها، أو إضافة التعليمات
 *   بعدها، أو الإلغاء. الاختيار صريحٌ بأزرارٍ بنصٍّ مرئي.
 * - **أُضيفت**: التعليمات صارت المسودة نفسها؛ تذكيرٌ بأنها تُراجع قبل الإرسال.
 * - **تعذّر**: معرّفٌ مجهول أو مهارةٌ تعتمد على صلاحيةٍ معطّلة — لا نصّ أُضيف، والسبب معلَن.
 *
 * يظهر بعد الإماهة فقط (حالةٌ يضبطها تأثير)، فلا يختلف عرض الخادم عن عرض المتصفح.
 */

import { Ban, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { LocalizedText } from "@/lib/skills/manifest";

export type SkillDraftNoticeState =
  | { kind: "choice"; name: LocalizedText }
  | { kind: "added"; name: LocalizedText }
  | { kind: "unknown" | "unsupported" };

const boxCls = "mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line/60 bg-raised/50 px-3 py-2 text-[12.5px] text-ink-dim";
const actionCls =
  "rounded-lg px-2.5 py-1 text-[12.5px] text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

export function SkillDraftNotice({
  state,
  onReplace,
  onAppend,
  onCancel,
  onDismiss,
}: {
  state: SkillDraftNoticeState;
  onReplace: () => void;
  onAppend: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { t, locale } = useI18n();

  if (state.kind === "choice") {
    return (
      <div role="group" aria-label={t("skillDraftChoice")} data-skill-draft="choice" className={boxCls}>
        <p className="min-w-0 flex-1">
          {t("skillDraftConflict")} <bdi className="font-medium text-ink-strong">{state.name[locale]}</bdi>
        </p>
        <span className="flex flex-wrap items-center gap-1">
          <button type="button" onClick={onReplace} className={actionCls}>
            {t("skillDraftReplace")}
          </button>
          <button type="button" onClick={onAppend} className={actionCls}>
            {t("skillDraftAppend")}
          </button>
          <button type="button" onClick={onCancel} className={actionCls}>
            {t("cancel")}
          </button>
        </span>
      </div>
    );
  }

  const dismiss = (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={t("dismissError")}
      className="ms-auto shrink-0 rounded-md p-1 text-ink-faint hover:text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <X size={14} aria-hidden="true" />
    </button>
  );

  if (state.kind === "added") {
    return (
      <div data-skill-draft="added" className={boxCls}>
        <p role="status" className="min-w-0 flex-1">
          {t("skillDraftAdded")} <bdi className="font-medium text-ink-strong">{state.name[locale]}</bdi> — {t("skillDraftReview")}
        </p>
        {dismiss}
      </div>
    );
  }

  return (
    <div data-skill-draft={state.kind} className={boxCls}>
      <Ban size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
      <p role="status" className="min-w-0 flex-1">
        {state.kind === "unsupported" ? t("skillChatUnsupported") : t("skillChatUnknown")}
      </p>
      {dismiss}
    </div>
  );
}
