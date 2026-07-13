import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listModelOptions } from "@/lib/ai/registry";
import { ChatView, type ChatModel } from "@/components/chat/chat-view";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) redirect("/chat");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS يضمن الملكية، وشرط user_id دفاع إضافي
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, title, model_id")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!conv) redirect("/chat");

  const [{ data: rows }, { data: prefs }, { data: profile }] = await Promise.all([
    supabase
      .from("messages")
      .select("id, role, content")
      .eq("conversation_id", id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("user_preferences")
      .select("default_model_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);

  const models: ChatModel[] = listModelOptions();

  const candidates = [conv.model_id, prefs?.default_model_id];
  const initialModelId =
    candidates.find((c) => c && models.some((m) => m.id === c)) ??
    models[0]?.id ??
    null;

  const initialMessages = (rows ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  return (
    <ChatView
      key={id}
      conversationId={id}
      initialMessages={initialMessages}
      initialTitle={conv.title}
      models={models}
      initialModelId={initialModelId}
      greetingName={profile?.display_name ?? ""}
      devMode={process.env.NODE_ENV !== "production"}
    />
  );
}
