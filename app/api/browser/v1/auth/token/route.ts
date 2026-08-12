import { NextRequest } from "next/server";
import { consumeDevice, getDeviceByCode, isExpired, recordPoll, shouldSlowDown } from "@/lib/browser/device-store";
import { createBrowserAccessToken } from "@/lib/browser/token";
import { browserTokenRequestSchema, json } from "@/lib/browser/schema";
import { sha256Base64Url } from "@/lib/browser/crypto";

export const runtime = "nodejs";

const MAX_BODY = 4096;

export async function POST(req: NextRequest) {
  const parsed = browserTokenRequestSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const record = await getDeviceByCode(parsed.data.device_code);
  if (!record || record.clientId !== parsed.data.client_id || record.state !== parsed.data.state) {
    return json({ error: "invalid_grant", code: "invalid_code" }, 400);
  }
  if (isExpired(record)) return json({ error: "expired_token", code: "expired_token" }, 400);
  if (record.codeChallenge !== sha256Base64Url(parsed.data.code_verifier)) {
    return json({ error: "invalid_grant", code: "invalid_verifier" }, 400);
  }
  if (shouldSlowDown(record)) {
    await recordPoll(record);
    return json({ error: "slow_down", code: "slow_down", interval: 10 }, 429, { "Retry-After": "10" });
  }
  await recordPoll(record);

  if (record.status === "pending") {
    return json({ error: "authorization_pending", code: "authorization_pending" }, 428);
  }
  if (record.status === "denied") return json({ error: "access_denied", code: "access_denied" }, 403);
  if (record.status === "consumed" || !record.userId) {
    return json({ error: "invalid_grant", code: "reused_device_code" }, 400);
  }

  const token = createBrowserAccessToken(record.userId, crypto.randomUUID());
  if (!token) return json({ error: "server_error", code: "token_unconfigured" }, 503);
  await consumeDevice(record);

  return json({
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: token.expiresIn,
    scope: "browser:chat browser:page-context browser:actions-propose",
  });
}

async function readJson(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
