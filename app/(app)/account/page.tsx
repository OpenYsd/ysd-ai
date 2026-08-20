import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AccountView } from "@/components/account/account-view";
import { aggregateUsageEvents } from "@/lib/usage/aggregate";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  /**
   * ★ لا تُجمَع من صفوفٍ تُجلب (المرحلة 6C).
   *
   * PostgREST يقصّ عند ألف صفٍّ بلا خطأ، فكان الرقم يتوقّف عند ألفٍ
   * ويبدو رقمًا صحيحًا. راجع `lib/usage/aggregate`.
   */
  const [{ data: profile }, { data: sub }, month] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
    supabase.from("subscriptions").select("tier").eq("user_id", user.id).maybeSingle(),
    aggregateUsageEvents(supabase, {
      userId: user.id,
      since: monthStart.toISOString(),
    }),
  ]);

  const tier = sub?.tier ?? "free";
  const { data: limits } = await supabase
    .from("usage_limits")
    .select("monthly_messages, monthly_tokens")
    .eq("tier", tier)
    .maybeSingle();

  const messagesUsed = month.events;
  const tokensUsed = month.tokens;

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
