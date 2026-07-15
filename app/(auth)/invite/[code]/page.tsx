import { redirect } from "next/navigation";
import { z } from "zod";

/** رابط دعوة مباشر — يمرّر الكود إلى نموذج التسجيل (التحقق الفعلي على الخادم) */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  // كود آمن للتمرير فقط (أحرف/أرقام/شرطات) — التحقق الحقيقي في RPC والمُحفّز
  const safe = z.string().regex(/^[A-Za-z0-9-]{8,64}$/).safeParse(code);
  if (!safe.success) redirect("/beta");
  redirect(`/register?code=${encodeURIComponent(safe.data)}`);
}
