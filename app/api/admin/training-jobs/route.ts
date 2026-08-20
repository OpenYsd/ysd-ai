import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { createTrainingJobDraft } from "@/lib/training/job";

export const runtime = "nodejs";

/**
 * إنشاء مواصفة تدريب (v0.9.8، المرحلة 4A).
 *
 * ── ما يقبله من العميل ──
 *
 * ثلاثة معرّفات: أثرٌ، ونموذجٌ أساسيّ **من قائمةٍ في الشيفرة**، وإعدادٌ
 * **من قائمةٍ في الشيفرة**. ولا أرقام: من يمرّر `epochs` يقرّر ما يُحفَّظ
 * وما يُعمَّم — وذلك قرارٌ يمرّ من مراجعةٍ لا من حقل.
 *
 * ولا `status`، ولا `configHash`، ولا `createdBy`، ولا مسار تخزين، ولا
 * معرّف مرشّح. كلّها يملكها الخادم.
 *
 * ── ولا تدريب ──
 *
 * لا عتاد، ولا مزوّد، ولا نداءَ شبكةٍ إلى أحد. ما يقع: صفٌّ يصف قرارًا.
 */

const bodySchema = z
  .object({
    artifactId: z.string().uuid(),
    baseModelId: z.string().trim().min(1).max(128),
    presetId: z.string().trim().min(1).max(64),
  })
  .strict();

const FAILURE_STATUS: Record<string, number> = {
  artifact_not_found: 404,
  artifact_invalid: 409,
  unknown_base_model: 400,
  unknown_preset: 400,
  invalid_config: 400,
  database_error: 503,
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const ctx = await getAdminContext();
  if (!ctx) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user ? forbidden() : unauthorized();
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const result = await createTrainingJobDraft(
    parsed.data.artifactId,
    parsed.data.baseModelId,
    parsed.data.presetId,
    ctx.userId,
  );
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
        action: "training_job_created",
        targetType: "training_job",
        targetId: result.draft.jobId,
        after: {
          version: result.draft.version,
          base_model: result.draft.baseModelId,
          preset: result.draft.presetId,
          dataset_version: result.draft.datasetVersion,
          sample_count: result.draft.sampleCount,
        },
      },
      req,
    );
  } catch {
    /* التدقيق لا يغيّر النتيجة */
  }

  return json(
    {
      ok: true,
      version: result.draft.version,
      baseModelId: result.draft.baseModelId,
      presetId: result.draft.presetId,
      datasetVersion: result.draft.datasetVersion,
      sampleCount: result.draft.sampleCount,
    },
    201,
  );
}
