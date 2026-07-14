/**
 * استخراج النص الحقيقي من الملفات — لا ادعاء نجاح عند نص فارغ.
 * TXT/MD: قراءة مع تحقق الترميز · PDF: unpdf · DOCX: mammoth.
 * الصور: لا استخراج في هذه المرحلة (بلا OCR).
 */

export type ExtractResult =
  | {
      ok: true;
      text: string;
      meta?: Record<string, unknown>;
      /** نصوص الصفحات (PDF) — للحفاظ على أرقام الصفحات في RAG */
      pages?: string[];
    }
  | { ok: false; error: string };

const EMPTY_ERROR = "الملف لا يحتوي نصًا قابلًا للاستخراج.";

function decodeText(buffer: Buffer): ExtractResult {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { ok: true, text };
  } catch {
    /* ليس UTF-8 — جرّب ترميز ويندوز العربي الشائع */
  }
  try {
    const text = new TextDecoder("windows-1256").decode(buffer);
    return { ok: true, text };
  } catch {
    return { ok: false, error: "تعذّر التعرف على ترميز النص. احفظ الملف بترميز UTF-8 وأعد رفعه." };
  }
}

export async function extractText(
  mime: string,
  fileName: string,
  buffer: Buffer,
): Promise<ExtractResult> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";

  try {
    if (ext === "txt" || ext === "md" || ext === "markdown") {
      const decoded = decodeText(buffer);
      if (!decoded.ok) return decoded;
      if (!decoded.text.trim()) return { ok: false, error: EMPTY_ERROR };
      return { ok: true, text: decoded.text };
    }

    if (ext === "pdf") {
      const { extractText: pdfExtract, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(new Uint8Array(buffer));
      // بدون دمج — نحتفظ بنص كل صفحة لأرقام الصفحات في RAG
      const { text, totalPages } = await pdfExtract(doc, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]).map((p) => (p ?? "").trim());
      const merged = pages.join("\n\n").trim();
      if (!merged) {
        return {
          ok: false,
          error: "لا يحتوي PDF على نص قابل للاستخراج (قد يكون صورًا ممسوحة — OCR غير مدعوم بعد).",
        };
      }
      return { ok: true, text: merged, meta: { pages: totalPages }, pages };
    }

    if (ext === "docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.trim();
      if (!text) return { ok: false, error: EMPTY_ERROR };
      return { ok: true, text };
    }

    return { ok: false, error: "هذا النوع لا يدعم استخراج النص." };
  } catch {
    // لا نُسرّب تفاصيل داخلية — رسالة آمنة والتفاصيل تبقى خارج قاعدة البيانات
    return { ok: false, error: "فشل استخراج النص — الملف تالف أو غير مدعوم البنية." };
  }
}

/** حد أقصى لتخزين النص المستخرج (يمنع تضخم قاعدة البيانات) */
export const MAX_EXTRACTED_CHARS = 500_000;
