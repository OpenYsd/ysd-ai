import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { updateConversationSchema } from "@/lib/validation/chat";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** تعديل محادثة: إعادة تسمية و/أو ربط/فك ربط بمشروع */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح." }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = updateConversationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.projectId !== undefined) {
    // عند الربط: تحقق أن المشروع ملك المستخدم نفسه — منع الربط بمشاريع الغير
    if (parsed.data.projectId !== null) {
      const { data: proj } = await supabase
        .from("projects")
        .select("id")
        .eq("id", parsed.data.projectId)
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (!proj) return json({ error: "المشروع غير موجود." }, 404);
    }
    update.project_id = parsed.data.projectId;
  }

  // RLS يضمن الملكية، وشرط user_id دفاع إضافي ضد IDOR
  const { data, error } = await supabase
    .from("conversations")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !data) return json({ error: "المحادثة غير موجودة." }, 404);
  return json({ ok: true }, 200);
}

/** حذف محادثة (حذف ناعم) */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح." }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const { data, error } = await supabase
    .from("conversations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !data) return json({ error: "المحادثة غير موجودة." }, 404);
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
