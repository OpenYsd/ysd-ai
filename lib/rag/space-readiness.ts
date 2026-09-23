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

/**
 * ملفٌّ على `chunking`/`embedding` ومقاطعُه كاملةٌ في الفضاء الفعّال ⇒ يُعاد إلى
 * `ready_for_rag`. يعيد true إن كان كاملًا (أُعيدت حالتُه أو كانت كذلك).
 *
 * ★ لماذا يلزم: وظيفةُ فضاءٍ آخر تقلب حالةَ ملفٍّ جاهزٍ إلى `embedding` ثمّ تموت
 *   (إعادةُ تشغيلٍ في منتصفها). متجهاتُ الفضاء الفعّال سليمة، لكن الحالة عالقة،
 *   ووظيفةُ الفضاء الفعّال لا تُنشأ من جديد (مفتاحُها مكتمل) — فلا شيء يحرّكه.
 *   رُصد حيًّا على staging عبر قلبَي الفضاء. التحديثُ مشروطٌ بالحالة نفسها
 *   (`in chunking/embedding`) فلا يسابق عاملًا أنهى للتوّ.
 */
export async function settleIfCompleteInSpace(
  supabase: SupabaseClient,
  fileId: string,
  userId: string,
  space: EmbeddingSpace,
): Promise<boolean> {
  const { count } = await supabase
    .from("file_chunks")
    .select("id", { count: "exact", head: true })
    .eq("file_id", fileId);
  if (!count || !(await isFileEmbeddedInSpace(supabase, fileId, space, count))) return false;
  const patch: Record<string, unknown> = { status: "ready_for_rag", rag_done_chunks: count, rag_total_chunks: count };
  if (space.id === "f2llm") patch.rag_v2_model = space.modelTag;
  await supabase
    .from("files")
    .update(patch)
    .eq("id", fileId)
    .eq("user_id", userId)
    .in("status", ["chunking", "embedding"]);
  return true;
}

/**
 * أيُّ هذه الملفات ينقصه متجهُ الفضاء الفعّال؟ — استعلامٌ واحدٌ للمجموعة كلِّها.
 *
 * ★ لماذا لا يكفي وسمُ الملف (`rag_v2_model`) في الاتّجاهين.
 *
 *   الوسمُ يكشف اتّجاهًا واحدًا: e5 ← F2LLM. أمّا العكس — ملفٌّ فُهرس في نافذة
 *   F2LLM ثمّ رجع الفضاءُ إلى e5 — فحالتُه `ready_for_rag` ولا وسمَ ينفيه،
 *   ومقاطعُه بلا متجهِ e5 أصلًا. فيُعَدّ «جاهزًا» ويخرج الاسترجاعُ فارغًا:
 *   وهو بعينُه ما وقع في الإنتاج (أربعةُ ملفّات بصفر مقاطع e5).
 *
 * ★ والسؤالُ يُقلب ليُجاب باستعلامٍ واحد: لا «كم مقطعًا مضمَّنًا لكلّ ملف»
 *   (استعلامٌ لكلّ ملف)، بل «أيُّ المقاطع ينقصه المتجه» — فظهورُ مقطعٍ واحد
 *   يكفي للحكم على ملفِّه. والحدُّ يمنع جلبَ مكتبةٍ كاملة.
 *
 * ★ وعند تعذّر الاستعلام تُرجَع مجموعةٌ فارغة: لا يُحجب ملفٌّ بسبب عطلِ شبكة.
 *   المقايضةُ مقصودة — الفشلُ هنا يميل إلى السلوك القائم لا إلى حجبٍ أوسع.
 */
export async function findFilesMissingActiveSpace(
  supabase: SupabaseClient,
  fileIds: string[],
  space: EmbeddingSpace,
): Promise<Set<string>> {
  const missing = new Set<string>();
  if (fileIds.length === 0) return missing;
  const base = () => supabase.from("file_chunks").select("file_id").in("file_id", fileIds);
  /**
   * ★ في F2LLM استعلامان لا `or(...)`: `neq` في SQL لا يطابق NULL (NULL <> x
   *   مجهول)، فالناقصُ وسمًا والموسومُ بنموذجٍ آخر حالتان منفصلتان. ووسمُ
   *   النموذج فيه نقاطٌ و`@` — وحشرُه داخل نصّ `or=()` يعرّضه لسوء التحليل.
   */
  const queries =
    space.id === "f2llm"
      ? [
          base().is("embedding_v2_model", null).limit(2000),
          base().neq("embedding_v2_model", space.modelTag as string).limit(2000),
        ]
      : [base().is("embedding", null).limit(2000)];
  const results = await Promise.all(queries);
  for (const { data, error } of results) {
    if (error) continue;
    for (const r of data ?? []) missing.add((r as { file_id: string }).file_id);
  }
  return missing;
}
