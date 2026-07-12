import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AccountView } from "@/components/account/account-view";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [{ data: profile }, { data: sub }, { data: usageRows }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    supabase.from("subscriptions").select("tier").eq("user_id", user.id).maybeSingle(),
    supabase
      .from("usage_events")
      .select("input_tokens, output_tokens")
      .eq("user_id", user.id)
      .gte("created_at", monthStart.toISOString()),
  ]);

  const tier = sub?.tier ?? "free";
  const { data: limits } = await supabase
    .from("usage_limits")
    .select("monthly_messages, monthly_tokens")
    .eq("tier", tier)
    .maybeSingle();

  const rows = usageRows ?? [];
  const messagesUsed = rows.length;
  const tokensUsed = rows.reduce(
    (acc, r) => acc + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
    0,
  );

  return (
    <AccountView
      email={user.email ?? ""}
      displayName={profile?.display_name ?? ""}
      tier={tier}
      messagesUsed={messagesUsed}
      messagesLimit={limits?.monthly_messages ?? 0}
      tokensUsed={tokensUsed}
      tokensLimit={limits?.monthly_tokens ?? 0}
    />
  );
}
