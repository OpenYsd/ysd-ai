import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminUsageView } from "@/components/admin/usage-view";

export const dynamic = "force-dynamic";

export default async function AdminUsagePage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminUsageView />;
}
