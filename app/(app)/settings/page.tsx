import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listModelOptions } from "@/lib/ai/registry";
import { SettingsForm } from "@/components/settings/settings-form";
import { LocalAiSettings } from "@/components/local-image/local-ai-settings";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("default_model_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const models = listModelOptions();

  return (
    <>
      <SettingsForm
        models={models}
        initialDefaultModelId={prefs?.default_model_id ?? null}
      />
      {/**
        * سطحُ الذكاء المحلّيّ — يُصيَّر لنفسه، ويغيب تمامًا بإطفاء الراية.
        *
        * ولا شرطَ هنا في الخادم: المكوّنُ يقرأ الرايةَ ويردّ `null`. فمصدرُ
        * القرار واحد، ولا يفترق ما يقرّره الخادمُ عمّا يقرّره المتصفّح.
        */}
      <LocalAiSettings />
    </>
  );
}
