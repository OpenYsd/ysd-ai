import { getAdminContext, forbidden } from "@/lib/admin/guard";
import { checkYSDPublicActivationReadiness } from "@/lib/ai/ysd-public-readiness";

export const runtime = "nodejs";

/**
 * GET /api/admin/ysd/readiness — جاهزية الفتح العامّ (v0.9.3).
 *
 * ── ما تقوله وما لا تقوله ──
 *
 * `ready: true` تعني: «البوّابات الحالية كلها مفتوحة، فالخطوة التالية
 * الآمنة هي **فقط** قرار فتح مفتاح الخدمة». ولا تعني أن النموذج مفتوح —
 * ولذلك يُرافقها `publiclyEnabled: false` دائمًا. وهما جوابا سؤالين
 * مختلفين، لا تناقضًا.
 *
 * ── وهي قراءةٌ خالصة ──
 *
 * `GET` وحدها: لا كتابة، ولا تفعيل، ولا توليد. ولا سجلّ تدقيق — لأن
 * التدقيق يسجّل ما **وقع**، وقراءةُ حالةٍ لم تُغيّر شيئًا.
 */

export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) return forbidden();

  const result = await checkYSDPublicActivationReadiness(ctx.isOwner);

  /**
   * ★ `no-store` — الجاهزية لا تُخزَّن.
   *
   * لقطةٌ مُخزَّنة تقول «جاهز» بعد أن سقط وقت التشغيل بدقيقة هي أسوأ ما
   * يمكن أن يُعرض هنا: يُفتح المفتاح على جوابٍ صار كاذبًا.
   */
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };

  if (!result.ok) {
    const { status, code } = READINESS_FAILURES[result.reason];
    return new Response(
      JSON.stringify({ ok: false, ready: false, publiclyEnabled: false, code }),
      { status, headers },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      ready: true,
      publiclyEnabled: false,
      /** الخطوة التالية بلا اسم متغيّر بيئة — الواجهة لا تحتاجه */
      nextAction: "enable_public_serving",
    }),
    { status: 200, headers },
  );
}

/**
 * تحويل أسباب الجاهزية إلى رموز عرضٍ مغلقة.
 *
 * `409` حين يكون العائق **حالةً يملكها المشغّل** فيغيّرها (المفتاح مفتوح،
 * الأهليّة مغلقة، القائمة تمنع)، و`503` حين يكون **تعذّرًا** ينتظر إصلاحًا
 * (المزوّد، القاعدة، الفحص). و`403` للصلاحية وحدها.
 */
const READINESS_FAILURES = {
  owner_required: { status: 403, code: "ysd_owner_required" },
  kill_switch_must_be_off: { status: 409, code: "ysd_kill_switch_must_be_off" },
  provider_not_configured: { status: 503, code: "ysd_not_configured" },
  admin_client_unavailable: { status: 503, code: "ysd_database_not_ready" },
  model_not_found: { status: 409, code: "ysd_model_missing" },
  model_gate_off: { status: 409, code: "ysd_model_gate_off" },
  allowlist_blocked: { status: 409, code: "ysd_allowlist_blocked" },
  allowlist_invalid: { status: 409, code: "ysd_allowlist_invalid" },
  health_not_connected: { status: 503, code: "ysd_health_not_connected" },
  database_error: { status: 503, code: "ysd_database_not_ready" },
} as const;
