import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { deleteAccountForUser, type IdentityAdmin } from "@/lib/account/delete-account";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * حذف الحساب نهائيًّا (v0.9.17، المرحلة 6F).
 *
 * ── الهوية من الجلسة وحدها ──
 *
 * لا `user_id` في الجسم ولا في الاستعلام. والجسم يحمل تأكيدًا واحدًا لا
 * أكثر — فلو قُبل معرّفٌ من المتصفّح لَصار هذا المسار بابًا لمحو حساب غيرك.
 *
 * ── وتأكيدٌ أقوى من تأكيد «حذف بياناتي» ──
 *
 * `DELETE_ACCOUNT` لا `DELETE`. فعلان مختلفان في الأثر يجب أن يختلفا في
 * الكلمة: من نسخ تأكيدَ الأوّل لا يقع في الثاني بالخطأ.
 *
 * ── ولا مفتاحَ خدمةٍ في المتصفّح ──
 *
 * `getAdminClient` من وحدةٍ عليها `import "server-only"` — استيرادُها من
 * مكوّن عميل خطأُ بناءٍ لا تحذير.
 */

const schema = z.object({ confirm: z.literal("DELETE_ACCOUNT") });

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  /**
   * فحصُ الأصل — دفاعٌ ثانٍ خلف `SameSite=Lax`. ويُقبل غيابُ الترويسة:
   * متصفّحٌ يزوّر الطلب **يرسلها** دائمًا، ومنعُ من لا يرسلها يكسر استعمالًا
   * مشروعًا بلا أن يمنع هجومًا.
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
    return json(
      { error: 'أرسل {"confirm":"DELETE_ACCOUNT"} للتأكيد | Confirmation required' },
      400,
    );
  }

  const client = getAdminClient();
  const admin: IdentityAdmin | null = client
    ? { deleteUser: (id: string) => client.auth.admin.deleteUser(id) }
    : null;

  const result = await deleteAccountForUser(supabase, admin, user.id);

  if (!result.ok) {
    /**
     * ★ حدثٌ يُنبَّه عليه — لا سطرَ نصٍّ يضيع في السجلّ.
     *
     * حذفٌ لم يكتمل يترك حسابًا قائمًا وصاحبَه يظنّ أنه انصرف. فيخرج باسمٍ
     * ثابت (`account_delete_incomplete`) ورمزِ خطوةٍ من مجموعةٍ مغلقة
     * ومعرّفِ طلب — وهي أبعادٌ تكفي للتنبيه والتتبّع.
     *
     * ولا بريد، ولا معرّف مستخدم، ولا مسار تخزين، ولا نصّ قاعدة. فالسجلّ
     * الذي يحمل هويّةً يصير هو نفسه تسريبًا يوم يُصدَّر إلى خدمةٍ خارجية.
     */
    logger.error({
      event: "account_delete_incomplete",
      code: result.failedAt ?? "unknown",
      correlation: req.headers.get("x-ysd-request-id") ?? undefined,
    });
    return json(
      {
        ok: false,
        error:
          "تعذّر حذف الحساب بالكامل. حسابك ما زال قائمًا. حاول مرة أخرى أو تواصل مع الدعم. | " +
          "The account could not be fully deleted. Your account is still active. Try again or contact support.",
        code: "delete_incomplete",
      },
      503,
    );
  }

  /**
   * ★ ولا يُقال «تمّ» إلا والهوية ذهبت فعلًا.
   *
   * والجلسة تُنهى هنا كي لا يبقى كوكي يشير إلى هويةٍ لم تعد موجودة.
   * وتعثّرُه لا يُبطل النجاح: الحساب ذهب، والكوكي بلا قيمة بعده.
   */
  await supabase.auth.signOut().catch(() => undefined);

  return json(
    {
      ok: true,
      identityDeleted: result.identityDeleted,
      trainingConsentRevoked: result.trainingConsentRevoked,
      revokedCandidates: result.revokedCandidates,
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
