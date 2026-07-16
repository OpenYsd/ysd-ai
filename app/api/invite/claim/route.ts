import { NextRequest } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const schema = z.object({ code: z.string().min(8).max(64) });

/**
 * استبدال كود الدعوة بتذكرة تسجيل مؤقتة أحادية الاستخدام — مسار عام مع Rate Limit.
 *
 * لماذا: أي مفتاح يُرسَل في signUp.data ينتهي حتمًا في استجابة GoTrue وفي الـJWT
 * (أُثبت حيًا: مُحفّزات BEFORE تنظّف القاعدة لكنها لا تمسّ كائن GoTrue في الذاكرة).
 * لذلك لا يصل كود الدعوة إلى GoTrue إطلاقًا — يُستبدل هنا بتذكرة تُستهلك عند
 * التسجيل وتنتهي خلال 10 دقائق، فتسريبها بلا قيمة.
 *
 * التذكرة الخام تُعاد مرة واحدة ولا تُخزَّن: القاعدة تحفظ sha256 فقط.
 * لا يُسجَّل الكود ولا التذكرة في أي سجل.
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!rateLimit(`invite-claim:${ip}`, 10, 60_000)) {
    return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "كود غير صالح | Invalid code" }, 400);

  const ticket = randomBytes(32).toString("base64url");
  const ticketHash = createHash("sha256").update(ticket).digest("hex");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("beta_claim_invite", {
    p_code: parsed.data.code.trim(),
    p_ticket_hash: ticketHash,
    p_ttl_seconds: 600,
  });
  if (error) {
    // لا نطبع الكود ولا التذكرة إطلاقًا — رمز الخطأ فقط
    console.error(`[invite] claim failed: code=${error.code}`);
    return json({ error: "تعذّر التحقق | Failed" }, 500);
  }
  if (data !== true) return json({ error: "كود الدعوة غير صالح | Invalid invite" }, 400);

  return json({ ticket }, 201);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
