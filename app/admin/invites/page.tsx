import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminInvitesView } from "@/components/admin/invites-view";

export const dynamic = "force-dynamic";

export default async function AdminInvitesPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminInvitesView />;
}
