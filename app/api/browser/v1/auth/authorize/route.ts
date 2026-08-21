import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { browserAuthorizeSchema, json } from "@/lib/browser/schema";
import { getDeviceByUserCode, isExpired, markUserDecision } from "@/lib/browser/device-store";
import { browserAssistantDisabledResponse } from "@/lib/browser/feature";
import { enforceBrowserAuthRateLimits } from "@/lib/browser/auth-rate-limit";
import { clientIpFrom } from "@/lib/http/client-ip";
import { sha256Hex } from "@/lib/browser/crypto";
import { browserMetric } from "@/lib/browser/metrics";
import { readBoundedJson, readBoundedText } from "@/lib/browser/bounded-json";

export const runtime = "nodejs";
const MAX_BODY = 4096;

export async function POST(req: NextRequest) {
  const disabled = browserAssistantDisabledResponse();
  if (disabled) return disabled;

  const ip = clientIpFrom(req.headers);
  const ipLimited = await enforceBrowserAuthRateLimits("authorize", [{
    bucket: "br-authorize-ip",
    value: ip,
    limit: 30,
    windowSeconds: 10 * 60,
  }]);
  if (ipLimited) return ipLimited;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    browserMetric("browser.auth.failure", "warn", { code: "unauthorized" });
    return json({ error: "unauthorized", code: "unauthorized" }, 401);
  }

  const contentType = req.headers.get("content-type") ?? "";
  let raw: unknown = null;
  if (contentType.includes("application/json")) {
    const bounded = await readBoundedJson(req, MAX_BODY);
    raw = bounded.ok ? bounded.value : null;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const bounded = await readBoundedText(req, MAX_BODY);
    raw = bounded.ok ? Object.fromEntries(new URLSearchParams(bounded.value)) : null;
  }
  const parsed = browserAuthorizeSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const limited = await enforceBrowserAuthRateLimits("authorize", [
    { bucket: "br-authorize-user", value: user.id, limit: 20, windowSeconds: 10 * 60 },
    { bucket: "br-authorize-code", value: sha256Hex(parsed.data.user_code), limit: 12, windowSeconds: 10 * 60 },
  ]);
  if (limited) return limited;

  const record = await getDeviceByUserCode(parsed.data.user_code);
  if (!record || isExpired(record) || record.status !== "pending") {
    browserMetric("browser.auth.failure", "warn", { code: "invalid_code" });
    return json({ error: "expired_or_invalid_code", code: "expired_or_invalid_code" }, 400);
  }

  const updated = await markUserDecision(record, user.id, parsed.data.decision);
  if (!updated) {
    browserMetric("browser.auth.failure", "warn", { code: "decision_race" });
    return json({ error: "expired_or_invalid_code", code: "expired_or_invalid_code" }, 400);
  }
  browserMetric(parsed.data.decision === "approve" ? "browser.auth.success" : "browser.auth.failure", "info", {
    code: parsed.data.decision,
  });
  return json({ ok: true, status: parsed.data.decision === "approve" ? "approved" : "denied" });
}
