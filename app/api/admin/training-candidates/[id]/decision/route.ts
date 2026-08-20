import { z } from "zod";
import { getAdminContext, forbidden, unauthorized, writeAudit } from "@/lib/admin/guard";
import { decideTrainingCandidate, type Decision } from "@/lib/training/decision";

export const runtime = "nodejs";

/**
 * POST — قرار مراجعةٍ على مرشّح تدريب (v0.9.5، المرحلة 2B).
 *
 * ── ما يقبله من العميل ──
 *
 * كلمةٌ واحدة من ثلاث. لا `status`، ولا `privacy_status`، ولا
 * `quality_status`، ولا `decided_at`، ولا `user_id`، ولا بصمة، ولا نصّ.
 *
 * والفرق ليس شكليًّا: واجهةٌ تقبل `status` تجعل المراجِع يكتب في القاعدة
 * ما شاء — بما فيه `approved` فوق بوّابةٍ مغلقة. فالمراجِع يختار **أيّ**
 * قرار، والخادم يقرّر **ماذا يُكتب**.
 *
 * ── والجواب بلا محتوى ──
 *
 * حالةٌ وطابعُ وقت. ولا نصّ العيّنة، ولا سببٌ خامّ من القاعدة.
 */

const idSchema = z.string().uuid();
const bodySchema = z.object({
  decision: z.enum(["approve", "reject_privacy", "reject_quality"]),
});

/** رمزُ الرفض → حالةُ HTTP — مغلقة، ولا رسالة من القاعدة */
const FAILURE_STATUS: Record<string, number> = {
  not_found: 404,
  already_decided: 409,
  conflict: 409,
  consent_inactive: 409,
  source_deleted: 409,
  source_changed: 409,
  not_owner: 409,
  before_consent: 409,
  role_mismatch: 409,
  privacy_blocked: 409,
  quality_blocked: 409,
  database_error: 503,
};

/** والقرار → فعلُ التدقيق */
const AUDIT_ACTION: Record<Decision, string> = {
  approve: "training_candidate_approved",
  reject_privacy: "training_candidate_rejected_privacy",
  reject_quality: "training_candidate_rejected_quality",
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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? forbidden() : unauthorized();
  }
  if (!idSchema.safeParse(id).success) return json({ error: "غير موجود | Not found" }, 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid" }, 400);

  const decision = parsed.data.decision;
  const result = await decideTrainingCandidate(id, decision);

  if (!result.ok) {
    return json(
      { ok: false, reason: result.reason },
      FAILURE_STATUS[result.reason] ?? 503,
    );
  }

  /**
   * ★ والتدقيق بعد الحسم — ولا يغيّر نتيجته.
   *
   * القرار وقع في القاعدة. فإخفاؤه لأن سطر تدقيقٍ تعثّر يجعل المراجِع
   * يعيد الكرّة على صفٍّ محسوم، فيقرأ `conflict` ويظنّ العطل في مكانٍ آخر.
   * و`writeAudit` تُبلغ برمزٍ عند فشلها.
   *
   * ويُسجَّل **معرّف** العيّنة لا محتواها. و`sanitizeAudit` تُسقط كل حقلٍ
   * اسمُه يحمل `content` — ومنه `content_fingerprint`.
   */
  try {
    await writeAudit(
      ctx,
      {
        action: AUDIT_ACTION[decision],
        targetType: "training_candidate",
        targetId: id,
        after: { status: result.status },
      },
      req,
    );
  } catch {
    /* التدقيق لا يغيّر القرار */
  }

  return json({ ok: true, status: result.status, decidedAt: result.decidedAt }, 200);
}
