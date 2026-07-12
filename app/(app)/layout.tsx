import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile }, { data: sub }, { data: conversations }] =
    await Promise.all([
      supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      supabase.from("subscriptions").select("tier").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("conversations")
        .select("id, title, updated_at")
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(100),
    ]);

  return (
    <AppShell
      userName={profile?.display_name ?? user.email?.split("@")[0] ?? ""}
      tier={sub?.tier ?? "free"}
      conversations={conversations ?? []}
    >
      {children}
    </AppShell>
  );
}
