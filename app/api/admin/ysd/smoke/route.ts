import { NextRequest } from "next/server";
import { getAdminContext, forbidden, writeAudit } from "@/lib/admin/guard";
import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";
import { checkYSDPreActivationSmoke } from "@/lib/ai/ysd-smoke-test";

export const runtime = "nodejs";

/**
 * POST /api/admin/ysd/smoke — اختبار توليدٍ اصطناعيّ قبل الفتح (v0.9.3).
 *
 * ── لماذا POST لا GET ──
 *
 * لأن هذا النداء يُحدث أثرًا خارجيًّا فعليًّا: طلب استدلالٍ يستهلك عتادًا
 * ووقتًا وربما مالًا. و`GET` تُنفَّذ بلا قصد — زاحفٌ يتبع رابطًا، أو
 * متصفّحٌ يستبق التحميل، أو إعادةُ تحميل صفحة. فيصير كل ذلك توليدًا لم
 * يطلبه أحد. و`GET` عقدُها القراءةُ الآمنة، وهذا ليس قراءة.
 *
 * ── ولا يُقبل شيء من الجسم ──
 *
 * لا موجّه، ولا نموذج، ولا هدف. المدخل ثابتٌ في الكود، وقبولُ حرفٍ منه
 * يحوّل هذا المسار إلى بابِ توليدٍ إداريّ بلا حصّة ولا رصد ولا سقف.
 *
 * ── ولا يفتح النموذج ──
 *
 * ينجح الاختبار أو يفشل، ويبقى `publiclyEnabled: false` في الحالين.
 */

/** رموز عرضٍ مغلقة — لا جسم ردٍّ من وقت التشغيل ولا نصّ مولَّد */
const SMOKE_FAILURES = {
  owner_required: { status: 403, code: "ysd_owner_required" },
  not_ready: { status: 409, code: "ysd_not_ready" },
  target_unavailable: { status: 503, code: "ysd_target_unavailable" },
  generation_failed: { status: 503, code: "ysd_generation_failed" },
  unexpected_output: { status: 409, code: "ysd_smoke_output_mismatch" },
  timeout: { status: 504, code: "ysd_smoke_timeout" },
  aborted: { status: 503, code: "ysd_generation_failed" },
  internal_error: { status: 503, code: "ysd_generation_failed" },
} as const;

const HEADERS = {
  "Content-Type": "application/json",
  /** نتيجةُ توليدٍ لحظية — لقطةٌ مُخزَّنة منها تكذب بعد ثوانٍ */
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

export async function POST(req: NextRequest) {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  // ★ الجسم لا يُقرأ إطلاقًا — المدخل ثابت في الكود
  const result = await checkYSDPreActivationSmoke(ctx.isOwner);

  /**
   * التدقيق يسجّل **أن العملية وقعت** ونتيجتها — لا مضمونها.
   *
   * ولا يغيّر فشلُه نتيجةَ الاختبار: العملية وقعت فعلًا في وقت التشغيل،
   * وإخفاؤها لأن سطرًا لم يُكتب يجعل الجواب أسوأ لا أدقّ.
   */
  if (result.ok || result.reason !== "owner_required") {
    await writeAudit(
      ctx,
      {
        action: "model.ysd_smoke_test",
        targetType: "model",
        targetId: YSD_ALPHA_MODEL_ID,
        after: { passed: result.passed, publicServing: false, latencyMs: result.latencyMs },
      },
      req,
    );
  }

  if (!result.ok) {
    const { status, code } = SMOKE_FAILURES[result.reason];
    return new Response(
      JSON.stringify({
        ok: false,
        passed: false,
        publiclyEnabled: false,
        code,
        latencyMs: result.latencyMs,
      }),
      { status, headers: HEADERS },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      passed: true,
      publiclyEnabled: false,
      latencyMs: result.latencyMs,
      /** الخطوة التالية — قرارٌ يُتّخذ خارج هذا المسار */
      nextAction: "enable_public_serving",
    }),
    { status: 200, headers: HEADERS },
  );
}
