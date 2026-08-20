import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { cancelTrainingJob, prepareTrainingJob } from "@/lib/training/job";

export const runtime = "nodejs";

/**
 * تجهيز مواصفة تدريبٍ أو إلغاؤها (v0.9.8، المرحلة 4A).
 *
 * ── ما يقبله ──
 *
 * كلمةٌ واحدة من اثنتين. ولا `status`، ولا `configHash`، ولا `preparedAt`.
 * من يمرّر البصمة يقرّر ما تشهد له؛ والمشرف يختار **أيّ** فعل، والخادم
 * يقرّر ماذا يُكتب.
 *
 * ── و«مُجهَّزة» لا تعني أن تدريبًا بدأ ──
 *
 * تعني: المواصفة ثبتت وصلحت لتُسلَّم يومًا إلى مُنفِّذ لم يُبنَ. ولا عتاد،
 * ولا مزوّد، ولا نداءَ شبكة.
 */

const idSchema = z.string().uuid();
const bodySchema = z.object({ action: z.enum(["prepare", "cancel"]) }).strict();

const FAILURE_STATUS: Record<string, number> = {
  job_not_found: 404,
  not_draft: 409,
  cancelled: 409,
  conflict: 409,
  artifact_not_found: 409,
  artifact_invalid: 409,
  invalid_config: 409,
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

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  if (parsed.data.action === "cancel") {
    const cancelled = await cancelTrainingJob(id);
    if (!cancelled.ok) {
      return json({ ok: false, reason: cancelled.reason }, FAILURE_STATUS[cancelled.reason] ?? 503);
    }
    try {
      await writeAudit(
        ctx,
        {
          action: "training_job_cancelled",
          targetType: "training_job",
          targetId: id,
          after: { version: cancelled.version },
        },
        req,
      );
    } catch {
      /* التدقيق لا يغيّر النتيجة */
    }
    return json({ ok: true, status: "cancelled", version: cancelled.version }, 200);
  }

  const result = await prepareTrainingJob(id);
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
        action: "training_job_prepared",
        targetType: "training_job",
        targetId: id,
        after: { version: result.version },
      },
      req,
    );
  } catch {
    /* التدقيق لا يغيّر النتيجة */
  }

  /**
   * ★ ولا تُعاد بصمة المواصفة إلى المتصفّح.
   *
   * لا تُفيد قارئًا، وتصير قيمةً في الشبكة يستطيع عميلٌ أن يعيدها لاحقًا
   * مدّعيًا. والمشرف يحتاج أن يعرف أن التجهيز وقع.
   */
  return json({ ok: true, status: "prepared", version: result.version }, 200);
}
