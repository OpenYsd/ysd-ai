import { NextRequest } from "next/server";
import { appOrigin } from "@/lib/browser/crypto";
import { createDeviceAuthorization } from "@/lib/browser/device-store";
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  browserDeviceRequestSchema,
  json,
} from "@/lib/browser/schema";

export const runtime = "nodejs";

const MAX_BODY = 4096;

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const parsed = browserDeviceRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const { deviceCode, record } = await createDeviceAuthorization({
    clientId: parsed.data.client_id,
    codeChallenge: parsed.data.code_challenge,
    state: parsed.data.state,
  });

  return json({
    device_code: deviceCode,
    user_code: record.userCode,
    verification_uri: `${appOrigin()}/browser/authorize?user_code=${encodeURIComponent(record.userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
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
