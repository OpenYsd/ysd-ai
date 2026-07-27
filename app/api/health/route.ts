import { logger, newCorrelationId } from "@/lib/logger";
import { runHealthChecks, summarizeCounts } from "@/lib/health/checks";
import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * الصحة (readiness) — **الوجه العام** بعد v0.7.0.
 *
 * يُنفَّذ الفحص كاملًا (فالحالة الإجمالية تحتاجه)، لكن **لا يُكشف منه للعامة**
 * إلا الملخّص: الحالة والإصدار ووقت الفحص وعدد الناجح/الفاشل.
 *
 * لماذا التقليص: المسار بلا مصادقة (PUBLIC_API في الوسيط)، وكان يعرض أسماء
 * الخدمات الخلفية وحالة كل واحدة واسم نموذج Embeddings وأبعاده وسبب كل عطل —
 * خريطة جاهزة لمن يريد توقيت الضغط على الحلقة الأضعف.
 *
 * التفصيل الكامل انتقل إلى /api/admin/health (إداري فقط)، وصفحة /admin/health
 * لم تتغيّر.
 *
 * 503 عند down تبقى للمنسّقات — ولهذا **لا يُربط بها فحص المنصّة**: استخدم
 * /api/live فهو liveness بلا تبعيات.
 */
export async function GET() {
  const correlation = newCorrelationId();
  const result = await runHealthChecks();
  const { passing, failing } = summarizeCounts(result.checks);

  // السجل الداخلي يبقى كما هو — التقليص يخصّ الاستجابة العامة لا التشخيص
  logger.info({
    correlation,
    event: "health_check",
    status: result.overall,
    ms: result.ms,
  });

  const body = {
    status: result.overall,
    version: APP_VERSION,
    checked_at: new Date().toISOString(),
    checks: { passing, failing },
  };

  return new Response(JSON.stringify(body), {
    status: result.overall === "down" ? 503 : 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
