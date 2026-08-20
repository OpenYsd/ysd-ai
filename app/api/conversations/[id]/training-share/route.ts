import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { shareConversationForTraining } from "@/lib/training/share";

export const runtime = "nodejs";

/**
 * مشاركة محادثةٍ مع بنك تحسين YSD (v0.9.5، المرحلة 2A).
 *
 * ── ما لا يقبله من العميل ──
 *
 * لا شيء. لا جسم، ولا `userId`، ولا معرّفات رسائل، ولا `status` ولا
 * `privacy_status` ولا `quality_status`. الهوّية من الجلسة، والمحادثة من
 * المسار، والأزواج يستنتجها الخادم، والحقول يملكها الخادم.
 *
 * ووجودُ أيٍّ من هذه في واجهةٍ تقبل من العميل شيئًا يعني بابًا يُفتح من
 * الخارج — ولو لم يستعمله أحد اليوم.
 *
 * ── والجواب أعداد ──
 *
 * ولا نصّ، ولا بصمة، ولا معرّف، ولا رمز خطأ من القاعدة. من يقرأ الجواب
 * يعرف كم دخل وكم رُدّ، ولا يعرف شيئًا عن محتوى ما رُدّ ولا عن بنية ما
 * تحته.
 */

const idSchema = z.string().uuid();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * ★ `POST` وحده — ولا `GET`.
 *
 * فهذا فعلٌ يُنشئ صفوفًا. و`GET` يُستدعى بروابط وبجلبٍ مسبق وبزحف
 * المتصفّح، وفعلٌ كهذا خلف `GET` يقع بلا أن يقصده أحد.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) return json({ error: "غير مصرح | Unauthorized" }, 401);

  const result = await shareConversationForTraining(ctx.userId, id);

  if (!result.ok) {
    /**
     * ★ «لا موافقة» ليست عطلًا — وليست إذنًا ضمنيًّا.
     *
     * تُردّ برمزٍ يفهمه العميل فيرشد صاحبه إلى الإعدادات. ولا يُفعّل شيء
     * تلقائيًّا: موافقةٌ تُمنح بضغطة «شارك» ليست موافقةً، بل مقايضة.
     */
    if (result.reason === "consent_required") {
      return json({ error: "المشاركة غير مفعّلة | Sharing not enabled", code: "training_consent_required" }, 403);
    }
    if (result.reason === "conversation_not_found") {
      return json({ error: "المحادثة غير موجودة | Not found" }, 404);
    }
    return json({ error: "تعذّرت العملية | Operation failed" }, 503);
  }

  /**
   * ★ سطرٌ واحد، أعدادٌ فقط.
   *
   * لا نصّ، ولا معرّف محادثة، ولا معرّف مستخدم. ومن يقرأ السجلّ يرى حجم
   * ما يجري ولا يرى من يجري له ولا فيمَ.
   */
  console.log(
    `[training-share] examined=${result.examined} created=${result.created} ` +
      `duplicates=${result.duplicates} before_consent=${result.beforeConsent} ` +
      `rejected_quality=${result.rejectedQuality} rejected_privacy=${result.rejectedPrivacy} ` +
      `failed=${result.failed} truncated=${result.truncated}`,
  );

  return json(
    {
      ok: true,
      created: result.created,
      duplicates: result.duplicates,
      beforeConsent: result.beforeConsent,
      rejectedQuality: result.rejectedQuality,
      rejectedPrivacy: result.rejectedPrivacy,
      failed: result.failed,
      examined: result.examined,
      truncated: result.truncated,
    },
    200,
  );
}
