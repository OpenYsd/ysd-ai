/**
 * منطق المكتبة الخالص (بلا React ولا شبكة) — يستعمله العميل والخادم معًا.
 *
 *   - نوع الملف من MIME المحفوظ (والامتداد احتياطًا) — لا من الاسم وحده.
 *   - بحثٌ يطابق العربية بلا تشكيل ولا اختلاف صور الألف، والإنجليزية بلا حالة أحرف.
 *   - فرزٌ بما تحفظه القاعدة فعلًا: الاسم والتاريخ والحجم — لا بيانات مختلَقة.
 *   - المعاينة: صورٌ نقطية فقط داخل الصفحة. PDF يُفتح في لسانٍ جديد لأن سياسة
 *     الأمان (CSP: frame-src 'none'، object-src 'none') تمنع تضمينه، وهذا مقصود.
 *   - إعادة التسمية تغيّر الاسم المعروض وحده، بلا تغيير الامتداد (فلا يتغيّر النوع).
 */

import { sanitizeFileName } from "./config";
import { normalizeForSearch } from "@/lib/platform/search";

export type FileKind = "pdf" | "word" | "text" | "image" | "other";
export type FileKindFilter = "all" | Exclude<FileKind, "other">;
export type FileSort = "newest" | "oldest" | "name" | "size";
export type PreviewMode = "image" | "open" | "download";

export interface LibraryFile {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
/** صورٌ نقطية فقط — لا SVG ولا غيره مما قد يحمل شيفرة */
const PREVIEWABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(mime: string, name: string): FileKind {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m === WORD_MIME) return "word";
  if (TEXT_MIMES.has(m)) return "text";
  const ext = fileExtension(name);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "word";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  return "other";
}

export function previewMode(mime: string): PreviewMode {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (PREVIEWABLE_IMAGES.has(m)) return "image";
  if (m === "application/pdf") return "open";
  return "download";
}

export function filterFiles<T extends LibraryFile>(
  files: readonly T[],
  { query, kind }: { query: string; kind: FileKindFilter },
): T[] {
  const q = normalizeForSearch(query);
  return files.filter(
    (f) =>
      (kind === "all" || fileKind(f.mime_type, f.original_name) === kind) &&
      (!q || normalizeForSearch(f.original_name).includes(q)),
  );
}

export function sortFiles<T extends LibraryFile>(files: readonly T[], sort: FileSort, locale: string): T[] {
  const collator = new Intl.Collator(locale === "ar" ? "ar" : "en", { sensitivity: "base", numeric: true });
  const byDate = (a: T, b: T) => Date.parse(a.created_at) - Date.parse(b.created_at);
  return [...files].sort((a, b) => {
    switch (sort) {
      case "oldest":
        return byDate(a, b);
      case "name":
        return collator.compare(a.original_name, b.original_name);
      case "size":
        return b.size_bytes - a.size_bytes;
      default:
        return byDate(b, a);
    }
  });
}

/**
 * اتجاه الاسم من أول حرفٍ فيه. «التقرير 2026.pdf» في سياقٍ عربي يُعرض بلا ضبطٍ
 * «pdf.2026 التقرير» (خوارزمية الاتجاه تعامل الرقم والنقطة والامتداد كأجزاء منفصلة)؛
 * فالاسم يأخذ اتجاه حرفه الأول، والامتداد يُعزل باتجاهٍ يساريّ.
 */
export function nameDirection(name: string): "rtl" | "ltr" {
  const first = name.match(/\p{L}/u)?.[0];
  return first && /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(first) ? "rtl" : "ltr";
}

/** الاسم بلا امتداد، والامتداد بنقطته ("" إن لم يوجد) */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

export type RenameResult = { ok: true; name: string } | { ok: false; reason: "empty" | "extension" | "unchanged" };

/**
 * الاسم الجديد بعد التعقيم — والامتداد يجب أن يبقى كما هو.
 * يستعملها الخادم حكمًا نهائيًّا، والعميل لمنع إرسالٍ سيُرفض.
 */
export function validateRename(original: string, requested: string): RenameResult {
  const trimmed = requested.trim();
  const originalExt = splitFileName(original).ext.toLowerCase();
  // الامتداد وحده (".pdf") اسمٌ فارغ، لا تغييرُ امتداد
  if (!trimmed || (originalExt && trimmed.toLowerCase() === originalExt)) return { ok: false, reason: "empty" };
  const name = sanitizeFileName(trimmed);
  const { stem } = splitFileName(name);
  if (!stem.trim() || name === "file") return { ok: false, reason: "empty" };
  if (fileExtension(name) !== fileExtension(original)) return { ok: false, reason: "extension" };
  if (name === original) return { ok: false, reason: "unchanged" };
  return { ok: true, name };
}
