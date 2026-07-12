import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listAvailableModels } from "@/lib/ai/registry";
import { ProjectsView, type ProjectListItem } from "@/components/projects/projects-view";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("projects")
    .select(
      // تحديد FK صراحة — يوجد مساران بين projects وconversations (project_id + project_conversations)
      "id, name, description, last_activity_at, created_at, conversations!conversations_project_id_fkey(count), files(count)",
    )
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("last_activity_at", { ascending: false })
    .limit(200);

  const projects: ProjectListItem[] = (data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    lastActivityAt: p.last_activity_at,
    conversationsCount: p.conversations?.[0]?.count ?? 0,
    filesCount: p.files?.[0]?.count ?? 0,
  }));

  const models = listAvailableModels().map((m) => ({
    id: m.id,
    nameAr: m.displayNameAr,
    nameEn: m.displayNameEn,
  }));

  return <ProjectsView projects={projects} models={models} loadFailed={Boolean(error)} />;
}
