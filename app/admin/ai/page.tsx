import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { AdminAiSettingsView } from "@/components/admin/ai-settings-view";

export const dynamic = "force-dynamic";

/** إدارة الذكاء الاصطناعي (v0.8.0) — admin/owner فقط */
export default async function AdminAiPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");
  return <AdminAiSettingsView />;
}
