import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { listModelsForUser } from "@/lib/models/gateway";
import { ChatView, type ChatModel } from "@/components/chat/chat-view";

export default async function NewChatPage() {
  const supabase = await createClient();
  // الهوية من سياق الوسيط — يُسقط رحلة getUser (fallback شبكي آمن لو غاب السياق)
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");
  const userId = ctx.userId;

  /**
   * القائمة من بوابة النماذج، موسومةً بخطة المستخدم على الخادم: ما يظهر يجب أن
   * يطابق ما يقبله /api/chat، وإلا اختار المستخدم ما سيُرفض أو يُخفَّض.
   */
  const models: ChatModel[] = await listModelsForUser(supabase, userId);

  const [{ data: prefs }, { data: profile }] = await Promise.all([
    supabase
      .from("user_preferences")
      .select("default_model_id")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
  ]);

  const preferred = prefs?.default_model_id;
  const initialModelId =
    (preferred && models.some((m) => m.id === preferred) ? preferred : null) ??
    models.find((m) => !m.locked)?.id ??
    null;

  return (
    <ChatView
      conversationId={null}
      initialMessages={[]}
      models={models}
      initialModelId={initialModelId}
      greetingName={profile?.display_name ?? ""}
      devMode={process.env.NODE_ENV !== "production"}
    />
  );
}
