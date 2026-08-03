import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { REQUIRED_DOCUMENTS } from "@/lib/auth/consent";

export const runtime = "nodejs";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * تسجيل قبول الشروط — للمستخدم الحالي وحده.
 *
 * النسخة تُقرأ من `platform_settings` على الخادم ولا تُقبل من العميل: لو جاءت
 * من الجسم لأمكن لمستخدم أن «يقبل» نسخة قديمة ويبقى خارج الوثيقة السارية.
 * والمعرّف من الجلسة لا من الجسم — فلا يُسجّل أحد موافقة عن غيره.
 */
export async function POST() {
  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح" }, 401);

  const { data: setting } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "terms_version")
    .maybeSingle();
  const version = typeof setting?.value === "string" ? setting.value : "unversioned";

  const rows = REQUIRED_DOCUMENTS.map((document) => ({
    user_id: ctx.userId,
    document,
    version,
  }));

  // المفتاح الأساسي (user_id, document, version) يجعل التكرار بلا أثر
  const { error } = await supabase.from("user_consents").upsert(rows, {
    onConflict: "user_id,document,version",
  });
  if (error) {
    // رمز فقط — لا نصّ قاعدة إلى المتصفح
    console.error(`[consent] write_failed code=${error.code ?? "?"}`);
    return json({ error: "تعذّر حفظ الموافقة." }, 500);
  }

  console.log(`[consent] accepted documents=${REQUIRED_DOCUMENTS.length}`);
  return json({ ok: true }, 200);
}
