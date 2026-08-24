import { json } from "@/lib/browser/schema";
import { isBrowserQaEnvironment } from "@/lib/browser/feature";

const STAGING_FAULTS = new Set([
  "rate_limit",
  "status_500",
  "status_502",
  "status_503",
  "provider_failure",
  "midstream_disconnect",
]);

function isAuthorizedQaUser(userId: string) {
  if (!isBrowserQaEnvironment()) return false;
  if (process.env.YSD_BROWSER_QA_ENABLED !== "1") return false;
  return (process.env.YSD_BROWSER_QA_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}

export function browserQaFaultResponse(
  request: Request,
  userId: string,
  requestId: string,
): Response | null {
  if (!isAuthorizedQaUser(userId)) return null;

  const fault = request.headers.get("x-ysd-qa-fault")?.trim() ?? "";
  if (!STAGING_FAULTS.has(fault)) return null;

  if (fault === "rate_limit") {
    return json({ error: "rate_limit", code: "rate_limit" }, 429, {
      "Retry-After": "2",
      "x-ysd-request-id": requestId,
    });
  }
  if (fault === "midstream_disconnect") {
    return new Response(`data: ${JSON.stringify({ type: "text", text: "partial" })}\n\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "x-ysd-request-id": requestId,
      },
    });
  }

  const status = fault === "status_500" ? 500 : fault === "status_502" ? 502 : 503;
  return json({ error: "service_unavailable", code: "provider_unavailable" }, status, {
    "x-ysd-request-id": requestId,
  });
}
