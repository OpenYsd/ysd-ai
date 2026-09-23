import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { BUCKET_RAG_PROCESS, consumeRateLimit } from "@/lib/rate-limit-distributed";
import { processFile, PUBLIC_FILE_FIELDS, projectFileForClient } from "@/lib/files/service";
import { scheduleIndexingAfterExtraction } from "@/lib/rag/server-indexing";

export const runtime = "nodejs";
export const maxDuration = 120;

const idSchema = z.string().uuid();

/** إعادة محاولة المعالجة/الاستخراج */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  /** موزّع في القاعدة (المرحلة 6C) — نفس القيمة، ومكانُ العدّ هو ما تغيّر */
  const rate = await consumeRateLimit(user.id, BUCKET_RAG_PROCESS, 15, 60);
  if (!rate.allowed)
    return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);

  const { data: row } = await supabase
    .from("files")
    .select("id, storage_path, original_name, mime_type, metadata")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  await processFile(supabase, row);
  // ★ إعادةُ الاستخراج تبلغ `ready` كما يبلغها الرفع — فالتجهيزُ يُدرَج هنا أيضًا
  await scheduleIndexingAfterExtraction(supabase, { userId: user.id, fileId: id, origin: "process" });

  const { data: fresh } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", id)
    .single();
  return json({ file: await projectFileForClient(supabase, fresh), job: null }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
