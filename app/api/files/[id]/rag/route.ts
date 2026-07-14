import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { prepareFileForRag } from "@/lib/rag/pipeline";
import { PUBLIC_FILE_FIELDS } from "@/lib/files/service";

export const runtime = "nodejs";
export const maxDuration = 300;

const idSchema = z.string().uuid();

/** تجهيز/إعادة تجهيز ملف للذكاء الاصطناعي (chunking + embeddings محلية) */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  if (!rateLimit(`rag:${user.id}`, 5, 60_000))
    return json({ error: "محاولات تجهيز كثيرة — انتظر قليلًا | Too many attempts" }, 429);

  const { data: row } = await supabase
    .from("files")
    .select("id, user_id, storage_path, original_name, mime_type, status, extracted_text, rag_content_hash")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  if (row.status === "chunking" || row.status === "embedding")
    return json({ error: "الملف قيد التجهيز بالفعل | Already processing" }, 409);
  if (!["ready", "ready_for_rag", "rag_failed"].includes(row.status))
    return json({ error: "استخرج نص الملف أولًا | Extract text first" }, 400);

  const result = await prepareFileForRag(supabase, row);

  const { data: fresh } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", id)
    .single();

  if (!result.ok) return json({ error: result.error, file: fresh }, 422);
  return json({ file: fresh, totalChunks: result.totalChunks, skipped: result.skipped ?? false }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
