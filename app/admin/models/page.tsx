import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminModelsView } from "@/components/admin/models-view";

export const dynamic = "force-dynamic";

export default async function AdminModelsPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminModelsView />;
}
