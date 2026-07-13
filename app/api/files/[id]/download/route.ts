import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { FILES_BUCKET } from "@/lib/files/service";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** رابط تنزيل موقّت (Signed URL) — بعد تحقق الملكية على الخادم */
export async function GET(
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
    .select("id, storage_path, original_name, mime_type")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  const { data: signed, error } = await supabase.storage
    .from(FILES_BUCKET)
    .createSignedUrl(row.storage_path, 300);
  if (error || !signed) {
    console.error(`[files] signed url failed: ${error?.message.slice(0, 80)}`);
    return json({ error: "تعذّر إنشاء رابط التنزيل | Failed to create download link" }, 500);
  }

  return json(
    { url: signed.signedUrl, name: row.original_name, mime: row.mime_type },
    200,
  );
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
