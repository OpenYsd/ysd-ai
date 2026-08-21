import { getAdminContext } from "@/lib/admin/guard";
import { logger, newCorrelationId } from "@/lib/logger";
import { runHealthChecks } from "@/lib/health/checks";
import { checkTrainingInvariants } from "@/lib/ops/training-invariants";
import { reconcileFilesStorage } from "@/lib/ops/storage-reconcile";
import { APP_VERSION } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * الصحة التفصيلية — **إداري فقط** (v0.7.0).
 *
 * هذا هو الوجه الذي كان `/api/health` يعرضه للعامة: حالة كل تبعية على حدة،
 * وسبب كل عطل، واسم نموذج Embeddings وأبعاده، وأسماء متغيّرات البيئة الناقصة.
 * نافع للتشخيص، وخطر بلا مصادقة — فصار خلف حارس الإدارة.
 *
 * غير الإداري يحصل على 403 بلا أي تفصيل (ولا حتى تلميح إلى وجود المسار).
 */
export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) {
    return new Response(JSON.stringify({ error: "غير مصرح" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const correlation = newCorrelationId();
  /**
   * ★ تشخيصُ ثوابت التدريب — يُقرأ حين يفتح إداريٌّ اللوحة، لا دوريًّا.
   *
   * لا عمليةَ خلفية ولا إصلاحَ تلقائيّ: يعدّ الحالات المستحيلة ويُبلّغ.
   * فحالةٌ مستحيلة دليلٌ على كسرٍ في موضعٍ آخر، ومحوُها يُخفي السبب.
   */
  /**
   * ★ ومطابقةُ التخزين بالقاعدة — تكشف ما لا يكشفه أي فحصٍ صحّيّ.
   *
   * التطبيق يعمل والصفوف موجودة والقائمة تُعرض — ثم لا يجد أحدٌ الملفّ.
   */
  const [result, invariants, storage] = await Promise.all([
    runHealthChecks(),
    checkTrainingInvariants(ctx.supabase),
    reconcileFilesStorage(ctx.supabase),
  ]);

  logger.info({
    correlation,
    event: "admin_health_check",
    status: result.overall,
    ms: result.ms,
  });

  const body = {
    status: result.overall,
    version: APP_VERSION,
    checked_at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    lowMemoryMode: result.lowMemoryMode,
    env: {
      ok: result.env.ok,
      missingRequired: result.env.missingRequired, // أسماء فقط — لا قيم
      invalidFormat: result.env.invalidFormat,
    },
    checks: result.checks,
    /** أسماءٌ وأعداد — لا معرّفات ولا محتوى */
    trainingInvariants: invariants,
    /** أعدادٌ فقط — ولا مسارَ تخزينٍ يخرج (يحمل معرّف المالك في أوّله) */
    storageReconcile: storage,
    ms: result.ms,
  };

  return new Response(JSON.stringify(body), {
    status: 200, // إداري: 200 دائمًا؛ الحالة في الجسم
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
