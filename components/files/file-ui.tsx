"use client";

/**
 * عناصر مشتركة لعرض الملفات في المكتبة والمشروع:
 *   - أيقونة بحسب النوع المحفوظ (MIME) لا بحسب الاسم وحده؛
 *   - معاينة صورة عبر رابطٍ موقّت قصير العمر من الخادم بعد تحقق الملكية —
 *     التخزين يبقى خاصًّا، ولا مفتاح خدمة في المتصفح، والرابط لا يُخزَّن ولا يُسجَّل؛
 *   - فتح/تنزيل عبر الرابط نفسه في لسانٍ جديد بلا opener ولا referrer.
 */

import { useEffect, useState } from "react";
import { File as FileIcon, FileImage, FileText, FileType2, ScrollText } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { fileKind, nameDirection, splitFileName } from "@/lib/files/library";

/**
 * اسم الملف باتجاه حرفه الأول، والامتداد معزولٌ في نهايته — لا يتبعثر الرقم والامتداد في RTL.
 * الاتجاه على النصّ الداخليّ وحده: الغلاف يرث اتجاه الصفحة فتبقى المحاذاة واحدة في القائمة.
 */
export function FileName({ name, className }: { name: string; className?: string }) {
  const { stem, ext } = splitFileName(name);
  return (
    <span className={className}>
      <span dir={nameDirection(name)}>
        {stem}
        {ext && <span dir="ltr">{ext}</span>}
      </span>
    </span>
  );
}

export function FileTypeIcon({ mime, name, size = 16 }: { mime: string; name: string; size?: number }) {
  const kind = fileKind(mime, name);
  const Icon =
    kind === "image" ? FileImage : kind === "pdf" ? FileText : kind === "word" ? FileType2 : kind === "text" ? ScrollText : FileIcon;
  return <Icon size={size} aria-hidden="true" className="shrink-0 text-ink-dim" />;
}

async function signedUrl(fileId: string): Promise<string | null> {
  const res = await fetch(`/api/files/${fileId}/download`).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as { url?: string } | null;
  return typeof j?.url === "string" ? j.url : null;
}

/** يفتح الملف (أو ينزّله بحسب نوعه) في لسانٍ جديد — false عند الفشل */
export async function openSignedFile(fileId: string): Promise<boolean> {
  const url = await signedUrl(fileId);
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * معاينة صورة نقطية (PNG/JPEG/WEBP). عنصر <img> لا ينفّذ شيفرة، والمصدر مسموح في
 * CSP (img-src). لا next/image: محسّن الصور سيجلب الرابط الموقّت من الخادم ويخبّئه.
 */
export function ImagePreview({ fileId, name }: { fileId: string; name: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    void signedUrl(fileId).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [fileId]);

  if (failed) {
    return (
      <p role="status" className="text-[12px] text-ink-faint">
        {t("previewFailed")}
      </p>
    );
  }
  if (!url) {
    return (
      <div role="status" className="h-40 w-full max-w-sm rounded-lg bg-raised/60 animate-pulse">
        <span className="sr-only">{t("previewLoading")}</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- رابط موقّت خاص؛ لا يمرّ بمحسّن الصور
    <img
      src={url}
      alt={name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="max-h-80 max-w-full w-auto rounded-lg border border-line/60 bg-night/40 object-contain"
    />
  );
}
