import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { createConversationSchema } from "@/lib/validation/chat";
import { getAiSettings, isModelAllowed, resolveDefaultModel } from "@/lib/ai/ai-settings";

export const runtime = "nodejs";

/** قائمة محادثات المستخدم الحالي */
export async function GET() {
  const supabase = await createClient();
  // الهوية من سياق الوسيط المُتحقَّق — يُسقط رحلة getUser (fallback شبكي آمن لو غاب).
  // RLS يبقى نافذًا على conversations، فالعزل مضمون على الخادم لا في الترويسة وحدها.
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at, project_id")
    .eq("user_id", ctx.userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) return json({ error: "تعذّر جلب المحادثات." }, 500);
  return json({ conversations: data }, 200);
}

/** إنشاء محادثة جديدة */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

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
      .eq("user_id", ctx.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!proj) return json({ error: "المشروع غير موجود." }, 404);
    const settings = proj.model_settings as { default_model_id?: string } | null;
    projectModelId = settings?.default_model_id ?? null;
  }

  /**
   * v0.8.0 — النموذج الافتراضي للمحادثة الجديدة.
   *
   * الأولوية: نموذج المشروع (إن وُجد ومسموح)، ثم الافتراضي الإداري، ثم أول
   * مسموح من السجل. الترتيب مقصود: إعداد المشروع أخصّ من إعداد المنصة.
   *
   * إعدادٌ إداريٌّ يشير إلى نموذج اختفى لا يمنع الإنشاء — يسقط إلى بديل صالح.
   * والمحادثات القائمة لا تتأثر: هذا المسار يعمل عند الإنشاء وحده.
   */
  const aiSettings = await getAiSettings(supabase);
  const effectiveModelId =
    projectModelId && isModelAllowed(projectModelId, aiSettings.allowedModels)
      ? projectModelId
      : resolveDefaultModel(aiSettings);

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      user_id: ctx.userId,
      title: parsed.data.title ?? "محادثة جديدة",
      project_id: parsed.data.projectId ?? null,
      model_id: effectiveModelId,
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
