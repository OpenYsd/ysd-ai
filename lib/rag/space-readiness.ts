/**
 * هل الملف مكتمل التضمين في الفضاء الفعّال؟
 *
 * الحالة الوحيدة التي يفترق فيها «status = ready_for_rag» عن «متجهات الفضاء موجودة» هي ملفٌّ جُهِّز أصلًا في
 * فضاء F2LLM (بلا متجه e5) ثم رجع الفضاء الفعّال إلى e5 — تراجعٌ ناعم أو كامل. فيُعدّ فعليًّا في الفضاءين:
 *   e5:    كل مقاطعه تحمل متجه e5 (384).
 *   F2LLM: كل مقاطعه تحمل متجه v2 بوسم هذا النموذج بالضبط (وسمُ الملف `rag_v2_model` وحده لا يكفي؛ قد يبقى
 *          قديمًا إن أُعيد تقطيع الملف بعَلَمٍ مطفأ).
 * ولا يغيّر هذا سلوكَ أي حالةٍ كانت قائمة قبل الترحيل: هناك «جاهز» يعني دائمًا أن كل المقاطع مضمَّنة بـe5.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingSpace } from "./embedding-space";

export async function isFileEmbeddedInSpace(
  supabase: SupabaseClient,
  fileId: string,
  space: EmbeddingSpace,
  totalChunks: number,
): Promise<boolean> {
  if (totalChunks <= 0) return false;
  const base = supabase.from("file_chunks").select("id", { count: "exact", head: true }).eq("file_id", fileId);
  const { count } = await (space.id === "f2llm" ? base.eq("embedding_v2_model", space.modelTag as string) : base.not("embedding", "is", null));
  return (count ?? 0) === totalChunks;
}
