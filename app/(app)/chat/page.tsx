import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { listModelOptions } from "@/lib/ai/registry";
import { loadModelPolicy, tierAllows } from "@/lib/ai/model-policy";
import { ChatView, type ChatModel } from "@/components/chat/chat-view";

export default async function NewChatPage() {
  const supabase = await createClient();
  // الهوية من سياق الوسيط — يُسقط رحلة getUser (fallback شبكي آمن لو غاب السياق)
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");
  const userId = ctx.userId;

  /**
   * القائمة تُوسم بخطة المستخدم على الخادم: ما يظهر يجب أن يطابق ما يقبله
   * /api/chat، وإلا اختار المستخدم ما سيُرفض أو يُخفَّض.
   */
  const policy = await loadModelPolicy(supabase, userId);
  const minTierById = new Map(policy.models.map((m) => [m.id, m.min_tier]));
  const models: ChatModel[] = listModelOptions().map((o) => {
    const minTier = minTierById.get(o.id) ?? "free";
    return { ...o, minTier, locked: !tierAllows(policy.userTier, minTier) };
  });

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
