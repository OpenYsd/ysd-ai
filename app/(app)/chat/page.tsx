import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listModelOptions } from "@/lib/ai/registry";
import { ChatView, type ChatModel } from "@/components/chat/chat-view";

export default async function NewChatPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const models: ChatModel[] = listModelOptions();

  const [{ data: prefs }, { data: profile }] = await Promise.all([
    supabase
      .from("user_preferences")
      .select("default_model_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);

  const preferred = prefs?.default_model_id;
  const initialModelId =
    (preferred && models.some((m) => m.id === preferred) ? preferred : null) ??
    models[0]?.id ??
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
