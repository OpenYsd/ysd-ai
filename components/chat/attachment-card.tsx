"use client";

/**
 * بطاقة مرفقٍ واحد داخل شريط الكتابة.
 *
 * ★ الاسم نصٌّ لا HTML: React يهرّبه، و`displayFileName` نزع منه محارفَ
 *   التحكّم ثنائيّة الاتّجاه قبل أن يصل هنا.
 *
 * ★ والاسم يتبع اتّجاهَ نصِّه لا اتّجاهَ الواجهة
 *
 *   سطر الاسم `dir="auto"`: `report.pdf` في واجهةٍ عربيّة يبقى امتدادُه يمينَ
 *   الاسم، و`تقرير.pdf` يبقى امتدادُه يسارَه — في طرف النصّ الصحيح لكلٍّ منهما.
 *   والجذع `<span>` لا `<bdi>`: خوارزميّة `dir="auto"` تتخطّى `<bdi>` وكلَّ عنصرٍ
 *   له `dir`، فلو عُزل الجذع لما رأت حرفًا تستدلّ به ولرجعت إلى LTR دائمًا.
 *
 * ★ ولا `aria-live` هنا: المنطقة الحيّة الوحيدة في المحادثة لحالة البثّ، وعشرُ
 *   بطاقاتٍ تُعلن تقدّمها كلَّ ثانيةٍ ضجيجٌ لا معلومة. التقدّم `progressbar`
 *   يُقرأ حين يصل إليه المستخدم.
 */

import { AlertTriangle, FileText, ImageIcon, Loader2, RotateCw, X } from "lucide-react";
import { formatBytes } from "@/components/files/upload";
import {
  canRemove,
  isImageMime,
  splitFileName,
  type AttachmentErrorKind,
  type ComposerAttachment,
} from "@/lib/chat/composer-attachments";
import { useI18n } from "@/lib/i18n";

type T = ReturnType<typeof useI18n>["t"];

function errorLabel(t: T, kind: AttachmentErrorKind | null): string {
  switch (kind) {
    case "unsupported":
      return t("attachmentErrUnsupported");
    case "empty":
      return t("attachmentErrEmpty");
    case "tooLarge":
      return t("attachmentErrTooLarge");
    case "quota":
      return t("attachmentErrQuota");
    case "rateLimited":
      return t("attachmentErrRateLimited");
    case "network":
      return t("attachmentErrNetwork");
    case "auth":
      return t("attachmentErrAuth");
    case "notFound":
      return t("attachmentErrNotFound");
    case "extractFailed":
      return t("attachmentErrExtract");
    case "indexFailed":
      return t("ragFailed");
    case "indexStalled":
      return t("attachmentErrStalled");
    case "unlinkFailed":
      return t("attachmentErrUnlink");
    default:
      return t("attachmentErrServer");
  }
}

export function attachmentStatusLabel(t: T, a: ComposerAttachment): string {
  switch (a.phase) {
    case "selected":
      return t("attachmentQueued");
    case "uploading":
      return a.progress !== null ? `${t("attachmentUploading")} ${a.progress}%` : t("attachmentUploading");
    case "processing":
      return a.serverStatus === "verifying" ? t("attachmentVerifying") : t("statusProcessing");
    case "indexing":
      return a.progress !== null ? `${t("ragPreparing")} ${a.progress}%` : t("ragPreparing");
    case "ready":
      if (isImageMime(a.mime)) return t("imageNoAiContext");
      return a.aiContext ? t("ragReady") : t("textExtracted");
    case "error":
      return errorLabel(t, a.errorKind);
  }
}

export function AttachmentCard({
  attachment: a,
  onRemove,
  onRetry,
}: {
  attachment: ComposerAttachment;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const image = isImageMime(a.mime);
  const busy = a.phase === "selected" || a.phase === "uploading" || a.phase === "processing" || a.phase === "indexing";
  const { stem, ext } = splitFileName(a.name);
  const status = attachmentStatusLabel(t, a);
  const removable = canRemove(a);
  /**
   * ★ ثلاثة أفعالٍ مختلفة تحت زرٍّ واحد، ولكلٍّ اسمه الصادق:
   * إلغاءُ رفعٍ جارٍ · إزالةُ مسوّدةٍ لم تُرفع · وفكُّ ملفٍّ من سياق المحادثة
   * دون حذفه — وهو ما تفعله القاعدة فعلًا.
   */
  const removeLabel =
    a.phase === "uploading"
      ? t("cancelUpload")
      : a.fileId
        ? t("removeFromContext")
        : t("removeAttachment");
  const retryLabel =
    a.retry === "upload" ? t("retryUpload") : a.retry === "extract" ? t("retryExtract") : a.phase === "error" ? t("ragRetry") : t("ragPrepare");
  const showBar = (a.phase === "uploading" || a.phase === "indexing") && a.progress !== null;
  const tone =
    a.phase === "error" || a.errorKind === "unlinkFailed"
      ? "border-red-500/40"
      : a.phase === "ready" && a.aiContext
        ? "border-emerald-500/30"
        : "border-line";

  return (
    <div
      data-attachment-card
      data-attachment-phase={a.phase}
      className={`group relative flex w-[212px] sm:w-[232px] shrink-0 snap-start items-center gap-2.5 rounded-xl border bg-raised/60 ps-2 pe-1.5 py-2 ${tone}`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          a.phase === "error" ? "bg-red-500/15 text-red-400" : image ? "bg-sky-500/15 text-sky-300" : "bg-primary/15 text-primary-glow"
        }`}
        aria-hidden="true"
      >
        {a.phase === "error" ? (
          <AlertTriangle size={16} />
        ) : busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : image ? (
          <ImageIcon size={16} />
        ) : (
          <FileText size={16} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p
          dir="auto"
          data-attachment-name
          className="flex w-fit min-w-0 max-w-full text-[12.5px] leading-5 text-ink"
          title={a.name}
        >
          <span className="min-w-0 truncate">{stem}</span>
          {ext && (
            <bdi dir="ltr" className="shrink-0">
              {ext}
            </bdi>
          )}
        </p>
        <p
          className={`truncate text-[10.5px] leading-4 ${a.phase === "error" || a.errorKind ? "text-red-400" : "text-ink-faint"}`}
          title={a.errorMessage ?? status}
          data-attachment-status
        >
          {a.size !== null && <span dir="ltr">{formatBytes(a.size, locale)}</span>}
          {a.size !== null && " · "}
          {a.errorKind === "unlinkFailed"
            ? t("attachmentErrUnlink")
            : a.errorKind === "tooLarge" && a.errorMessage
              ? `${status} (${a.errorMessage})`
              : status}
        </p>
        {showBar && (
          <div
            role="progressbar"
            aria-label={a.phase === "uploading" ? t("uploadProgressLabel") : t("ragPreparing")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={a.progress ?? 0}
            className="mt-1 h-1 overflow-hidden rounded-full bg-line"
          >
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${a.progress ?? 0}%`, background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)" }}
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-0.5">
        <button
          type="button"
          onClick={() => onRemove(a.key)}
          disabled={!removable}
          title={removable ? removeLabel : t("processingNotRemovable")}
          aria-label={removable ? removeLabel : t("processingNotRemovable")}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface hover:text-red-400 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <X size={13} />
        </button>
        {a.retry && (
          <button
            type="button"
            onClick={() => onRetry(a.key)}
            title={retryLabel}
            aria-label={retryLabel}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface hover:text-primary-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <RotateCw size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
