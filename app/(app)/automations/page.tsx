import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { builtInSkillRegistry } from "@/lib/skills/registry";
import { automationDraftsScopeFor } from "@/lib/automations/drafts-scope";
import { builtInWorkflowTemplates } from "@/lib/automations/templates";
import { AutomationsView } from "@/components/automations/automations-view";

export default async function AutomationsPage() {
  const supabase = await createClient();
  // الهوية من سياق الوسيط — طبقةٌ مستقلة عن التخطيط، كما في كل صفحات (app)
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");

  // المهارات المدمجة لخطوات «مهارة»: المعرّف والاسم والصلاحيات وحدها — لا تعليماتٌ ولا استعلام.
  // والمسودات في متصفح المستخدم بنطاقٍ مشتقّ من هويّته الموثَّقة هنا، لا من أي شيءٍ في الطلب
  const skills = builtInSkillRegistry()
    .list()
    .map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities }));
  // القوالب المدمجة (المرحلة 4B): فهرسٌ مغلق مُتحقَّق مجمَّد — بياناتٌ لا برامج، ولا تنزيل
  return (
    <AutomationsView skills={skills} templates={builtInWorkflowTemplates()} draftsScope={automationDraftsScopeFor(ctx.userId)} />
  );
}
