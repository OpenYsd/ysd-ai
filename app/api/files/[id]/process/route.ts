import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { processFile, PUBLIC_FILE_FIELDS } from "@/lib/files/service";

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

  if (!rateLimit(`process:${user.id}`, 15, 60_000))
    return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);

  const { data: row } = await supabase
    .from("files")
    .select("id, storage_path, original_name, mime_type")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  await processFile(supabase, row);

  const { data: fresh } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", id)
    .single();
  return json({ file: fresh }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
