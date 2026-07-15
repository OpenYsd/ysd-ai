import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminAuditView } from "@/components/admin/audit-view";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminAuditView />;
}
