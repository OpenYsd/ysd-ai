import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listAvailableModels } from "@/lib/ai/registry";
import { SettingsForm } from "@/components/settings/settings-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: prefs } = await supabase
    .from("user_preferences")
    .select("default_model_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const models = listAvailableModels().map((m) => ({
    id: m.id,
    nameAr: m.displayNameAr,
    nameEn: m.displayNameEn,
  }));

  return (
    <SettingsForm
      models={models}
      initialDefaultModelId={prefs?.default_model_id ?? null}
    />
  );
}
