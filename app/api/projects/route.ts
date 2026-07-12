import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createProjectSchema } from "@/lib/validation/projects";
import { listAvailableModels } from "@/lib/ai/registry";

export const runtime = "nodejs";

/** قائمة مشاريع المستخدم مع عدد المحادثات والملفات */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const { data, error } = await supabase
    .from("projects")
    .select(
      // تحديد FK صراحة — يوجد مساران بين projects وconversations (project_id + project_conversations)
      "id, name, description, custom_instructions, model_settings, last_activity_at, created_at, conversations!conversations_project_id_fkey(count), files(count)",
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("last_activity_at", { ascending: false })
    .limit(200);

  if (error) return json({ error: "تعذّر جلب المشاريع." }, 500);
  return json({ projects: data }, 200);
}

/** إنشاء مشروع */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = createProjectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);
  const { name, description, customInstructions, defaultModelId } = parsed.data;

  if (defaultModelId && !listAvailableModels().some((m) => m.id === defaultModelId)) {
    return json({ error: "النموذج غير متاح." }, 400);
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      description: description ?? null,
      custom_instructions: customInstructions ?? null,
      model_settings: defaultModelId ? { default_model_id: defaultModelId } : {},
    })
    .select("id")
    .single();

  if (error || !data) return json({ error: "تعذّر إنشاء المشروع." }, 500);
  return json({ project: data }, 201);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
