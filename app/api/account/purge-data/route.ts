import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { purgeUserData } from "@/lib/account/purge";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * حذف بيانات المستخدم (v0.9.16، المرحلة 6E).
 *
 * ── الهوية من الجلسة وحدها ──
 *
 * لا `user_id` في الجسم ولا في الاستعلام. ولو قُبل لَصار المسار بابًا لمحو
 * بيانات غيرك بمعرّفٍ مخمّن. والجسم يحمل تأكيدًا واحدًا لا أكثر.
 *
 * ── و`POST` لا `GET` ──
 *
 * فعلٌ مدمّر خلف `GET` يقع بزيارة رابطٍ في رسالةٍ أو بجالبٍ مسبق. والحماية
 * من التزوير قائمةٌ سلفًا: كوكي الجلسة من Supabase بـ`SameSite=Lax`، فلا
 * يحملها طلبٌ من موقعٍ آخر. ويُضاف فحصُ الأصل دفاعًا ثانيًا.
 *
 * ── ولا رمزَ داخليّ يخرج ──
 *
 * `failedAt` رمزٌ من مجموعةٍ مغلقة يُسجَّل ولا يُعرض. والمستخدم يقرأ جملةً
 * واحدة بلغته: لم تكتمل، حاول أو تواصل.
 */

const schema = z.object({ confirm: z.literal("DELETE") });

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  /**
   * ★ فحصُ الأصل — دفاعٌ ثانٍ خلف `SameSite`.
   *
   * ويُقبل غيابُ الترويسة: بعض العملاء لا يرسلونها، ومنعُهم يكسر استعمالًا
   * مشروعًا بلا أن يمنع هجومًا — فمتصفّحٌ يزوّر الطلب **يرسلها** دائمًا.
   */
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return json({ error: "طلب غير صالح | Invalid request" }, 403);
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: 'أرسل {"confirm":"DELETE"} للتأكيد | Confirmation required' }, 400);
  }

  const result = await purgeUserData(supabase, user.id);

  if (!result.ok) {
    /** حدثٌ منظَّم بنفس مفردات حذف الحساب — رمزٌ ومعرّفُ طلبٍ لا أكثر */
    logger.error({
      event: "account_purge_incomplete",
      code: result.failedAt ?? "unknown",
      correlation: req.headers.get("x-ysd-request-id") ?? undefined,
    });
    return json(
      {
        ok: false,
        error:
          "تعذّر حذف جميع البيانات. لم نعتبر العملية مكتملة. حاول مرة أخرى أو تواصل مع الدعم. | " +
          "Some data could not be deleted. We did not treat this as complete. Try again or contact support.",
        code: "purge_incomplete",
      },
      503,
    );
  }

  return json(
    {
      ok: true,
      trainingConsentRevoked: result.trainingConsentRevoked,
      revokedCandidates: result.revokedCandidates,
      storageRemainder: result.storageRemainder,
      note:
        "بيانات التطبيق حُذفت. حساب تسجيل الدخول نفسه لا يُحذف بهذا الإجراء. | " +
        "Application data deleted. Your sign-in account itself is not deleted by this action.",
    },
    200,
  );
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
