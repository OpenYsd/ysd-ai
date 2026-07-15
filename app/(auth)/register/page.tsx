import { createClient } from "@/lib/supabase/server";
import { getSettings } from "@/lib/settings";
import { RegisterForm } from "@/components/auth/register-form";

export const dynamic = "force-dynamic";

/** التسجيل — بوابة Beta: يقرأ الإعدادات على الخادم قبل عرض النموذج */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const supabase = await createClient();
  const settings = await getSettings(supabase, [
    "allow_registration",
    "require_invite",
    "terms_version",
  ]);

  return (
    <RegisterForm
      allowRegistration={settings.allow_registration !== false}
      requireInvite={settings.require_invite !== false}
      termsVersion={String(settings.terms_version ?? "")}
      initialCode={code ?? ""}
    />
  );
}
