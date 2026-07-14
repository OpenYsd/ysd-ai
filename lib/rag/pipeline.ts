/**
 * خط تجهيز الملف لـ RAG:
 * chunking → embedding → حفظ — مع تقدم حقيقي وحالات واضحة.
 * لا يُعلن النجاح (ready_for_rag) إلا بعد حفظ كل المقاطع والمتجهات.
 * كل شيء بعميل جلسة المستخدم — RLS نافذ، بلا service role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { FILES_BUCKET } from "@/lib/files/service";
import { extractText } from "@/lib/files/extract";
import { chunkText, contentHash, type Chunk } from "./chunking";
import { getEmbeddingProvider } from "./embeddings";

const INSERT_BATCH = 16;

export interface RagLimits {
  maxChunksPerFile: number;
  maxTotalChunks: number;
}

export async function getRagLimits(
  supabase: SupabaseClient,
  userId: string,
): Promise<RagLimits> {
  const { data: sub } = await supabase
    .from("subscriptions").select("tier").eq("user_id", userId).maybeSingle();
  const { data } = await supabase
    .from("usage_limits")
    .select("max_chunks_per_file, max_total_chunks")
    .eq("tier", (sub?.tier as string | undefined) ?? "free")
    .maybeSingle();
  return {
    maxChunksPerFile: (data?.max_chunks_per_file as number | undefined) ?? 200,
    maxTotalChunks: (data?.max_total_chunks as number | undefined) ?? 2000,
  };
}

interface RagFileRow {
  id: string;
  user_id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  status: string;
  extracted_text: string | null;
  rag_content_hash: string | null;
}

export type RagResult =
  | { ok: true; totalChunks: number; skipped?: boolean }
  | { ok: false; error: string };

/** تجهيز ملف لـ RAG — يُستدعى من مسار API بعد تحقق الملكية */
export async function prepareFileForRag(
  supabase: SupabaseClient,
  file: RagFileRow,
): Promise<RagResult> {
  const now = () => new Date().toISOString();
  const failWith = async (error: string): Promise<RagResult> => {
    await supabase
      .from("files")
      .update({ status: "rag_failed", rag_error: error, updated_at: now() })
      .eq("id", file.id);
    return { ok: false, error };
  };

  // الصور غير مدعومة (بلا OCR في هذه المرحلة)
  if (file.mime_type.startsWith("image/")) {
    return { ok: false, error: "الصور غير مدعومة في سياق الذكاء الاصطناعي حاليًا (بلا OCR بعد)." };
  }
  if (!file.extracted_text || !file.extracted_text.trim()) {
    return failWith("لا يوجد نص مستخرج — أعد معالجة الملف أولًا.");
  }

  // hash الملف: إن لم يتغير المحتوى والمقاطع جاهزة → لا إعادة إنشاء
  const fileHash = contentHash(file.extracted_text);
  if (file.rag_content_hash === fileHash && file.status === "ready_for_rag") {
    const { count } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id);
    if ((count ?? 0) > 0) return { ok: true, totalChunks: count ?? 0, skipped: true };
  }

  try {
    // ===== chunking =====
    await supabase
      .from("files")
      .update({ status: "chunking", rag_error: null, rag_total_chunks: null, rag_done_chunks: 0, updated_at: now() })
      .eq("id", file.id);

    let chunks: Chunk[];
    if (file.mime_type === "application/pdf") {
      // إعادة استخراج بالصفحات — للحفاظ على أرقام الصفحات
      const { data: blob, error: dlError } = await supabase.storage
        .from(FILES_BUCKET)
        .download(file.storage_path);
      if (dlError || !blob) return await failWith("تعذّر قراءة الملف من التخزين.");
      const extracted = await extractText(
        file.mime_type,
        file.original_name,
        Buffer.from(await blob.arrayBuffer()),
      );
      if (!extracted.ok) return await failWith(extracted.error);
      chunks = extracted.pages
        ? chunkText(extracted.pages.map((text, i) => ({ pageNumber: i + 1, text })))
        : chunkText(extracted.text);
    } else {
      chunks = chunkText(file.extracted_text);
    }

    if (chunks.length === 0) return await failWith("لم ينتج التقسيم أي مقاطع صالحة.");

    // ===== الحدود المركزية =====
    const limits = await getRagLimits(supabase, file.user_id);
    if (chunks.length > limits.maxChunksPerFile) {
      chunks = chunks.slice(0, limits.maxChunksPerFile);
    }
    const { count: existingTotal } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", file.user_id)
      .neq("file_id", file.id);
    if ((existingTotal ?? 0) + chunks.length > limits.maxTotalChunks) {
      return await failWith(
        `بلغت الحد الأقصى لإجمالي مقاطع الملفات في باقتك (${limits.maxTotalChunks}). احذف ملفات قديمة أولًا.`,
      );
    }

    // ===== استبدال آمن: حذف المقاطع القديمة =====
    const { error: delError } = await supabase
      .from("file_chunks")
      .delete()
      .eq("file_id", file.id);
    if (delError) return await failWith("تعذّر تنظيف المقاطع القديمة.");

    // ===== embedding =====
    await supabase
      .from("files")
      .update({ status: "embedding", rag_total_chunks: chunks.length, rag_done_chunks: 0, updated_at: now() })
      .eq("id", file.id);

    const provider = getEmbeddingProvider();
    const vectors = await provider.embedPassages(
      chunks.map((c) => c.content),
      (done) => {
        // تقدم حقيقي — أخطاء التحديث هنا لا توقف المعالجة
        void supabase
          .from("files")
          .update({ rag_done_chunks: done, updated_at: now() })
          .eq("id", file.id)
          .then(() => undefined);
      },
    );
    if (vectors.length !== chunks.length) {
      return await failWith("عدد المتجهات لا يطابق عدد المقاطع — أُلغيت العملية.");
    }

    // ===== الحفظ على دفعات =====
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const rows = chunks.slice(i, i + INSERT_BATCH).map((c, j) => ({
        file_id: file.id,
        user_id: file.user_id,
        chunk_index: c.index,
        content: c.content,
        character_count: c.characterCount,
        page_number: c.pageNumber,
        content_hash: c.hash,
        embedding: JSON.stringify(vectors[i + j]),
        metadata: { file_name: file.original_name, file_id: file.id },
      }));
      const { error: insError } = await supabase.from("file_chunks").insert(rows);
      if (insError) {
        console.error(`[rag] chunk insert failed: code=${insError.code}`);
        // تراجع كامل — لا مقاطع ناقصة
        await supabase.from("file_chunks").delete().eq("file_id", file.id);
        return await failWith("تعذّر حفظ المقاطع — أُعيد كل شيء وأُلغيت العملية.");
      }
    }

    // ===== تحقق نهائي قبل إعلان النجاح =====
    const { count: savedCount } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id);
    if ((savedCount ?? 0) !== chunks.length) {
      await supabase.from("file_chunks").delete().eq("file_id", file.id);
      return await failWith("التحقق النهائي فشل — عدد المقاطع المحفوظة غير مكتمل.");
    }

    await supabase
      .from("files")
      .update({
        status: "ready_for_rag",
        rag_total_chunks: chunks.length,
        rag_done_chunks: chunks.length,
        rag_content_hash: fileHash,
        rag_error: null,
        updated_at: now(),
      })
      .eq("id", file.id);

    return { ok: true, totalChunks: chunks.length };
  } catch (err) {
    // لا نسجل محتوى الملف — رسالة الحالة فقط
    console.error(`[rag] pipeline failed: ${(err as Error).message?.slice(0, 100)}`);
    return await failWith("فشل تجهيز الملف للذكاء الاصطناعي. أعد المحاولة.");
  }
}
