/**
 * إعدادات نظام الملفات المركزية.
 * الأنواع المسموحة فقط — كل ما عداها مرفوض (تنفيذيات، سكريبتات، مضغوطات…).
 * الامتداد وMIME يجب أن يتطابقا معًا؛ لا اعتماد على اسم الملف وحده.
 */

export interface AllowedType {
  exts: string[];
  mimes: string[];
  kind: "document" | "image";
}

export const ALLOWED_TYPES: AllowedType[] = [
  { exts: ["txt"], mimes: ["text/plain"], kind: "document" },
  { exts: ["md", "markdown"], mimes: ["text/markdown", "text/x-markdown", "text/plain"], kind: "document" },
  { exts: ["pdf"], mimes: ["application/pdf"], kind: "document" },
  {
    exts: ["docx"],
    mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    kind: "document",
  },
  { exts: ["png"], mimes: ["image/png"], kind: "image" },
  { exts: ["jpg", "jpeg"], mimes: ["image/jpeg"], kind: "image" },
  { exts: ["webp"], mimes: ["image/webp"], kind: "image" },
];

/** التحقق المزدوج: الامتداد وMIME معًا */
export function resolveAllowedType(
  fileName: string,
  mime: string,
): AllowedType | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const byExt = ALLOWED_TYPES.find((t) => t.exts.includes(ext));
  if (!byExt) return null;
  const normalizedMime = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return byExt.mimes.includes(normalizedMime) ? byExt : null;
}

const FORBIDDEN_NAME_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

/**
 * تعقيم اسم الملف: إزالة فواصل المسارات وأحرف التحكم والأحرف المحظورة —
 * منع path traversal. يُحافظ على الامتداد ويُقصّ الطول.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = Array.from(base)
    .filter((ch) => ch.charCodeAt(0) >= 32 && !FORBIDDEN_NAME_CHARS.has(ch))
    .join("")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned || cleaned === ".") return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  if (dot > 0 && cleaned.length - dot <= 12) {
    return cleaned.slice(0, 120 - (cleaned.length - dot)) + cleaned.slice(dot);
  }
  return cleaned.slice(0, 120);
}

/** مسار التخزين — يبدأ دائمًا بمعرّف المستخدم (تفرضه سياسات Storage أيضًا) */
export function buildStoragePath(
  userId: string,
  projectId: string | null,
  fileId: string,
  safeName: string,
): string {
  return `${userId}/${projectId ?? "general"}/${fileId}/${safeName}`;
}
