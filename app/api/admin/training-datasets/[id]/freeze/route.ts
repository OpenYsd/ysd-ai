import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { freezeDatasetRelease } from "@/lib/training/dataset";

export const runtime = "nodejs";

/**
 * تجميد إصدار (v0.9.6، المرحلة 3A).
 *
 * ── ولا يقبل من العميل حرفًا ──
 *
 * لا `manifestHash`، ولا `sampleCount`، ولا `status`. من يمرّر البصمة
 * يقرّر ما تشهد له؛ ومن يمرّر العدد يجعل البيان يصف ما ليس فيه. الخادم
 * يعيد التحقّق، ويحسب، ويجمّد.
 *
 * ── والفشل مغلق ──
 *
 * عنصرٌ واحد لم يعد صالحًا يُسقط التجميد كلّه. ولا يُحذف من المسوَّدة
 * صامتًا ثم يُجمَّد الباقي — ذلك يجعل المشرف يجمّد غير ما رأى.
 */

const idSchema = z.string().uuid();

const FAILURE_STATUS: Record<string, number> = {
  not_found: 404,
  not_draft: 409,
  empty: 409,
  revalidation_failed: 409,
  conflict: 409,
  database_error: 503,
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const ctx = await getAdminContext();
  if (!ctx) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user ? forbidden() : unauthorized();
  }
  if (!idSchema.safeParse(id).success) return json({ error: "غير موجود | Not found" }, 404);

  const result = await freezeDatasetRelease(id);
  if (!result.ok) {
    return json(
      { ok: false, reason: result.reason, ...(result.invalid ? { invalid: result.invalid } : {}) },
      FAILURE_STATUS[result.reason] ?? 503,
    );
  }

  try {
    await writeAudit(
      ctx,
      {
        action: "training_dataset_frozen",
        targetType: "training_dataset_release",
        targetId: result.frozen.releaseId,
        after: { version: result.frozen.version, sample_count: result.frozen.sampleCount },
      },
      req,
    );
  } catch {
    /* التدقيق لا يغيّر النتيجة */
  }

  /**
   * ★ ولا تُعاد بصمةُ البيان إلى المتصفّح.
   *
   * لا تُفيد قارئًا، وتصير قيمةً في الشبكة يستطيع عميلٌ أن يعيدها لاحقًا
   * مدّعيًا. والمشرف يحتاج أن يعرف أن التجميد وقع وكم عيّنة فيه.
   */
  return json(
    { ok: true, version: result.frozen.version, sampleCount: result.frozen.sampleCount },
    200,
  );
}
