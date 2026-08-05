import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { clientIpFrom } from "@/lib/http/client-ip";
import { consumeInviteRate, INVITE_BUCKETS } from "@/lib/auth/invite-guard";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().min(8).max(64) });

/**
 * تحقق من كود الدعوة قبل التسجيل — **يمرّ بالخادم وحده** (v0.8.1).
 *
 * كانت `beta_invite_valid` ممنوحة لـanon، فأي متصفّح ينادي القاعدة رأسًا عبر
 * REST متجاوزًا هذا المسار وكل حدّ معدّل فيه. ترحيل 0027 قصرها على
 * `service_role`، فصار هذا المسار **الطريق الوحيد** — والحدّ الذي يعيش في
 * التطبيق وحده ليس حدًّا حتى يُغلق الباب الآخر.
 *
 * الرد `{ valid: boolean }` فقط: لا تلميح ولا عدد استخدامات ولا تاريخ انتهاء.
 * ولا يُسجَّل الكود الخام في أي سجل.
 *
 * ملاحظة أمنية: الحماية الأساسية ضد التخمين هي إنتروبيا الكود (16 حرفًا من
 * أبجدية 32 ≈ 80 بت). الـRate Limit هنا طبقة إضافية ضد الإغراق/العدّ.
 */
export async function POST(req: NextRequest) {
  /**
   * العنوان من `clientIpFrom` لا من أول عنصر في `x-forwarded-for`: الترويسة
   * سلسلة يُلحق بها، وأولها يكتبه العميل — فأخذه يعني أنه يختار مفتاح حدّه
   * بنفسه ويتجاوزه بتغيير رقم.
   */
  const ip = clientIpFrom(req.headers);
  if (!(await consumeInviteRate(INVITE_BUCKETS.verifyIp, ip)).allowed) return tooMany();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ valid: false }, 200);
  const code = parsed.data.code.trim();

  /**
   * حدّ ثانٍ على **الكود نفسه**: حدّ الـIP وحده تتجاوزه شبكة موزّعة، وكودٌ
   * بعينه هدفٌ قائم بذاته. والمفتاح HMAC فلا تصل القاعدة قيمة خام.
   */
  if (!(await consumeInviteRate(INVITE_BUCKETS.verifyCode, code)).allowed) return tooMany();

  const supabase = getAdminClient();
  if (!supabase) {
    console.error("[invite] service_client_unavailable path=verify");
    return json({ valid: false }, 200);
  }

  const { data, error } = await supabase.rpc("beta_invite_valid", { p_code: code });
  if (error) {
    // لا نطبع الكود إطلاقًا — رمز الخطأ فقط
    console.error(`[invite] verify failed: code=${error.code ?? "?"}`);
    return json({ valid: false }, 200);
  }
  return json({ valid: data === true }, 200);
}

function tooMany() {
  return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
