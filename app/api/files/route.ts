import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  getFileLimits,
  getFileUsage,
  PUBLIC_FILE_FIELDS,
} from "@/lib/files/service";

export const runtime = "nodejs";

const queryFilter = z.string().uuid().optional();

/** قائمة ملفات المستخدم + الاستهلاك والحدود (للعدادات) */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const projectIdRaw = req.nextUrl.searchParams.get("projectId") ?? undefined;
  const conversationIdRaw = req.nextUrl.searchParams.get("conversationId") ?? undefined;
  const projectId = queryFilter.safeParse(projectIdRaw);
  const conversationId = queryFilter.safeParse(conversationIdRaw);
  if (!projectId.success || !conversationId.success)
    return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  let q = supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(300);
  if (projectId.data) q = q.eq("project_id", projectId.data);
  if (conversationId.data) q = q.eq("conversation_id", conversationId.data);

  const [{ data: files, error }, usage, limits] = await Promise.all([
    q,
    getFileUsage(supabase, user.id),
    getFileLimits(supabase, user.id),
  ]);
  if (error) return json({ error: "تعذّر جلب الملفات | Failed to list files" }, 500);

  return json({ files: files ?? [], usage, limits }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
