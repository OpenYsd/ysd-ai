import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UsageView } from "@/components/usage/usage-view";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [{ data: sub }, { data: monthRows }, { count: dayCount }, { data: files }] =
    await Promise.all([
      supabase.from("subscriptions").select("tier").eq("user_id", user.id).maybeSingle(),
      supabase.from("usage_events").select("input_tokens, output_tokens").eq("user_id", user.id).gte("created_at", monthStart.toISOString()),
      supabase.from("usage_events").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", dayStart.toISOString()),
      supabase.from("files").select("size_bytes, status").eq("user_id", user.id).is("deleted_at", null),
    ]);

  const tier = sub?.tier ?? "free";
  const { data: limits } = await supabase
    .from("usage_limits")
    .select("monthly_messages, monthly_tokens, daily_messages, max_files, max_storage_mb")
    .eq("tier", tier)
    .maybeSingle();

  const fileRows = files ?? [];
  const monthMessages = monthRows?.length ?? 0;
  const monthTokens = (monthRows ?? []).reduce((a, u) => a + (u.input_tokens ?? 0) + (u.output_tokens ?? 0), 0);
  const ragReady = fileRows.filter((f) => f.status === "ready_for_rag").length;

  return (
    <UsageView
      tier={tier}
      dayMessages={dayCount ?? 0}
      monthMessages={monthMessages}
      monthTokens={monthTokens}
      filesCount={fileRows.length}
      storageBytes={fileRows.reduce((a, f) => a + (f.size_bytes ?? 0), 0)}
      ragReady={ragReady}
      limits={{
        dailyMessages: limits?.daily_messages ?? 0,
        monthlyMessages: limits?.monthly_messages ?? 0,
        monthlyTokens: limits?.monthly_tokens ?? 0,
        maxFiles: limits?.max_files ?? 0,
        maxStorageMb: limits?.max_storage_mb ?? 0,
      }}
    />
  );
}
