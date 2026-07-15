import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminSettingsView } from "@/components/admin/settings-view";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminSettingsView isOwner={ctx.isOwner} />;
}
