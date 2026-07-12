import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { renameConversationSchema } from "@/lib/validation/chat";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** إعادة تسمية محادثة */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح." }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = renameConversationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);

  // RLS يضمن الملكية، وشرط user_id دفاع إضافي ضد IDOR
  const { data, error } = await supabase
    .from("conversations")
    .update({ title: parsed.data.title, updated_at: new Date().toISOString() })
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
