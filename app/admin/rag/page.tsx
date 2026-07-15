import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminRagView } from "@/components/admin/rag-view";

export const dynamic = "force-dynamic";

export default async function AdminRagPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminRagView />;
}
