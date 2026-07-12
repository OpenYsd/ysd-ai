import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listAvailableModels } from "@/lib/ai/registry";
import { ProjectDetail } from "@/components/projects/project-detail";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) redirect("/projects");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS يضمن الملكية، وشرط user_id دفاع إضافي
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, description, custom_instructions, model_settings, last_activity_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!project) redirect("/projects");

  const [{ data: linked }, { data: unlinked }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, updated_at")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("conversations")
      .select("id, title")
      .is("project_id", null)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(100),
  ]);

  const models = listAvailableModels().map((m) => ({
    id: m.id,
    nameAr: m.displayNameAr,
    nameEn: m.displayNameEn,
  }));

  const settings = project.model_settings as { default_model_id?: string } | null;

  return (
    <ProjectDetail
      project={{
        id: project.id,
        name: project.name,
        description: project.description,
        customInstructions: project.custom_instructions,
        defaultModelId: settings?.default_model_id ?? null,
        lastActivityAt: project.last_activity_at,
      }}
      linkedConversations={linked ?? []}
      unlinkedConversations={unlinked ?? []}
      models={models}
    />
  );
}
