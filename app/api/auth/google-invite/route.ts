import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/rate-limit";
import {
  AUTHORIZATION_TTL_SECONDS,
  emailHash,
  looksLikeEmail,
  normalizeEmail,
  pendingCookie,
} from "@/lib/auth/google-invite";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().min(8).max(64),
  email: z.string().min(3).max(254),
});

/**
 * بدء تسجيل Google بالدعوة — ينشئ **تصريحًا خادميًّا** مربوطًا ببريد بعينه.
 *
 * ── ما لا يفعله ──
 *
 * **لا يستهلك الدعوة**: `used_count` لا يتغيّر هنا. التصريح حجزُ مقعد؛
 * والاستهلاك يقع في `handle_new_user` عند عودة المستخدم بحساب Google مطابق.
 * فمن يبدأ التدفّق ثم ينصرف لا يحرق دعوة أحد.
 *
 * **ولا يُنشئ التصريح من العميل**: الدالة في القاعدة `SECURITY DEFINER`
 * ممنوحة لـ`service_role` **وحده**، والجدول عليه RLS بلا سياسات. فاستدعاؤها
 * بمفتاح anon مباشرةً عبر REST يُردّ بـ`permission denied` من القاعدة نفسها.
 *
 * ولهذا يستعمل هذا المسار **عميل الخدمة** لا العميل المرتبط بالطلب. والفرق
 * ليس تفصيلًا: لولاه لكان كل حدٍّ للمعدّل هنا قابلًا للتجاوز بحلقةٍ تنادي
 * القاعدة رأسًا — والحدّ الذي يعيش في التطبيق وحده ليس حدًّا.
 *
 * ومفتاح الخدمة لا يبلغ المتصفح: `lib/supabase/admin.ts` يبدأ بـ
 * `import "server-only"`، فاستيراده من أي مكوّن عميل **خطأ بناء** لا تحذير.
 *
 * ── ولا يفصح ──
 *
 * الرد واحد في كل حالات الرفض: كود خاطئ، أو مقاعد نفدت، أو صيغة بريد فاسدة.
 * أي تمييز بينها يمنح مسبارًا يُعدّ به الدعوات وتُستكشف حالتها.
 *
 * ولا يُسجَّل بريد ولا كود ولا تصريح — رموز وعدّادات فقط.
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (!rateLimit(`gsa-ip:${ip}`, 10, 60_000)) return tooMany();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return refuse();

  const email = normalizeEmail(parsed.data.email);
  const code = parsed.data.code.trim();
  if (!looksLikeEmail(email)) return refuse();

  /**
   * حدّان إضافيان بعد التحقق من الصيغة: على البريد وعلى الكود.
   *
   * حدّ الـIP وحده لا يكفي — شبكةٌ موزّعة تتجاوزه، وكلٌّ من البريد والكود هدفٌ
   * قائم بذاته: الأول يُستخدم لإزعاج مالك بريد بعينه، والثاني لاستنزاف مقاعد
   * دعوة بعينها. ونستعمل الهاش مفتاحًا فلا يظهر البريد ولا الكود في الذاكرة.
   */
  if (!rateLimit(`gsa-email:${emailHash(email)}`, 5, 300_000)) return tooMany();
  if (!rateLimit(`gsa-code:${emailHash(code)}`, 15, 300_000)) return tooMany();

  /**
   * غياب مفتاح الخدمة عطلٌ في الإعداد لا حالةٌ يُتعامل معها بهدوء: بدونه لا
   * سبيل لإنشاء تصريح إطلاقًا. نردّ 503 بلا ذكر اسم متغيّر ولا سبب تقني.
   */
  const supabase = getAdminClient();
  if (!supabase) {
    console.error("[google-invite] service_client_unavailable");
    return json({ error: "الخدمة غير متاحة حاليًا | Unavailable" }, 503);
  }

  const { data, error } = await supabase.rpc("google_signup_authorize", {
    p_code: code,
    p_email: email,
    p_ttl_seconds: AUTHORIZATION_TTL_SECONDS,
  });

  if (error) {
    // رمز الخطأ فقط — لا بريد ولا كود ولا نصّ قاعدة
    console.error(`[google-invite] authorize_failed code=${error.code ?? "?"}`);
    return json({ error: "تعذّر التحقق | Failed" }, 500);
  }
  if (data !== true) return refuse();

  console.log("[google-invite] authorized ttl_s=" + AUTHORIZATION_TTL_SECONDS);

  return json({ ok: true }, 201, {
    "Set-Cookie": pendingCookie("1", AUTHORIZATION_TTL_SECONDS),
  });
}

/** رفض موحّد — لا يميّز سببًا */
function refuse() {
  return json(
    { error: "كود الدعوة أو البريد غير صالح | Invalid invite or email" },
    400,
  );
}

function tooMany() {
  return json({ error: "محاولات كثيرة — انتظر قليلًا | Too many attempts" }, 429);
}

function json(body: unknown, status: number, extra?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(extra ?? {}),
    },
  });
}
