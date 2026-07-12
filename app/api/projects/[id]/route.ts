import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { updateProjectSchema } from "@/lib/validation/projects";
import { listAvailableModels } from "@/lib/ai/registry";

export const runtime = "nodejs";

const idSchema = z.string().uuid();

/** تفاصيل مشروع مع محادثاته */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح." }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, description, custom_instructions, model_settings, last_activity_at, created_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!project) return json({ error: "المشروع غير موجود." }, 404);

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .eq("project_id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  return json({ project, conversations: conversations ?? [] }, 200);
}

/** تعديل مشروع */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح." }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = updateProjectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);
  const { name, description, customInstructions, defaultModelId } = parsed.data;

  if (defaultModelId && !listAvailableModels().some((m) => m.id === defaultModelId)) {
    return json({ error: "النموذج غير متاح." }, 400);
  }

  const update: Record<string, unknown> = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description || null;
  if (customInstructions !== undefined) update.custom_instructions = customInstructions || null;
  if (defaultModelId !== undefined) {
    update.model_settings = defaultModelId ? { default_model_id: defaultModelId } : {};
  }
  if (Object.keys(update).length === 0) return json({ error: "لا يوجد ما يُحدّث." }, 400);

  // RLS يضمن الملكية، وشرط user_id دفاع إضافي ضد IDOR
  const { data, error } = await supabase
    .from("projects")
    .update(update)
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();

  if (error || !data) return json({ error: "المشروع غير موجود." }, 404);
  return json({ ok: true }, 200);
}

/** حذف مشروع (حذف ناعم) مع فك ربط محادثاته */
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
    .from("projects")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .select("id")
    .single();
  if (error || !data) return json({ error: "المشروع غير موجود." }, 404);

  // فك ربط المحادثات — تبقى المحادثات نفسها موجودة
  await supabase
    .from("conversations")
    .update({ project_id: null })
    .eq("project_id", id)
    .eq("user_id", user.id);

  return json({ ok: true }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
