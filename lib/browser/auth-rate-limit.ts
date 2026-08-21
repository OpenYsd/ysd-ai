import "server-only";
import { consumeKeyedRate } from "@/lib/rate-limit-keyed";
import { json } from "@/lib/browser/schema";
import { browserMetric } from "@/lib/browser/metrics";
import { deploymentEnvironment } from "@/lib/browser/feature";

export interface BrowserRateDimension {
  bucket: string;
  value: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Applies every dimension in order using the existing Supabase-backed keyed
 * limiter. It returns one generic contract, so it never confirms an account,
 * device code, or user-code match.
 */
export async function enforceBrowserAuthRateLimits(
  endpoint: "device" | "token" | "authorize",
  dimensions: BrowserRateDimension[],
): Promise<Response | null> {
  for (const dimension of dimensions) {
    let decision: Awaited<ReturnType<typeof consumeKeyedRate>>;
    try {
      decision = await consumeKeyedRate(
        dimension.bucket,
        dimension.value,
        dimension.limit,
        dimension.windowSeconds,
        `browser-auth-${endpoint}`,
      );
    } catch {
      browserMetric("browser.server_error", "error", { code: "rate_limit_unavailable", status: 503 });
      return json({ error: "service_unavailable", code: "service_unavailable" }, 503);
    }

    const environment = deploymentEnvironment();
    if (decision.backend !== "distributed" && environment !== "development" && environment !== "test") {
      browserMetric("browser.server_error", "error", { code: "rate_limit_unavailable", status: 503 });
      return json({ error: "service_unavailable", code: "service_unavailable" }, 503);
    }
    if (!decision.allowed) {
      browserMetric("browser.rate_limited", "warn", { code: endpoint, status: 429 });
      return json({ error: "rate_limited", code: "rate_limited" }, 429, {
        "Retry-After": String(Math.max(1, Math.ceil(dimension.windowSeconds))),
      });
    }
  }
  return null;
}
