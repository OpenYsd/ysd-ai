import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminUsersView } from "@/components/admin/users-view";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminUsersView isOwner={ctx.isOwner} selfId={ctx.userId} />;
}
