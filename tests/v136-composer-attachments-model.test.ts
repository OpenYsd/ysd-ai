import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALLOWED_TYPES } from "@/lib/files/config";
import {
  acceptAttribute,
  attachmentNotice,
  attachmentsReducer,
  blocksSend,
  canRemove,
  classifyUploadFailure,
  displayFileName,
  fromServerFile,
  isIndexingStalled,
  isPasteableImage,
  localizeServerMessage,
  pastedImageName,
  phaseForServerStatus,
  splitFileName,
  validateSelection,
  type AttachmentAction,
  type ComposerAttachment,
} from "@/lib/chat/composer-attachments";

/**
 * مرفقات شريط الكتابة — النموذج الخالص (المرحلة الأولى).
 *
 * ★ الأسئلة هنا عن الدلالة لا الشكل: متى يصير الملف «جاهزًا»؟ ماذا يعني الإرسال
 *   لمرفقٍ لم يكتمل رفعه؟ وهل تبقى حدودُ الخادم حدودَ الخادم؟
 */

const MB = 1024 * 1024;

function reduce(actions: Parameters<typeof attachmentsReducer>[1][], start: ComposerAttachment[] = []) {
  return actions.reduce(attachmentsReducer, start);
}

const add = (key: string, name: string, size: number, mime: string): AttachmentAction => ({
  type: "add",
  items: [{ key, name, size, mime }],
});

describe("★ (١) الأنواع والحدود من الخادم لا من الواجهة", () => {
  it("★ ★ ★ سمة accept تُشتقّ من الأنواع المسموحة نفسها — بلا ZIP ولا نوعٍ مخترع", () => {
    const accept = acceptAttribute().split(",");
    const allowed = ALLOWED_TYPES.flatMap((t) => t.exts.map((e) => `.${e}`));
    expect(accept).toEqual(allowed);
    expect(accept).not.toContain(".zip");
    expect(accept).not.toContain(".exe");
  });

  it("★ ★ ★ التحقّق المسبق يطابق قاعدة الخادم: الامتداد وMIME معًا", () => {
    expect(validateSelection({ name: "a.pdf", type: "application/pdf", size: 10 }, null)).toBeNull();
    expect(validateSelection({ name: "a.zip", type: "application/zip", size: 10 }, null)).toEqual({ kind: "unsupported" });
    // امتدادٌ مسموح بـMIME مخالف — الخادم يرفضه، فلا يُرفع ليُرفض
    expect(validateSelection({ name: "evil.pdf", type: "application/x-msdownload", size: 10 }, null)).toEqual({ kind: "unsupported" });
    expect(validateSelection({ name: "a.txt", type: "text/plain", size: 0 }, null)).toEqual({ kind: "empty" });
  });

  it("★ ★ ★ الحجم بحدّ الخادم المُعاد، ولا رقمَ مكتوبٌ في الوحدة", () => {
    expect(validateSelection({ name: "a.pdf", type: "application/pdf", size: 25 * MB }, 25)).toBeNull();
    expect(validateSelection({ name: "a.pdf", type: "application/pdf", size: 25 * MB + 1 }, 25)).toEqual({ kind: "tooLarge", limitMb: 25 });
    expect(validateSelection({ name: "a.pdf", type: "application/pdf", size: 900 * MB }, 10)).toEqual({ kind: "tooLarge", limitMb: 10 });
    // حدٌّ مجهول (تعذّر جلبه): لا تخمين — الخادم يقرّر
    expect(validateSelection({ name: "a.pdf", type: "application/pdf", size: 900 * MB }, null)).toBeNull();
    const src = readFileSync("lib/chat/composer-attachments.ts", "utf8");
    expect(src).not.toMatch(/\b(25|50)\s*\*\s*1024/);
    expect(src).not.toMatch(/maxFileMb\s*=\s*\d/);
  });

  it("★ ★ ★ اللصق يلتقط صور الخادم فقط، باسمٍ مولَّد", () => {
    expect(isPasteableImage("image/png")).toBe(true);
    expect(isPasteableImage("image/webp")).toBe(true);
    expect(isPasteableImage("image/gif")).toBe(false);
    expect(isPasteableImage("image/svg+xml")).toBe(false);
    const name = pastedImageName("image/jpeg", new Date(2026, 8, 17, 9, 5, 7));
    expect(name).toBe("pasted-image-20260917-090507.jpg");
  });
});

describe("★ (٢) الاسم نصٌّ لا يخدع", () => {
  it("★ ★ ★ محارف التحكّم ثنائيّة الاتّجاه تُنزع — لا exe يتنكّر في jpg", () => {
    const spoof = "photo\u202Egpj.exe";
    expect(displayFileName(spoof)).toBe("photogpj.exe");
    expect(displayFileName("a\u2066b\u2069c\u200Fd")).toBe("abcd");
    expect(displayFileName("bad\u0000name\u0007.pdf")).toBe("badname.pdf");
    expect(displayFileName("   ")).toBe("file");
  });

  it("★ ★ ★ والعربيّة ووصلاتُها سليمة", () => {
    expect(displayFileName("تقرير‌نهائي.pdf")).toBe("تقرير‌نهائي.pdf");
  });

  it("★ ★ ★ الامتداد يبقى ظاهرًا حين يُقصّ الاسم", () => {
    expect(splitFileName("تقرير الربع الأول.docx")).toEqual({ stem: "تقرير الربع الأول", ext: ".docx" });
    expect(splitFileName(".hidden")).toEqual({ stem: ".hidden", ext: "" });
    expect(splitFileName("noext")).toEqual({ stem: "noext", ext: "" });
  });

  it("★ ★ ★ رسالة الخادم بلغة الواجهة", () => {
    const msg = "نوع الملف غير مدعوم | Unsupported file type";
    expect(localizeServerMessage(msg, "ar")).toBe("نوع الملف غير مدعوم");
    expect(localizeServerMessage(msg, "en")).toBe("Unsupported file type");
    expect(localizeServerMessage("HTTP 502", "ar")).toBe("HTTP 502");
    expect(localizeServerMessage(undefined, "en")).toBeNull();
  });
});

describe("★ (٣) حالات البطاقة — ما يقوله الخادم لا ما نتمنّاه", () => {
  it("★ ★ ★ الصورة جاهزة بلا سياق AI، والمستند جاهزٌ فقط عند ready_for_rag", () => {
    expect(phaseForServerStatus("ready", "image/png", false)).toMatchObject({ phase: "ready", aiContext: false });
    expect(phaseForServerStatus("ready", "application/pdf", true)).toMatchObject({ phase: "indexing" });
    expect(phaseForServerStatus("ready", "application/pdf", false)).toMatchObject({ phase: "ready", aiContext: false, retry: "rag" });
    expect(phaseForServerStatus("chunking", "application/pdf", true)).toMatchObject({ phase: "indexing" });
    expect(phaseForServerStatus("ready_for_rag", "application/pdf", true)).toMatchObject({ phase: "ready", aiContext: true });
    expect(phaseForServerStatus("failed", "application/pdf", false)).toMatchObject({ phase: "error", retry: "extract" });
    expect(phaseForServerStatus("rag_failed", "application/pdf", true)).toMatchObject({ phase: "error", retry: "rag" });
  });

  it("★ ★ ★ دورةٌ كاملة: مختار → رفع → معالجة → تجهيز بنسبة → جاهز", () => {
    let s = reduce([add("k1", "a.pdf", 2000, "application/pdf"), { type: "uploadStart", key: "k1" }]);
    expect(s[0]).toMatchObject({ phase: "uploading", progress: 0 });
    s = reduce([{ type: "uploadProgress", key: "k1", percent: 42 }], s);
    expect(s[0]).toMatchObject({ phase: "uploading", progress: 42 });
    s = reduce([{ type: "uploadProgress", key: "k1", percent: 100 }], s);
    expect(s[0]).toMatchObject({ phase: "processing", progress: null });
    s = reduce([{ type: "uploadDone", key: "k1", ragRequested: true, file: { id: "f1", status: "ready", mime_type: "application/pdf", size_bytes: 2000 } }], s);
    expect(s[0]).toMatchObject({ phase: "indexing", fileId: "f1" });
    s = reduce([{ type: "serverState", fileId: "f1", file: { id: "f1", status: "embedding", rag_total_chunks: 8, rag_done_chunks: 2 } }], s);
    expect(s[0]).toMatchObject({ phase: "indexing", progress: 25 });
    s = reduce([{ type: "serverState", fileId: "f1", file: { id: "f1", status: "ready_for_rag" } }], s);
    expect(s[0]).toMatchObject({ phase: "ready", aiContext: true, progress: null });
  });

  it("★ ★ ★ عدّة ملفّات مستقلّة الحالة", () => {
    const s = reduce([
      { type: "add", items: [
        { key: "a", name: "a.pdf", size: 1, mime: "application/pdf" },
        { key: "b", name: "b.png", size: 1, mime: "image/png" },
        { key: "c", name: "c.zip", size: 1, mime: "application/zip", error: { kind: "unsupported" } },
      ] },
      { type: "uploadStart", key: "a" },
      { type: "uploadProgress", key: "a", percent: 70 },
    ]);
    expect(s.map((a) => a.phase)).toEqual(["uploading", "selected", "error"]);
    expect(s[2]).toMatchObject({ errorKind: "unsupported", retry: null });
  });

  it("★ ★ ★ فشل الرفع: ما يُجدي إعادتُه فقط يُعرض له زرّ", () => {
    expect(classifyUploadFailure(429, "x")).toEqual({ kind: "rateLimited", retry: "upload" });
    expect(classifyUploadFailure(0, "network")).toEqual({ kind: "network", retry: "upload" });
    expect(classifyUploadFailure(503, "x")).toEqual({ kind: "server", retry: "upload" });
    expect(classifyUploadFailure(413, "x")).toEqual({ kind: "tooLarge", retry: null });
    expect(classifyUploadFailure(400, "x")).toEqual({ kind: "unsupported", retry: null });
    expect(classifyUploadFailure(403, "x")).toEqual({ kind: "quota", retry: null });
    expect(classifyUploadFailure(401, "x")).toEqual({ kind: "auth", retry: null });
    expect(classifyUploadFailure(404, "x")).toEqual({ kind: "notFound", retry: null });
  });

  it("★ ★ ★ إعادة المحاولة تُعيد المسوّدة إلى الطابور نظيفة", () => {
    const s = reduce([
      add("k", "a.pdf", 1, "application/pdf"),
      { type: "uploadFailed", key: "k", kind: "rateLimited", retry: "upload", message: "x" },
      { type: "retryQueued", key: "k" },
    ]);
    expect(s[0]).toMatchObject({ phase: "selected", errorKind: null, errorMessage: null, retry: null });
  });

  it("★ ★ ★ فشل إدراج التجهيز يبقى فشلًا مع إعادة", () => {
    const s = reduce([
      add("k", "a.pdf", 1, "application/pdf"),
      { type: "uploadDone", key: "k", ragRequested: true, file: { id: "f", status: "ready", mime_type: "application/pdf" } },
      { type: "indexFailed", fileId: "f", message: "Too many attempts" },
    ]);
    expect(s[0]).toMatchObject({ phase: "error", errorKind: "indexFailed", retry: "rag" });
  });
});

describe("★ (٤) الإرسال والدلالة: المحادثة لا الرسالة", () => {
  const linked = (key: string, fileId: string, status: string, mime = "application/pdf") =>
    reduce([add(key, `${key}.pdf`, 1, mime), { type: "uploadDone", key, ragRequested: status === "ready", file: { id: fileId, status, mime_type: mime } }]);

  it("★ ★ ★ لا إرسال وملفٌّ في منتصف رفعه", () => {
    expect(blocksSend(reduce([add("k", "a.pdf", 1, "application/pdf")]))).toBe(true);
    expect(blocksSend(reduce([add("k", "a.pdf", 1, "application/pdf"), { type: "uploadStart", key: "k" }]))).toBe(true);
    expect(blocksSend(reduce([add("k", "a.zip", 1, "application/zip"), { type: "uploadFailed", key: "k", kind: "unsupported", retry: null }]))).toBe(false);
  });

  /**
   * ★ التجهيز يحجب الآن — وكان لا يحجب.
   *
   * القرار السابق: لا نسجن المحادثة بفهرسةٍ تطول، ونكتفي بإشعار. والواقع أن
   * المستخدم يسأل رغم الإشعار (وهو محقّ: البطاقة أمامه)، فيخرج الاسترجاع
   * فارغًا فينفي النموذجُ وجودَ ملفه. قيس حيًّا في الإنتاج، وهو أكثر ما يهدم
   * الثقة في المرفقات. فالوعد الآن صريح: لا إرسالَ قبل أن يصير الملف مقروءًا.
   */
  it("★ ★ ★ التجهيز الجاري يحجب الإرسال — لا سؤال عن ملفٍ لا يُقرأ بعد", () => {
    expect(blocksSend(linked("k", "f", "chunking"))).toBe(true);
    expect(blocksSend(linked("k", "f", "embedding"))).toBe(true);
    expect(blocksSend(linked("k", "f", "uploaded"))).toBe(true);
    expect(blocksSend(linked("k", "f", "ready_for_rag"))).toBe(false);
  });

  /**
   * ★ ولا يُسجن أحدٌ إلى الأبد.
   *
   * حجبٌ بلا مخرجٍ أسوأ من العطب الذي يعالجه: في الإنتاج الآن عشرة ملفات
   * عالقة على `ready` لم تُفهرس قط. لو حجبت هذه أبدًا لتعطّلت محادثاتُها
   * نهائيًّا. فالمتوقّف يصير `error` (كشفُ التوقّف قائمٌ في isStalled) —
   * والخطأ لا يحجب، بل يعرض إعادةَ المحاولة.
   */
  it("★ ★ ★ المتوقّف والفاشل لا يحجبان — لا محادثةَ تُسجن بملفٍ عالق", () => {
    const stalled = reduce([
      add("k", "a.pdf", 1, "application/pdf"),
      { type: "uploadDone", key: "k", ragRequested: true, file: { id: "f", status: "ready", mime_type: "application/pdf" } },
      { type: "indexFailed", fileId: "f", kind: "indexStalled", message: "stalled" },
    ]);
    expect(stalled[0]).toMatchObject({ phase: "error" });
    expect(blocksSend(stalled)).toBe(false);
  });

  /**
   * ★ الصور: لا تُفهرس، فلا تُنتظر فهرسةٌ لا تأتي — لكنّ بايتاتها تُنتظر.
   *
   * الإعفاءُ من الفهرسة ليس إعفاءً من الرفع: صورةٌ في منتصف طريقها ليست
   * مرفقةً بعد، وإرسالُ السؤال حينها يصل بلا صورة.
   */
  it("★ ★ ★ الصورة المرتبطة لا تحجب، والصورةُ في منتصف رفعها تحجب", () => {
    expect(blocksSend(linked("k", "f", "ready", "image/png"))).toBe(false);
    expect(blocksSend(reduce([add("k", "a.png", 1, "image/png")]))).toBe(true);
    expect(
      blocksSend(reduce([add("k", "a.png", 1, "image/png"), { type: "uploadStart", key: "k" }])),
    ).toBe(true);
  });

  it("★ ★ ★ بعد الإرسال: المربوط صار سياقًا للمحادثة، والفاشل يبقى أمام صاحبه", () => {
    let s = [...linked("a", "fa", "ready_for_rag"), ...reduce([add("b", "b.pdf", 1, "application/pdf"), { type: "uploadFailed", key: "b", kind: "network", retry: "upload" }])];
    s = attachmentsReducer(s, { type: "markSent" });
    expect(s.find((x) => x.key === "a")?.scope).toBe("context");
    expect(s.find((x) => x.key === "b")?.scope).toBe("draft");
  });

  it("★ ★ ★ ملفّات المحادثة المحمَّلة من الخادم سياقٌ لا مسوّدة، بحجمها", () => {
    const a = fromServerFile({ id: "f9", original_name: "عقد.pdf", status: "embedding", mime_type: "application/pdf", size_bytes: 4096, rag_total_chunks: 10, rag_done_chunks: 5 });
    expect(a).toMatchObject({ scope: "context", fileId: "f9", phase: "indexing", progress: 50, size: 4096, key: "file:f9" });
  });

  it("★ ★ ★ ولا إزالة لملفٍّ وصلت بايتاته والخادم يعالجه", () => {
    const s = reduce([add("k", "a.pdf", 1, "application/pdf"), { type: "uploadStart", key: "k" }, { type: "uploadProgress", key: "k", percent: 100 }]);
    expect(canRemove(s[0] as ComposerAttachment)).toBe(false);
    const up = reduce([add("k", "a.pdf", 1, "application/pdf"), { type: "uploadStart", key: "k" }]);
    expect(canRemove(up[0] as ComposerAttachment)).toBe(true);
  });

  it("★ ★ ★ مسوّداتٌ عبرت إعادة التركيب تحلّ محلّ نسختها من الخادم — بطاقةٌ واحدة لكل ملف", () => {
    const server = fromServerFile({ id: "fx", original_name: "x.pdf", status: "ready", mime_type: "application/pdf", size_bytes: 10 });
    const other = fromServerFile({ id: "fy", original_name: "y.pdf", status: "ready_for_rag", mime_type: "application/pdf", size_bytes: 10 });
    const carriedLinked = { ...(linked("k1", "fx", "ready")[0] as ComposerAttachment) };
    const carriedQueued = { ...(reduce([add("k2", "q.pdf", 1, "application/pdf")])[0] as ComposerAttachment) };
    const s = attachmentsReducer([server, other], { type: "restore", items: [carriedLinked, carriedQueued] });
    expect(s.map((a) => [a.key, a.scope])).toEqual([["file:fy", "context"], ["k1", "draft"], ["k2", "draft"]]);
    // وتكرار التبنّي (StrictMode) لا يُكرّر البطاقات
    expect(attachmentsReducer(s, { type: "restore", items: [carriedLinked, carriedQueued] })).toHaveLength(3);
  });

  it("★ ★ ★ ورفعٌ يكتمل لملفٍّ ظهر من الخادم قبل ردّه لا يترك بطاقتين", () => {
    const server = fromServerFile({ id: "fz", original_name: "z.pdf", status: "ready", mime_type: "application/pdf", size_bytes: 10 });
    const s = reduce(
      [add("k", "z.pdf", 10, "application/pdf"), { type: "uploadStart", key: "k" }, { type: "uploadDone", key: "k", ragRequested: true, file: { id: "fz", status: "ready", mime_type: "application/pdf" } }],
      [server],
    );
    expect(s.map((a) => [a.key, a.fileId, a.scope])).toEqual([["k", "fz", "draft"]]);
  });

  it("★ ★ ★ الإشعار صادق: صور فقط · مستندات جاهزة · أو ما زال التجهيز جاريًا", () => {
    expect(attachmentNotice([])).toBeNull();
    expect(attachmentNotice(linked("i", "fi", "ready", "image/png"))).toBe("imageAttachmentNotice");
    expect(attachmentNotice(linked("d", "fd", "ready_for_rag"))).toBe("ragAttachmentReady");
    expect(attachmentNotice([...linked("d", "fd", "ready_for_rag"), ...linked("e", "fe", "chunking")])).toBe("attachmentNotice");
  });
});

describe("★ (٥) كشفُ التجهيز المتوقّف — من بيانات الخادم", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const opts = { leaseMs: 150_000, queuedGraceMs: 90_000 };

  it("★ ★ ★ نبضٌ أقدم من عقد الإيجار ⇒ متوقّف؛ ونبضٌ حيّ ⇒ بطءٌ مشروع", () => {
    expect(isIndexingStalled({ status: "embedding" }, { status: "running", heartbeat_at: ago(263) }, now, opts)).toBe(true);
    expect(isIndexingStalled({ status: "embedding" }, { status: "running", heartbeat_at: ago(20) }, now, opts)).toBe(false);
    expect(isIndexingStalled({ status: "embedding" }, { status: "running", heartbeat_at: null }, now, opts)).toBe(true);
  });

  it("★ ★ ★ مستحقّةٌ في الطابور بلا التقاط ⇒ متوقّفة؛ وموعدُها لم يحن ⇒ لا", () => {
    expect(isIndexingStalled({ status: "ready" }, { status: "queued", available_at: ago(300) }, now, opts)).toBe(true);
    expect(isIndexingStalled({ status: "embedding" }, { status: "retrying", available_at: ago(30) }, now, opts)).toBe(false);
    expect(isIndexingStalled({ status: "embedding" }, { status: "retrying", available_at: new Date(now + 60_000).toISOString() }, now, opts)).toBe(false);
  });

  it("★ ★ ★ لا وظيفةَ والملفُّ ينتظر ⇒ متوقّف؛ والحالاتُ النهائيّة لا تُستأنف أبدًا", () => {
    expect(isIndexingStalled({ status: "ready" }, null, now, opts)).toBe(true);
    expect(isIndexingStalled({ status: "ready_for_rag" }, { status: "running", heartbeat_at: ago(9999) }, now, opts)).toBe(false);
    expect(isIndexingStalled({ status: "rag_failed" }, null, now, opts)).toBe(false);
    expect(isIndexingStalled({ status: "embedding" }, { status: "completed" }, now, opts)).toBe(false);
  });
});
