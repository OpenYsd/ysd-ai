import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listModelOptions } from "@/lib/ai/registry";
import { PUBLIC_FILE_FIELDS } from "@/lib/files/service";
import { ProjectDetail } from "@/components/projects/project-detail";
import type { UploadedFileRow } from "@/components/files/upload";

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

  const [{ data: linked }, { data: unlinked }, { data: projectFiles }] = await Promise.all([
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
    supabase
      .from("files")
      .select(PUBLIC_FILE_FIELDS)
      .eq("project_id", id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const models = listModelOptions();

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
      files={(projectFiles ?? []) as unknown as UploadedFileRow[]}
    />
  );
}
