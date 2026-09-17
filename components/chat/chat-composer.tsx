"use client";

/**
 * شريط الكتابة مع مرفقاته — البطاقات داخل الشريط لا فوقه.
 *
 * ★ ثلاثة مداخل للملف، ومرشِّحٌ واحد بعدها
 *
 *   الزرّ (عدّة ملفات)، والسحبُ والإفلات، ولصقُ **الصور** من الحافظة. كلّها تنتهي
 *   عند `onFiles` نفسها، والتحقّق وقرارُ الرفع في الخطّاف لا هنا — فلا مدخلٌ
 *   يتجاوز ما يتجاوزه غيرُه.
 *
 * ★ ولا إفلاتَ يُضيّع المحادثة
 *
 *   ملفٌّ يُفلت خارج الشريط بقليل يفتحه المتصفّح مكانَ الصفحة، فتضيع المسوّدة.
 *   فالإفلات خارج المنطقة يُلغى ما دام الشريط معروضًا.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Paperclip, Square, Upload } from "lucide-react";
import { AttachmentCard } from "@/components/chat/attachment-card";
import {
  acceptAttribute,
  attachmentNotice,
  isPasteableImage,
  pastedImageName,
  type ComposerAttachment,
} from "@/lib/chat/composer-attachments";
import { useI18n } from "@/lib/i18n";

const hasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function ChatComposer({
  input,
  setInput,
  onSend,
  onStop,
  generating,
  disabled,
  taRef,
  autoGrow,
  placeholder,
  sendLabel,
  stopLabel,
  composerLabel,
  attachLabel,
  centered,
  attachments,
  onFiles,
  onRemoveAttachment,
  onRetryAttachment,
  sendBlocked,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  generating: boolean;
  disabled?: boolean;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  autoGrow: () => void;
  placeholder: string;
  sendLabel: string;
  stopLabel: string;
  composerLabel: string;
  attachLabel: string;
  centered?: boolean;
  attachments: ComposerAttachment[];
  onFiles: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  onRetryAttachment: (key: string) => void;
  /** رفعٌ جارٍ: الرسالة لن ترى ملفًّا لم يُربط بعد */
  sendBlocked: boolean;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const drafts = attachments.filter((a) => a.scope === "draft");
  const context = attachments.filter((a) => a.scope === "context");
  const notice = attachmentNotice(attachments);
  const accept = useMemo(() => acceptAttribute(), []);
  const uploading = drafts.some((a) => a.phase === "uploading" || a.phase === "processing" || a.phase === "selected");

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (hasFiles(e) && !zoneRef.current?.contains(e.target as Node)) e.preventDefault();
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const take = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0 && !disabled) onFiles(files);
  };

  return (
    <div
      ref={zoneRef}
      data-composer
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={(e) => {
        if (!hasFiles(e) || disabled) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e) || disabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className={`relative rounded-2xl border bg-surface/90 backdrop-blur transition-all ${
        dragging
          ? "border-primary/70"
          : centered
            ? "border-primary/40 shadow-[0_0_50px_rgba(108,75,240,.12)]"
            : "border-line focus-within:border-primary/50"
      }`}
    >
      {dragging && (
        <div
          data-drop-overlay
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/60 bg-surface/95 text-[13px] text-ink"
        >
          <Upload size={16} className="text-primary-glow" aria-hidden="true" />
          {t("dropToAttach")}
        </div>
      )}

      {attachments.length > 0 && (
        <div data-attachment-tray className="px-2.5 pt-2.5">
          <div className="flex snap-x gap-2 overflow-x-auto pb-1.5 [scrollbar-width:thin]">
            {context.length > 0 && (
              <button
                type="button"
                data-context-toggle
                onClick={() => setShowContext((v) => !v)}
                aria-expanded={showContext}
                aria-label={`${showContext ? t("hideChatFiles") : t("showChatFiles")} (${context.length})`}
                className="flex shrink-0 snap-start items-center gap-1.5 self-center rounded-xl border border-line bg-raised/60 px-2.5 py-2 text-[11.5px] text-ink-dim transition-colors hover:border-primary/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <Paperclip size={12} aria-hidden="true" />
                <span dir="ltr">{context.length}</span>
                <span>{t("attachmentsInChat")}</span>
              </button>
            )}
            {showContext &&
              context.map((a) => (
                <AttachmentCard key={a.key} attachment={a} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
              ))}
            {drafts.map((a) => (
              <AttachmentCard key={a.key} attachment={a} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} />
            ))}
          </div>
          {(notice || sendBlocked) && (
            <p data-attachment-notice className="px-1.5 pb-1 text-[10.5px] leading-relaxed text-ink-faint">
              {sendBlocked ? t("waitForUploads") : notice ? t(notice) : null}
            </p>
          )}
        </div>
      )}

      <textarea
        ref={taRef}
        value={input}
        rows={1}
        disabled={disabled}
        aria-label={composerLabel}
        /**
         * ★ `aria-busy` لا `disabled` أثناء التوليد.
         *
         * تعطيلُ الحقل يسحب التركيز منه ويمنع الكتابة أثناء انتظار الرد —
         * وكتابةُ الرسالة التالية أثناء الانتظار سلوكٌ مشروع. و`aria-busy`
         * يُعلم قارئ الشاشة أن المنطقة تتغيّر بلا أن يمنع أحدًا من شيء.
         */
        aria-busy={generating}
        onChange={(e) => {
          setInput(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        onPaste={(e) => {
          /**
           * ★ الصور فقط، ولا شيء إن كان في الحافظة نصّ.
           *
           * نسخُ فقرةٍ من Word يضع في الحافظة نصًّا **وصورةً** لها معًا. والمقصود
           * لصقُ النصّ؛ فالتقاطُ الصورة حينها يُرفق ما لم يطلبه أحد.
           */
          const data = e.clipboardData;
          if (!data || disabled) return;
          if (data.types.includes("text/plain") && data.getData("text/plain").trim()) return;
          const images = Array.from(data.files ?? []).filter((f) => isPasteableImage(f.type));
          if (images.length === 0) return;
          e.preventDefault();
          onFiles(images.map((f) => new File([f], pastedImageName(f.type), { type: f.type })));
        }}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-ink-strong placeholder-ink-faint focus:outline-none disabled:opacity-50"
        style={{ maxHeight: 180 }}
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title={attachLabel}
          aria-label={attachLabel}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          data-attachment-input
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="flex-1" />
        {generating ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-9 items-center gap-2 rounded-xl border border-line bg-raised px-4 text-[13px] font-medium text-ink-strong transition-colors hover:border-primary/40"
          >
            <Square size={11} fill="currentColor" />
            {stopLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!input.trim() || disabled || sendBlocked}
            title={sendBlocked ? t("waitForUploads") : undefined}
            className="flex h-9 items-center gap-1.5 rounded-xl px-4 text-[13px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-35"
            style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
          >
            {sendLabel}
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
