import { z } from "zod";
import { getAdminContext, forbidden, unauthorized } from "@/lib/admin/guard";
import { buildTrainingExecutionPlan, RUNPOD_PRICE_REFERENCE } from "@/lib/training/execution-plan";

export const runtime = "nodejs";

/**
 * GET — معاينة خطّة التنفيذ وحكمِ الجاهزية (v0.9.10، المرحلة 4B-1).
 *
 * ── `GET` وحده — ولا `POST` ──
 *
 * وغيابُ `POST` هنا ليس نقصًا يُكمَّل لاحقًا بسطر: هو العقد. لا يوجد في
 * هذه الرقعة مسارٌ يُطلق تدريبًا، ولا دالّةٌ تُنشئ عتادًا، ولا مفتاحُ
 * مزوّد. والقراءة تقول ما **سيقع لو** سُلّمت — لا تُسلّمها.
 *
 * ── وما لا يخرج ──
 *
 * لا مسار تخزين، ولا رابط موقّع، ولا بايتة من الأثر، ولا سرّ، ولا هوّية
 * صاحب بيانات. الخطّة وصفُ قرارٍ وعتادٍ ونسخ.
 */

const idSchema = z.string().uuid();

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(
  _req: Request,
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

  const built = await buildTrainingExecutionPlan(id);
  if (!built.ok) {
    if (built.reason === "job_not_found") return json({ error: "غير موجود | Not found" }, 404);
    if (built.reason === "not_prepared") return json({ ok: false, reason: "not_prepared" }, 409);
    return json({ error: "تعذّرت العملية | Operation failed" }, 503);
  }

  const { plan, planHash, readiness } = built.result;

  return json(
    {
      ok: true,
      /** ★ الحكم أوّلًا — فلا تُقرأ الخطّة وحدها فتُفهم إذنًا */
      readyForExecution: readiness.ready,
      reason: readiness.ready ? null : readiness.reason,
      sampleCount: readiness.facts?.sampleCount ?? plan.sampleCount,
      minimumSamples: readiness.facts?.minimumSamples ?? null,
      policyVersion: readiness.facts?.policyVersion ?? null,
      plan: {
        provider: plan.provider,
        gpuProfile: plan.gpuProfile,
        gpuCount: plan.gpuCount,
        baseModel: plan.baseModel,
        revision: plan.revision,
        method: plan.method,
        preset: plan.preset,
        seed: plan.seed,
        datasetVersion: plan.datasetVersion,
        runtimeStackVersion: plan.runtimeStackVersion,
        dependencyVersions: plan.dependencyVersions,
        expectedOutputType: plan.expectedOutputType,
        executable: plan.executable,
      },
      planHash,
      /** ★ تقديرٌ موسومٌ بأنه تقدير — ولا يدخل بصمةً */
      costEstimate: RUNPOD_PRICE_REFERENCE,
    },
    200,
  );
}
