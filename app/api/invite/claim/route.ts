import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { clientIpFrom } from "@/lib/http/client-ip";
import { consumeInviteRate, INVITE_BUCKETS } from "@/lib/auth/invite-guard";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().min(8).max(64),
  /**
   * البريد اختياري ويُستعمل **لحدّ المعدّل وحده** — لا يُخزَّن ولا يُرسَل إلى
   * القاعدة ولا يُسجَّل. غيابه لا يكسر أي عميل قديم.
   */
  email: z.string().min(3).max(254).optional(),
});

/**
 * استبدال كود الدعوة بتذكرة تسجيل مؤقتة أحادية الاستخدام — **خادميًّا وحده**.
 *
 * لماذا التذكرة أصلًا: أي مفتاح يُرسَل في signUp.data ينتهي حتمًا في استجابة
 * GoTrue وفي الـJWT (أُثبت حيًا: مُحفّزات BEFORE تنظّف القاعدة لكنها لا تمسّ
 * كائن GoTrue في الذاكرة). لذلك لا يصل كود الدعوة إلى GoTrue إطلاقًا — يُستبدل
 * هنا بتذكرة تُستهلك عند التسجيل وتنتهي خلال 10 دقائق، فتسريبها بلا قيمة.
 *
 * ولماذا service_role الآن (v0.8.1): `beta_claim_invite` **تكتب** — تُصدر
 * تذاكر وتستهلك حدود الإصدار. وكانت ممنوحة لـanon، فحلقةٌ من عشرة أسطر تُجمّد
 * كل دعوة قائمة عند سقفَي `c_max_active` و`c_max_hourly` بلا أن يسجّل أحد.
 * ترحيل 0027 قصرها على `service_role`، فصار هذا المسار الطريق الوحيد.
 *
 * التذكرة الخام تُعاد مرة واحدة ولا تُخزَّن: القاعدة تحفظ sha256 فقط.
 * ولا يُسجَّل الكود ولا البريد ولا التذكرة في أي سجل.
 */
export async function POST(req: NextRequest) {
  /**
   * العنوان من `clientIpFrom` لا من أول عنصر في `x-forwarded-for` — انظر
   * lib/http/client-ip.ts: أول عنصر يكتبه العميل، فأخذه يجعله يختار مفتاح
   * حدّه بنفسه وينتحل عنوان غيره.
   */
  const ip = clientIpFrom(req.headers);
  if (!(await consumeInviteRate(INVITE_BUCKETS.claimIp, ip)).allowed) return tooMany();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "كود غير صالح | Invalid code" }, 400);
  const code = parsed.data.code.trim();

  // حدّان إضافيان: على الكود وعلى البريد — بمفاتيح HMAC لا قيم خام
  if (!(await consumeInviteRate(INVITE_BUCKETS.claimCode, code)).allowed) return tooMany();
  if (parsed.data.email) {
    if (!(await consumeInviteRate(INVITE_BUCKETS.claimEmail, parsed.data.email)).allowed) {
      return tooMany();
    }
  }

  const supabase = getAdminClient();
  if (!supabase) {
    console.error("[invite] service_client_unavailable path=claim");
    return json({ error: "الخدمة غير متاحة حاليًا | Unavailable" }, 503);
  }

  const ticket = randomBytes(32).toString("base64url");
  const ticketHash = createHash("sha256").update(ticket).digest("hex");

  const { data, error } = await supabase.rpc("beta_claim_invite", {
    p_code: code,
    p_ticket_hash: ticketHash,
    p_ttl_seconds: 600,
  });
  if (error) {
    // لا نطبع الكود ولا التذكرة إطلاقًا — رمز الخطأ فقط
    console.error(`[invite] claim failed: code=${error.code ?? "?"}`);
    return json({ error: "تعذّر التحقق | Failed" }, 500);
  }

  /**
   * رفض موحّد: كود غير موجود، أو منتهٍ، أو مستهلَك، أو بلغ سقف التذاكر —
   * كلها رسالة واحدة. أي تمييز بينها يمنح مِسبارًا يكشف حالة كل كود، فيُعرف
   * الكود الصحيح من نصّ الخطأ وحده دون أن يملكه أحد.
   */
  if (data !== true) return json({ error: "كود الدعوة غير صالح | Invalid invite" }, 400);

  return json({ ticket }, 201);
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
