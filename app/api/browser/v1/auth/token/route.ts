import { NextRequest } from "next/server";
import { consumeDevice, getDeviceByCode, isExpired, recordPoll, shouldSlowDown } from "@/lib/browser/device-store";
import { createBrowserAccessToken } from "@/lib/browser/token";
import { browserTokenRequestSchema, DEVICE_MAX_POLL_COUNT, json } from "@/lib/browser/schema";
import { browserTokenSecret, sha256Base64Url, sha256Hex } from "@/lib/browser/crypto";
import { browserAssistantDisabledResponse } from "@/lib/browser/feature";
import { enforceBrowserAuthRateLimits } from "@/lib/browser/auth-rate-limit";
import { clientIpFrom } from "@/lib/http/client-ip";
import { readBoundedJson } from "@/lib/browser/bounded-json";
import { browserMetric } from "@/lib/browser/metrics";

export const runtime = "nodejs";

const MAX_BODY = 4096;
const TOKEN_IP_LIMIT = 90;
const TOKEN_DEVICE_LIMIT = DEVICE_MAX_POLL_COUNT;
const TOKEN_WINDOW_SECONDS = 10 * 60;

export async function POST(req: NextRequest) {
  const disabled = browserAssistantDisabledResponse();
  if (disabled) return disabled;

  const ipLimited = await enforceBrowserAuthRateLimits("token", [{
    bucket: "br-token-ip",
    value: clientIpFrom(req.headers),
    limit: TOKEN_IP_LIMIT,
    windowSeconds: TOKEN_WINDOW_SECONDS,
  }]);
  if (ipLimited) return ipLimited;

  const bounded = await readBoundedJson(req, MAX_BODY);
  const parsed = browserTokenRequestSchema.safeParse(bounded.ok ? bounded.value : null);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const deviceLimited = await enforceBrowserAuthRateLimits("token", [{
    bucket: "br-token-code",
    value: sha256Hex(parsed.data.device_code),
    limit: TOKEN_DEVICE_LIMIT,
    windowSeconds: TOKEN_WINDOW_SECONDS,
  }]);
  if (deviceLimited) return deviceLimited;

  const record = await getDeviceByCode(parsed.data.device_code);
  if (!record || record.clientId !== parsed.data.client_id || record.state !== parsed.data.state) {
    browserMetric("browser.auth.token_failure", "warn", { code: "invalid_code" });
    return json({ error: "invalid_grant", code: "invalid_code" }, 400);
  }
  if (isExpired(record) || record.pollCount >= DEVICE_MAX_POLL_COUNT) {
    browserMetric("browser.auth.token_failure", "warn", { code: "expired_token" });
    return json({ error: "expired_token", code: "expired_token" }, 400);
  }
  if (record.codeChallenge !== sha256Base64Url(parsed.data.code_verifier)) {
    browserMetric("browser.auth.token_failure", "warn", { code: "invalid_verifier" });
    return json({ error: "invalid_grant", code: "invalid_verifier" }, 400);
  }
  if (shouldSlowDown(record)) {
    await recordPoll(record);
    return json({ error: "slow_down", code: "slow_down", interval: 10 }, 429, { "Retry-After": "10" });
  }
  const pollRecorded = await recordPoll(record);
  if (!pollRecorded) {
    return json({ error: "slow_down", code: "slow_down", interval: 10 }, 429, { "Retry-After": "10" });
  }

  if (record.status === "pending") {
    return json({ error: "authorization_pending", code: "authorization_pending" }, 428);
  }
  if (record.status === "denied") return json({ error: "access_denied", code: "access_denied" }, 403);
  if (record.status === "consumed" || !record.userId) {
    browserMetric("browser.auth.token_failure", "warn", { code: "reused_device_code" });
    return json({ error: "invalid_grant", code: "reused_device_code" }, 400);
  }

  if (!browserTokenSecret()) {
    browserMetric("browser.server_error", "error", { code: "token_unconfigured", status: 503 });
    return json({ error: "server_error", code: "token_unconfigured" }, 503);
  }
  const consumed = await consumeDevice(record);
  if (!consumed) {
    browserMetric("browser.auth.token_failure", "warn", { code: "reused_device_code" });
    return json({ error: "invalid_grant", code: "reused_device_code" }, 400);
  }
  const token = createBrowserAccessToken(record.userId, crypto.randomUUID());
  if (!token) return json({ error: "server_error", code: "token_unconfigured" }, 503);
  browserMetric("browser.auth.success");

  return json({
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: token.expiresIn,
    scope: "browser:chat browser:page-context browser:actions-propose",
  });
}
