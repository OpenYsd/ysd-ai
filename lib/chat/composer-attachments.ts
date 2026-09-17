/**
 * مرفقات شريط الكتابة — نموذج الحالة ومنطقه الخالص (بلا React ولا شبكة).
 *
 * ★ الدلالة كما هي في القاعدة لا كما توحي الواجهة
 *
 *   الملف يُربط بالمحادثة (`files.conversation_id`) لحظةَ رفعه، ويدخل سياقَ الـRAG
 *   لكل رسالة لاحقة في المحادثة نفسها. **لا علاقة بين ملفٍ ورسالةٍ بعينها** في
 *   المخطّط الحالي. فلا يُرسم مرفقٌ داخل فقاعة رسالة: ذلك ادّعاءٌ لا يستطيع
 *   التاريخ إثباته بعد إعادة التحميل. والبطاقات قبل الإرسال «مسوّدة»، وبعده تنتقل
 *   إلى مجموعة «ملفات هذه المحادثة» — وهو بالضبط ما تقوله القاعدة.
 *
 * ★ والخادم هو الحكَم
 *
 *   التحقّق هنا (النوع والحجم) تجربةُ استخدامٍ فقط: يمنع رفع ٢٠٠ ميجابايت ليُرفض
 *   بعد اكتماله. والقرار النهائي لـ`/api/files/upload` بأنواعه وحدوده من
 *   `usage_limits` — لا رقمَ مكتوبٌ هنا.
 */

import { ALLOWED_TYPES, resolveAllowedType } from "@/lib/files/config";

export type AttachmentPhase =
  | "selected"
  | "uploading"
  | "processing"
  | "indexing"
  | "ready"
  | "error";

export type RetryKind = "upload" | "extract" | "rag";

export type AttachmentErrorKind =
  | "unsupported"
  | "empty"
  | "tooLarge"
  | "quota"
  | "rateLimited"
  | "network"
  | "server"
  | "auth"
  | "notFound"
  | "extractFailed"
  | "indexFailed"
  | "unlinkFailed";

export interface ComposerAttachment {
  /** مفتاح العميل — ثابت منذ الاختيار، قبل أن يوجد معرّفٌ على الخادم */
  key: string;
  /** معرّف صف `files` بعد نجاح الرفع */
  fileId: string | null;
  name: string;
  size: number | null;
  mime: string | null;
  phase: AttachmentPhase;
  /** نسبة الرفع، أو نسبة التجهيز حين يُعلنها الخادم؛ `null` حين لا تُعرف */
  progress: number | null;
  serverStatus: string | null;
  /** لمستندٍ «جاهز النص»: هل طُلب تجهيزه للذكاء الاصطناعي في هذه الجلسة؟ */
  ragRequested: boolean;
  /** هل يدخل سياق الذكاء الاصطناعي؟ الصور لا تدخله (بلا OCR) */
  aiContext: boolean;
  errorKind: AttachmentErrorKind | null;
  /** رسالة الخادم بلغة الواجهة — نصٌّ يُعرض نصًّا، لا HTML */
  errorMessage: string | null;
  retry: RetryKind | null;
  /** "draft": أُضيف منذ آخر إرسال · "context": ملفٌّ في سياق المحادثة أصلًا */
  scope: "draft" | "context";
}

/** صف الملف كما يعيده الخادم (الحقول التي تلزم الواجهة) */
export interface ServerFileState {
  id: string;
  status: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  original_name?: string | null;
  rag_total_chunks?: number | null;
  rag_done_chunks?: number | null;
  rag_error?: string | null;
}

const IMAGE_MIMES = new Set(ALLOWED_TYPES.filter((t) => t.kind === "image").flatMap((t) => t.mimes));

export const isImageMime = (mime: string | null | undefined): boolean =>
  Boolean(mime && mime.toLowerCase().startsWith("image/"));

/** سمة `accept` من الأنواع المسموحة على الخادم نفسها — لا قائمةٌ ثانية تتباعد */
export function acceptAttribute(): string {
  return ALLOWED_TYPES.flatMap((t) => t.exts.map((e) => `.${e}`)).join(",");
}

/**
 * ★ اسمٌ للعرض لا يخدع.
 *
 * محارفُ التحكّم ثنائيّةُ الاتّجاه (RLO مثلًا) تجعل `photo<RLO>gpj.exe` يُقرأ
 * `photoexe.jpg`. وتُحذف محارفُ التحكّم كلُّها. وZWNJ/ZWJ باقيان: لهما عملٌ
 * مشروعٌ في الكتابة العربيّة والفارسيّة. والنصّ يُعرض عنصرَ نصٍّ في React، فلا
 * مجال لحقنٍ عبر الاسم أصلًا — وهذا خطُّ دفاعٍ ثانٍ ضدّ الخداع البصريّ.
 */
export function displayFileName(name: string): string {
  const cleaned = Array.from(name ?? "")
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
      if (c === 0x200e || c === 0x200f || c === 0x061c) return false;
      if (c >= 0x202a && c <= 0x202e) return false;
      if (c >= 0x2066 && c <= 0x2069) return false;
      return true;
    })
    .join("")
    .trim();
  return cleaned || "file";
}

/** يفصل الامتداد ليبقى ظاهرًا حين يُقصّ الاسم الطويل */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 12) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** رسائل الخادم بلغتين يفصلهما « | » — يُختار جانبُ لغة الواجهة */
export function localizeServerMessage(message: string | null | undefined, locale: "ar" | "en"): string | null {
  if (!message) return null;
  const parts = message.split(" | ");
  const chosen = (parts.length >= 2 ? (locale === "ar" ? parts[0] : parts.slice(1).join(" | ")) : message) ?? message;
  return chosen.trim().slice(0, 240) || null;
}

/** اسمٌ مولَّد لصورةٍ مُلصقة — الحافظة تعطي «image.png» لكل شيء */
export function pastedImageName(mime: string, now: Date = new Date()): string {
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `pasted-image-${stamp}.${ext}`;
}

/** الصور التي يقبلها الخادم فقط تُلتقط من الحافظة */
export function isPasteableImage(mime: string): boolean {
  return IMAGE_MIMES.has(mime.toLowerCase());
}

/** تحقّقٌ مسبقٌ في المتصفّح — يطابق قواعد الخادم ولا يحلّ محلّها */
export function validateSelection(
  file: { name: string; type: string; size: number },
  maxFileMb: number | null,
): { kind: AttachmentErrorKind; limitMb?: number } | null {
  if (!resolveAllowedType(file.name, file.type)) return { kind: "unsupported" };
  if (file.size === 0) return { kind: "empty" };
  if (maxFileMb !== null && maxFileMb > 0 && file.size > maxFileMb * 1024 * 1024) {
    return { kind: "tooLarge", limitMb: maxFileMb };
  }
  return null;
}

/** تصنيف فشل الرفع: ما يُعاد مجدّدًا وما لا فائدة من إعادته */
export function classifyUploadFailure(
  status: number | undefined,
  error: string | undefined,
): { kind: AttachmentErrorKind; retry: RetryKind | null } {
  if (error === "network" || !status) return { kind: "network", retry: "upload" };
  if (status === 429) return { kind: "rateLimited", retry: "upload" };
  if (status === 413) return { kind: "tooLarge", retry: null };
  if (status === 403) return { kind: "quota", retry: null };
  if (status === 401) return { kind: "auth", retry: null };
  if (status === 404) return { kind: "notFound", retry: null };
  if (status === 400) return { kind: "unsupported", retry: null };
  if (status >= 500) return { kind: "server", retry: "upload" };
  return { kind: "server", retry: null };
}

/** حالة الخادم ← مرحلة البطاقة (بلا ادّعاء: «جاهز» يعني ما يقوله الخادم) */
export function phaseForServerStatus(
  status: string,
  mime: string | null,
  ragRequested: boolean,
): Pick<ComposerAttachment, "phase" | "aiContext" | "errorKind" | "retry"> {
  const image = isImageMime(mime);
  switch (status) {
    case "uploaded":
    case "processing":
    case "extracting":
      return { phase: "processing", aiContext: false, errorKind: null, retry: null };
    case "ready":
      if (image) return { phase: "ready", aiContext: false, errorKind: null, retry: null };
      // مستندٌ استُخرج نصُّه: قيد التجهيز إن طُلب، وإلا جاهزُ النص بلا سياق AI بعد
      return ragRequested
        ? { phase: "indexing", aiContext: false, errorKind: null, retry: null }
        : { phase: "ready", aiContext: false, errorKind: null, retry: "rag" };
    case "chunking":
    case "embedding":
      return { phase: "indexing", aiContext: false, errorKind: null, retry: null };
    case "ready_for_rag":
      return { phase: "ready", aiContext: true, errorKind: null, retry: null };
    case "failed":
      return { phase: "error", aiContext: false, errorKind: "extractFailed", retry: "extract" };
    case "rag_failed":
      return { phase: "error", aiContext: false, errorKind: "indexFailed", retry: "rag" };
    default:
      return { phase: "processing", aiContext: false, errorKind: null, retry: null };
  }
}

function indexingProgress(total: number | null | undefined, done: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((done ?? 0) / total) * 100)));
}

/** مرفقٌ محمَّلٌ من الخادم (سياق المحادثة) */
export function fromServerFile(f: ServerFileState & { original_name: string }): ComposerAttachment {
  const mapped = phaseForServerStatus(f.status, f.mime_type ?? null, false);
  return {
    key: `file:${f.id}`,
    fileId: f.id,
    name: displayFileName(f.original_name),
    size: f.size_bytes ?? null,
    mime: f.mime_type ?? null,
    progress: mapped.phase === "indexing" ? indexingProgress(f.rag_total_chunks, f.rag_done_chunks) : null,
    serverStatus: f.status,
    ragRequested: false,
    errorMessage: f.status === "rag_failed" ? f.rag_error ?? null : null,
    scope: "context",
    ...mapped,
  };
}

export type AttachmentAction =
  | { type: "add"; items: Array<{ key: string; name: string; size: number; mime: string; error?: { kind: AttachmentErrorKind; message?: string | null } }> }
  | { type: "uploadStart"; key: string }
  | { type: "uploadProgress"; key: string; percent: number }
  | { type: "uploadDone"; key: string; file: ServerFileState; ragRequested: boolean }
  | { type: "uploadFailed"; key: string; kind: AttachmentErrorKind; retry: RetryKind | null; message?: string | null }
  | { type: "serverState"; fileId: string; file: ServerFileState }
  | { type: "ragRequested"; fileId: string }
  | { type: "indexFailed"; fileId: string; message?: string | null }
  | { type: "retryQueued"; key: string }
  | { type: "unlinkFailed"; key: string; message?: string | null }
  | { type: "remove"; key: string }
  | { type: "markSent" };

function patch(state: ComposerAttachment[], match: (a: ComposerAttachment) => boolean, fn: (a: ComposerAttachment) => ComposerAttachment) {
  let changed = false;
  const next = state.map((a) => {
    if (!match(a)) return a;
    changed = true;
    return fn(a);
  });
  return changed ? next : state;
}

function withServer(a: ComposerAttachment, file: ServerFileState, ragRequested: boolean): ComposerAttachment {
  const mime = file.mime_type ?? a.mime;
  const mapped = phaseForServerStatus(file.status, mime, ragRequested);
  return {
    ...a,
    fileId: file.id,
    mime,
    size: file.size_bytes ?? a.size,
    serverStatus: file.status,
    ragRequested,
    progress: mapped.phase === "indexing" ? indexingProgress(file.rag_total_chunks, file.rag_done_chunks) : null,
    errorMessage: file.status === "rag_failed" ? file.rag_error ?? null : null,
    ...mapped,
  };
}

export function attachmentsReducer(state: ComposerAttachment[], action: AttachmentAction): ComposerAttachment[] {
  switch (action.type) {
    case "add":
      return [
        ...state,
        ...action.items.map<ComposerAttachment>((i) => ({
          key: i.key,
          fileId: null,
          name: displayFileName(i.name),
          size: i.size,
          mime: i.mime || null,
          phase: i.error ? "error" : "selected",
          progress: null,
          serverStatus: null,
          ragRequested: false,
          aiContext: false,
          errorKind: i.error?.kind ?? null,
          errorMessage: i.error?.message ?? null,
          retry: null,
          scope: "draft",
        })),
      ];
    case "uploadStart":
      return patch(state, (a) => a.key === action.key, (a) => ({
        ...a, phase: "uploading", progress: 0, errorKind: null, errorMessage: null, retry: null,
      }));
    case "uploadProgress":
      return patch(state, (a) => a.key === action.key && (a.phase === "uploading" || a.phase === "processing"), (a) =>
        action.percent >= 100
          ? { ...a, phase: "processing", progress: null }
          : { ...a, phase: "uploading", progress: Math.max(0, Math.min(99, Math.round(action.percent))) },
      );
    case "uploadDone":
      return patch(state, (a) => a.key === action.key, (a) => withServer(a, action.file, action.ragRequested));
    case "uploadFailed":
      return patch(state, (a) => a.key === action.key, (a) => ({
        ...a, phase: "error", progress: null, errorKind: action.kind, errorMessage: action.message ?? null, retry: action.retry,
      }));
    case "serverState":
      return patch(state, (a) => a.fileId === action.fileId, (a) => withServer(a, action.file, a.ragRequested));
    case "ragRequested":
      return patch(state, (a) => a.fileId === action.fileId, (a) => ({
        ...a, ragRequested: true, phase: "indexing", aiContext: false, progress: null, errorKind: null, errorMessage: null, retry: null,
      }));
    case "indexFailed":
      return patch(state, (a) => a.fileId === action.fileId, (a) => ({
        ...a, phase: "error", progress: null, errorKind: "indexFailed", errorMessage: action.message ?? null, retry: "rag",
      }));
    case "retryQueued":
      return patch(state, (a) => a.key === action.key, (a) => ({
        ...a, phase: "selected", progress: null, errorKind: null, errorMessage: null, retry: null,
      }));
    case "unlinkFailed":
      return patch(state, (a) => a.key === action.key, (a) => ({
        ...a, errorKind: "unlinkFailed", errorMessage: action.message ?? null,
      }));
    case "remove":
      return state.filter((a) => a.key !== action.key);
    case "markSent":
      // ما رُبط بالمحادثة ولم يفشل صار سياقًا لها؛ والفاشل والجاري يبقيان أمام صاحبهما
      return patch(
        state,
        (a) => a.scope === "draft" && a.fileId !== null && a.phase !== "error" && a.phase !== "processing",
        (a) => ({ ...a, scope: "context" }),
      );
    default:
      return state;
  }
}

/** لا يُرسل ما لم يُربط بعد: الرسالة لن ترى ملفًّا في منتصف رفعه */
export function blocksSend(attachments: ComposerAttachment[]): boolean {
  return attachments.some(
    (a) => a.scope === "draft" && (a.phase === "selected" || a.phase === "uploading" || a.phase === "processing"),
  );
}

/** لا يُزال ملفٌّ وصلت بايتاته والخادم يعالجه: إزالته الآن تترك ملفًّا يُربط بعدها */
export function canRemove(a: ComposerAttachment): boolean {
  return a.phase !== "processing";
}

export type AttachmentNotice = "imageAttachmentNotice" | "ragAttachmentReady" | "attachmentNotice" | null;

/** إشعار السياق تحت البطاقات — نفس منطق الشريط السابق، على ما رُبط فعلًا */
export function attachmentNotice(attachments: ComposerAttachment[]): AttachmentNotice {
  const linked = attachments.filter((a) => a.fileId !== null && a.phase !== "error");
  if (linked.length === 0) return null;
  if (linked.every((a) => isImageMime(a.mime))) return "imageAttachmentNotice";
  const docs = linked.filter((a) => !isImageMime(a.mime));
  const anyReady = docs.some((a) => a.aiContext);
  const anyPending = docs.some((a) => !a.aiContext);
  return anyReady && !anyPending ? "ragAttachmentReady" : "attachmentNotice";
}
