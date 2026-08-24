import "server-only";
import { logger } from "@/lib/logger";

export type BrowserMetricEvent =
  | "browser.assistant.request"
  | "browser.assistant.sse_complete"
  | "browser.assistant.sse_disconnect"
  | "browser.auth.device_created"
  | "browser.auth.success"
  | "browser.auth.failure"
  | "browser.auth.token_failure"
  | "browser.rate_limited"
  | "browser.quota_rejected"
  | "browser.provider_failure"
  | "browser.server_error";

type MetricLevel = "info" | "warn" | "error";

/**
 * Privacy-safe operational event. Callers can provide only numeric timing/count
 * values and a bounded internal code. User IDs, device codes, URLs, prompts,
 * selection/page text, credentials, and tokens are intentionally not accepted.
 */
export function browserMetric(
  event: BrowserMetricEvent,
  level: MetricLevel = "info",
  fields: { ms?: number; count?: number; code?: string; status?: number } = {},
): void {
  const code = fields.code?.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 64);
  logger[level]({
    event,
    ...(Number.isFinite(fields.ms) ? { ms: Math.max(0, Math.round(fields.ms!)) } : {}),
    ...(Number.isFinite(fields.count) ? { count: Math.max(0, Math.round(fields.count!)) } : {}),
    ...(Number.isFinite(fields.status) ? { status: fields.status } : {}),
    ...(code ? { code } : {}),
  });
}
