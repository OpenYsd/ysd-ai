import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { linkFileSchema } from "@/lib/validation/files";
import { FILES_BUCKET, PUBLIC_FILE_FIELDS } from "@/lib/files/service";
import { getLatestJobForFile } from "@/lib/rag/jobs";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** تفاصيل ملف — بلا storage_path */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const { data } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return json({ error: "الملف غير موجود | File not found" }, 404);

  // حالة وظيفة التجهيز من قاعدة البيانات — لتعرضها الواجهة بعد التحديث
  const job = await getLatestJobForFile(supabase, id, user.id);
  return json({ file: data, job }, 200);
}

/** ربط/فك ربط الملف بمشروع أو محادثة — مع تحقق الملكية */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const parsed = linkFileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid fields" }, 400);
  const { projectId, conversationId } = parsed.data;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (projectId !== undefined) {
    if (projectId !== null) {
      const { data: proj } = await supabase
        .from("projects").select("id").eq("id", projectId)
        .eq("user_id", user.id).is("deleted_at", null).maybeSingle();
      if (!proj) return json({ error: "المشروع غير موجود | Project not found" }, 404);
    }
    update.project_id = projectId;
  }
  if (conversationId !== undefined) {
    if (conversationId !== null) {
      const { data: conv } = await supabase
        .from("conversations").select("id").eq("id", conversationId)
        .eq("user_id", user.id).is("deleted_at", null).maybeSingle();
      if (!conv) return json({ error: "المحادثة غير موجودة | Conversation not found" }, 404);
    }
    update.conversation_id = conversationId;
  }

  const { data, error } = await supabase
    .from("files")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();
  if (error || !data) return json({ error: "الملف غير موجود | File not found" }, 404);
  return json({ ok: true }, 200);
}

/** حذف ناعم في قاعدة البيانات + إزالة آمنة من التخزين */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const { data: row } = await supabase
    .from("files")
    .select("id, storage_path")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  // إزالة من التخزين أولًا (سياسات Storage تضمن أنه ملك المستخدم)
  const { error: rmError } = await supabase.storage
    .from(FILES_BUCKET)
    .remove([row.storage_path]);
  if (rmError) console.error(`[files] storage remove warning: ${rmError.message.slice(0, 80)}`);

  // ألغِ أي وظيفة تجهيز نشطة أولًا (يمنع العامل من إعادة إنشاء البيانات)
  await supabase
    .from("rag_jobs")
    .update({ status: "cancelled", locked_by: null, error_code: "file_deleted" })
    .eq("file_id", id)
    .eq("user_id", user.id)
    .in("status", ["queued", "running", "retrying"]);

  // حذف كل مقاطع RAG والمتجهات نهائيًا (الحذف ناعم للملف، صلب للمقاطع)
  await supabase.from("file_chunks").delete().eq("file_id", id).eq("user_id", user.id);

  await supabase
    .from("files")
    .update({
      deleted_at: new Date().toISOString(),
      status: "deleted",
      extracted_text: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id);

  return json({ ok: true }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
