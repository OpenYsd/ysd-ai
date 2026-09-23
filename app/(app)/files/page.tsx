import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFileLimits, getFileUsage, PUBLIC_FILE_FIELDS, projectFilesForClient } from "@/lib/files/service";
import { FilesView } from "@/components/files/files-view";
import type { UploadedFileRow } from "@/components/files/upload";

export default async function FilesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: files, error }, { data: projects }, usage, limits] =
    await Promise.all([
      supabase
        .from("files")
        .select(PUBLIC_FILE_FIELDS)
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(300),
      supabase
        .from("projects")
        .select("id, name")
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .order("last_activity_at", { ascending: false })
        .limit(100),
      getFileUsage(supabase, user.id),
      getFileLimits(supabase, user.id),
    ]);

  // `needs_active_embedding` يُشتقّ على الخادم: الواجهةُ لا تعرف فضاءات التضمين
  const clientFiles = await projectFilesForClient(supabase, files);

  return (
    <FilesView
      initialFiles={clientFiles as unknown as UploadedFileRow[]}
      projects={projects ?? []}
      usage={usage}
      limits={limits}
      loadFailed={Boolean(error)}
    />
  );
}
