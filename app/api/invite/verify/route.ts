import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().min(8).max(64) });

/**
 * تحقق من كود الدعوة قبل التسجيل — مسار عام مع Rate Limit بالـIP.
 * يُرجع { valid: boolean } فقط: لا hint ولا عدد استخدامات ولا تاريخ انتهاء.
 * لا يُسجَّل الكود الخام في أي سجل.
 *
 * ملاحظة أمنية: الحماية الأساسية ضد التخمين هي إنتروبيا الكود (16 حرفًا من
 * أبجدية 32 ≈ 80 بت). الـRate Limit هنا طبقة إضافية ضد الإغراق/العدّ.
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!rateLimit(`invite-verify:${ip}`, 10, 60_000)) {
    return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ valid: false }, 200);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("beta_invite_valid", {
    p_code: parsed.data.code.trim(),
  });
  if (error) {
    // لا نطبع الكود إطلاقًا — رمز الخطأ فقط
    console.error(`[invite] verify failed: code=${error.code}`);
    return json({ valid: false }, 200);
  }
  return json({ valid: data === true }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
