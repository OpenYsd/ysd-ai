import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { cancelJobsForFile, getLatestJobForFile } from "@/lib/rag/jobs";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** إلغاء وظيفة تجهيز RAG نشطة لملف — يفقد العامل قفله عند النبضة التالية */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const { data: file } = await supabase
    .from("files")
    .select("id, status")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!file) return json({ error: "الملف غير موجود | File not found" }, 404);

  await cancelJobsForFile(supabase, id, user.id);
  // أعد حالة الملف إلى ما قبل التجهيز إن كان في منتصفه
  if (["chunking", "embedding"].includes(file.status)) {
    await supabase
      .from("files")
      .update({ status: "ready", rag_error: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
  }

  const job = await getLatestJobForFile(supabase, id, user.id);
  return json({ ok: true, job }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
