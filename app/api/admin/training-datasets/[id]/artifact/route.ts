import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { createDatasetArtifact } from "@/lib/training/artifact";

export const runtime = "nodejs";

/**
 * بناء أثر تدريبٍ خاصّ من إصدارٍ مجمَّد (v0.9.7، المرحلة 3B).
 *
 * ── ما لا يقبله من العميل ──
 *
 * لا شيء. لا مسار تخزين، ولا دلو، ولا معرّفات مرشّحين، ولا بصمة، ولا عدد،
 * ولا حالة. من يمرّر المسار يكتب أين يقع كلامُ الناس؛ ومن يمرّر البصمة
 * يقرّر ما تشهد له.
 *
 * ── ولا بايتة تخرج ──
 *
 * ولا رابط موقّع، ولا تنزيل. الجواب أعداد: الرقم، وعدد العيّنات، والحجم.
 * والأثر مخصَّصٌ لعاملِ تدريبٍ لم يُبنَ، يقرؤه من الخادم.
 */

const idSchema = z.string().uuid();

const FAILURE_STATUS: Record<string, number> = {
  release_not_found: 404,
  not_frozen: 409,
  release_invalid: 409,
  manifest_mismatch: 409,
  already_exists: 409,
  storage_conflict: 409,
  upload_failed: 503,
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

  const result = await createDatasetArtifact(id, ctx.userId);
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
        action: "training_dataset_artifact_created",
        targetType: "training_dataset_release",
        targetId: id,
        after: {
          version: result.artifact.version,
          sample_count: result.artifact.sampleCount,
          byte_size: result.artifact.byteSize,
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
      version: result.artifact.version,
      sampleCount: result.artifact.sampleCount,
      byteSize: result.artifact.byteSize,
    },
    201,
  );
}
