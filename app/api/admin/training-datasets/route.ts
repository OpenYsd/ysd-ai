import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { DATASET_FORMAT_VERSION } from "@/lib/training/dataset-format";
import { collectEligibleCandidates, createDatasetDraft } from "@/lib/training/dataset";

export const runtime = "nodejs";

/**
 * إصدارات مجموعة التدريب — معاينةً وإنشاءً (v0.9.6، المرحلة 3A).
 *
 * ── ما لا يقبله من العميل ──
 *
 * معرّفات مرشّحين. من يمرّرها يختار ما يدخل التدريب، وذلك قرارٌ يملكه
 * الخادم: الحارس هو من يختار، لا من يُملى عليه.
 *
 * ولا `sampleCount` ولا `manifestHash` ولا `status` ولا `version` ولا
 * `createdBy`. الأول والثاني يُحسبان، والثالث بالافتراض، والرابع من تسلسل
 * القاعدة، والخامس من الجلسة.
 *
 * ── و`GET` يعاين بلا أن يُنشئ ──
 *
 * فالمشرف يرى كم عيّنةً مؤهَّلة وكم استُبعدت ولماذا — قبل أن يقرّر. ولا
 * صفَّ يُكتب في القراءة.
 */

const bodySchema = z
  .object({ formatVersion: z.literal(DATASET_FORMAT_VERSION).optional() })
  .strict();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function denied(): Promise<Response> {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user ? forbidden() : unauthorized();
}

/** معاينة: كم مؤهَّل، وكم استُبعد ولماذا — أعدادٌ ولا محتوى */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return await denied();

  const collected = await collectEligibleCandidates();
  if (!collected.ok) return json({ error: "تعذّرت العملية | Operation failed" }, 503);

  return json(
    {
      ok: true,
      formatVersion: DATASET_FORMAT_VERSION,
      eligible: collected.entries.length,
      examined: collected.examined,
      skipped: collected.skipped,
    },
    200,
  );
}

export async function POST(req: Request) {
  const ctx = await getAdminContext();
  if (!ctx) return await denied();

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const result = await createDatasetDraft(ctx.userId, DATASET_FORMAT_VERSION);
  if (!result.ok) {
    if (result.reason === "no_eligible_candidates") {
      return json({ ok: false, reason: "no_eligible_candidates" }, 409);
    }
    return json({ error: "تعذّرت العملية | Operation failed" }, 503);
  }

  try {
    await writeAudit(
      ctx,
      {
        action: "training_dataset_created",
        targetType: "training_dataset_release",
        targetId: result.draft.releaseId,
        after: { version: result.draft.version, sample_count: result.draft.sampleCount },
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
      sampleCount: result.draft.sampleCount,
      skipped: result.draft.skipped,
      examined: result.draft.examined,
    },
    201,
  );
}
