import type { SupabaseClient } from "@supabase/supabase-js";
import type { Check } from "./checks";

/**
 * فحص جاهزية عمود v2 (الترحيل 0048) — لا يُنفَّذ إلا حين يشتعل عَلَم F2LLM.
 *
 * ★ HEAD فقط بلا صفوف ولا RPC ولا كتابة، كفحص pgvector القائم: اسم عمودٍ ثابت لا محتوى مستخدم.
 * ★ في ملفٍّ مستقلّ عن checks.ts عمدًا: حارس «hotfix صحة الإنتاج» يعدّ فحوص HEAD في ذلك الملف (اثنان)،
 *   وهذا الفحص خاصٌّ بـstaging وخلف العَلَم، فلا يُضاف إلى مسار الإنتاج ولا يُخفَّف ذلك الحارس.
 */
export async function probeF2llmV2Column(supabase: SupabaseClient, timeoutMs = 3000): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      supabase.from("file_chunks").select("embedding_v2", { head: true }).limit(1),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (result === "timeout") return { status: "down", detail: "timeout" };
    return result.error ? { status: "down", detail: "v2_column_missing_or_unreadable" } : { status: "ok" };
  } catch {
    return { status: "down", detail: "v2_probe_failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
