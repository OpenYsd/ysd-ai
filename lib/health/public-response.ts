import { summarizeCounts, type HealthResult } from "@/lib/health/checks";
import { APP_VERSION } from "@/lib/version";

/** جسم عامّ ثابت الحدود: لا تمرّ تفاصيل الفحوص أو الأسرار إلى الاستجابة. */
export function publicHealthResponse(
  result: HealthResult,
  checkedAt = new Date(),
): Response {
  const { passing, failing } = summarizeCounts(result.checks);
  const body = {
    status: result.overall,
    version: APP_VERSION,
    checked_at: checkedAt.toISOString(),
    checks: { passing, failing },
  };

  return new Response(JSON.stringify(body), {
    status: result.overall === "down" ? 503 : 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
