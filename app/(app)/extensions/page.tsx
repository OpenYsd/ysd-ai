import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { builtInSkillRegistry } from "@/lib/skills/registry";
import { ExtensionsView } from "@/components/extensions/extensions-view";

export default async function ExtensionsPage() {
  const supabase = await createClient();
  // الهوية من سياق الوسيط — طبقةٌ مستقلة عن التخطيط، كما في كل صفحات (app)
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");

  // الفهرس ثابتٌ من السجلّ المدمج: لا استعلام ولا جدول — المهارات بياناتٌ لا سجلّات مستخدم
  return <ExtensionsView skills={builtInSkillRegistry().list()} />;
}
