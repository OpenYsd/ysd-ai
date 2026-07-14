import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { FILES_BUCKET } from "@/lib/files/service";

export const runtime = "nodejs";

const schema = z.object({ confirm: z.literal("DELETE") });

/**
 * حذف بيانات الحساب (لا حذف auth.users — يتطلب service role وموافقتك).
 * يلغي وظائف RAG، ويحذف المقاطع والملفات (من التخزين) والمشاريع والمحادثات
 * عبر جلسة المستخدم — RLS يضمن أنه لا يمس بيانات غيره. لا vectors يتيمة تبقى.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return json({ error: 'أرسل {"confirm":"DELETE"} للتأكيد | Confirmation required' }, 400);

  // 1) ألغِ كل وظائف RAG النشطة ثم احذفها كلها
  await supabase
    .from("rag_jobs")
    .update({ status: "cancelled", locked_by: null })
    .eq("user_id", user.id)
    .in("status", ["queued", "running", "retrying"]);

  // 2) احذف مقاطع وembeddings المستخدم (صلب)
  await supabase.from("file_chunks").delete().eq("user_id", user.id);

  // 3) احذف ملفات التخزين ثم صفوف الملفات
  const { data: files } = await supabase
    .from("files")
    .select("storage_path")
    .eq("user_id", user.id);
  const paths = (files ?? []).map((f) => f.storage_path as string).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) {
    await supabase.storage.from(FILES_BUCKET).remove(paths.slice(i, i + 100));
  }
  await supabase.from("files").delete().eq("user_id", user.id);
  await supabase.from("rag_jobs").delete().eq("user_id", user.id);

  // 4) احذف المشاريع والمحادثات (الرسائل تُحذف تعاقبيًا عبر FK)
  await supabase.from("conversations").delete().eq("user_id", user.id);
  await supabase.from("projects").delete().eq("user_id", user.id);

  // 5) تحقق: لا مقاطع/متجهات يتيمة للمستخدم
  const { count: orphanChunks } = await supabase
    .from("file_chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  return json(
    {
      ok: true,
      orphanChunks: orphanChunks ?? 0,
      note: "بيانات الحساب حُذفت. حذف حساب المصادقة نفسه يتطلب service role وموافقتك.",
    },
    200,
  );
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
