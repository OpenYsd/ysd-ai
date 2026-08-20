import { z } from "zod";
import { getAdminContext, forbidden, unauthorized } from "@/lib/admin/guard";
import { revalidateTrainingCandidate } from "@/lib/training/revalidate";

export const runtime = "nodejs";

/**
 * GET — معاينة مرشّحٍ للمراجعة اليدوية (v0.9.5، المرحلة 2B).
 *
 * ── ما يُعرض ──
 *
 * الزوج وحده: سؤالٌ وجوابه. لا المحادثة كلّها، ولا موجّه النظام، ولا سياق
 * الاسترجاع، ولا داخليّات الأدوات، ولا وقتُ التشغيل. المراجِع يحكم على
 * العيّنة، وكلُّ ما يزيد عليها هو كشفٌ بلا مقابل.
 *
 * ── ولا بصمة ولا هوّية ──
 *
 * البصمة أداةُ مقارنةٍ داخلية؛ وإرسالها إلى متصفّح يجعلها مرئيةً في
 * الشبكة وفي الذاكرة بلا أن تُفيد قارئًا. وهوّية صاحب العيّنة ليست من
 * الحكم في شيء: المراجِع يحكم على نصٍّ لا على إنسان، ومعرفتُه بمن كتبه
 * تُدخل في الحكم ما ليس منه.
 *
 * ── والقراءة لا تكفي للقرار ──
 *
 * ما يعيده هذا المسار وصفُ لحظة. والقرار يُعيد الفحص كاملًا عند تنفيذه.
 */

const idSchema = z.string().uuid();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  /**
   * ★ الصلاحية قبل صحّة المعرّف.
   *
   * فردُّ «معرّف غير صحيح» لغير المشرف يفرّق بين شكلٍ وشكل، ويجعل المسار
   * يجيب من لا حقّ له في جوابٍ أصلًا.
   */
  const ctx = await getAdminContext();
  if (!ctx) return await denied();
  if (!idSchema.safeParse(id).success) return json({ error: "غير موجود | Not found" }, 404);

  const result = await revalidateTrainingCandidate(id);

  if (!result.ok) {
    /**
     * ★ و«غير موجود» و«لا صلاحية» لا يُفرَّق بينهما هنا.
     *
     * لأن التفريق يقول لمن يجرّب المعرّفات: هذا موجود وذاك ليس. والمشرف
     * وحده يصل، لكن المبدأ يبقى: لا يُكشف وجودُ صفٍّ بردٍّ مختلف.
     */
    if (result.reason === "not_found") return json({ error: "غير موجود | Not found" }, 404);
    if (result.reason === "database_error") {
      return json({ error: "تعذّرت العملية | Operation failed" }, 503);
    }
    return json({ ok: false, reason: result.reason }, 200);
  }

  return json(
    {
      ok: true,
      approvable: result.approvable,
      blockers: result.blockers,
      privacyCodes: result.privacyCodes,
      qualityCodes: result.qualityCodes,
      redacted: result.preview.redacted,
      userText: result.preview.userText,
      assistantText: result.preview.assistantText,
      status: result.candidate.status,
      source: result.candidate.source,
      createdAt: result.candidate.created_at,
    },
    200,
  );
}

/** غير مسجَّل ⇒ 401 · مسجَّل بلا صلاحية ⇒ 403 — والحارس لا يفرّق، فنفرّق */
async function denied(): Promise<Response> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? forbidden() : unauthorized();
}
