import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { SKILL_ID_PATTERN } from "@/lib/skills/manifest";
import { builtInSkillRegistry } from "@/lib/skills/registry";
import { favoritesScopeFor } from "@/lib/skills/favorites-scope";
import { SkillDetail } from "@/components/extensions/skill-detail";

export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // شكل المعرّف يُفحص قبل أي عمل — كما يُفحص UUID المشروع قبل الاستعلام
  if (!SKILL_ID_PATTERN.test(id)) redirect("/extensions");

  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");

  // مهارةٌ مجهولة تعود إلى الفهرس لا إلى صفحة خطأ: الرابط القديم ليس عطلًا في المنصّة
  const registry = builtInSkillRegistry();
  const skill = registry.get(id);
  if (!skill) redirect("/extensions");

  // المعرّفات كلّها لا معرّف هذه المهارة وحده: تبديل التفضيل هنا يكتب القائمة كاملة
  return (
    <SkillDetail
      skill={skill}
      favoritesScope={favoritesScopeFor(ctx.userId)}
      catalogIds={registry.list().map((s) => s.id)}
    />
  );
}
