import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createConversationSchema } from "@/lib/validation/chat";

export const runtime = "nodejs";

/** قائمة محادثات المستخدم الحالي */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) return json({ error: "تعذّر جلب المحادثات." }, 500);
  return json({ conversations: data }, 200);
}

/** إنشاء محادثة جديدة */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = createConversationSchema.safeParse(
    await req.json().catch(() => ({})),
  );
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);

  // عند الإنشاء داخل مشروع: تحقق من ملكية المشروع + اعتمد نموذجه الافتراضي
  let projectModelId: string | null = null;
  if (parsed.data.projectId) {
    const { data: proj } = await supabase
      .from("projects")
      .select("id, model_settings")
      .eq("id", parsed.data.projectId)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!proj) return json({ error: "المشروع غير موجود." }, 404);
    const settings = proj.model_settings as { default_model_id?: string } | null;
    projectModelId = settings?.default_model_id ?? null;
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      user_id: user.id,
      title: parsed.data.title ?? "محادثة جديدة",
      project_id: parsed.data.projectId ?? null,
      model_id: projectModelId,
    })
    .select("id, title")
    .single();

  if (error || !data) return json({ error: "تعذّر إنشاء المحادثة." }, 500);
  return json({ conversation: data }, 201);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
