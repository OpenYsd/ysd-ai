/**
 * هل الملف مكتمل التضمين في الفضاء الفعّال؟
 *
 * e5: كما كان — اكتمالُه يقرّره `status` و`rag_content_hash` وحدهما (لا استعلام إضافي).
 * F2LLM: لا يكفي وسمُ الملف `rag_v2_model` (قد يبقى قديمًا إن أُعيد تقطيع الملف بعَلَمٍ مطفأ)؛
 *        فيُعدّ فعليًّا: كل مقاطعه تحمل متجه v2 بوسم هذا النموذج بالضبط.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingSpace } from "./embedding-space";

export async function isFileEmbeddedInSpace(
  supabase: SupabaseClient,
  fileId: string,
  space: EmbeddingSpace,
  totalChunks: number,
): Promise<boolean> {
  if (space.id !== "f2llm") return true;
  if (totalChunks <= 0) return false;
  const { count } = await supabase
    .from("file_chunks")
    .select("id", { count: "exact", head: true })
    .eq("file_id", fileId)
    .eq("embedding_v2_model", space.modelTag as string);
  return (count ?? 0) === totalChunks;
}
