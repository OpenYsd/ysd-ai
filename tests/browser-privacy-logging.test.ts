import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  userId: "11111111-1111-4111-8111-111111111111" as string | null,
  email: "pilot@example.invalid",
  deviceUnavailable: false,
  deviceRecord: {
    deviceCodeHash: "device-hash",
    userCode: "ABCD-EFGH",
    clientId: "ysd-browser",
    codeChallenge: "",
    state: "s".repeat(32),
    status: "approved",
    userId: "11111111-1111-4111-8111-111111111111" as string | null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    lastPollAt: null as string | null,
    pollCount: 0,
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.userId ? { id: state.userId, email: state.email } : null },
      }),
    },
  }),
}));

vi.mock("@/lib/browser/auth-rate-limit", () => ({
  enforceBrowserAuthRateLimits: async () => null,
}));

vi.mock("@/lib/browser/device-store", () => ({
  createDeviceAuthorization: async () => state.deviceUnavailable ? null : {
    deviceCode: "d".repeat(64),
    record: state.deviceRecord,
    storage: "db",
  },
  getDeviceByUserCode: async () => state.deviceUnavailable ? null : state.deviceRecord,
  getDeviceByCode: async () => state.deviceUnavailable ? null : state.deviceRecord,
  isExpired: () => false,
  markUserDecision: async () => true,
  recordPoll: async () => true,
  shouldSlowDown: () => false,
  consumeDevice: async () => true,
}));

import { POST as devicePost } from "@/app/api/browser/v1/auth/device/route";
import { POST as authorizePost } from "@/app/api/browser/v1/auth/authorize/route";
import { POST as tokenPost } from "@/app/api/browser/v1/auth/token/route";
import { POST as chatPost } from "@/app/api/browser/v1/chat/route";
import { sha256Base64Url } from "@/lib/browser/crypto";
import { createBrowserAccessToken } from "@/lib/browser/token";

const PILOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EMAIL = "pilot@example.invalid";
const DEVICE_CODE = "d".repeat(64);
const USER_CODE = "ABCD-EFGH";
const VERIFIER = "v".repeat(64);
const STATE = "s".repeat(32);
const TOKEN_SECRET = "test-only-browser-token-secret-" + "x".repeat(40);

function request(path: string, body: unknown, authorization?: string): NextRequest {
  return new NextRequest(`https://ysd.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

function captureLogs() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join("\n");
}

function expectIdentityFree(logs: string, extra: string[] = []): void {
  for (const value of [
    PILOT,
    OTHER,
    EMAIL,
    DEVICE_CODE,
    USER_CODE,
    VERIFIER,
    TOKEN_SECRET,
    "Authorization",
    "Bearer ",
    ...extra,
  ]) {
    expect(logs).not.toContain(value);
  }
}

beforeEach(() => {
  process.env.YSD_BROWSER_ASSISTANT_ENABLED = "1";
  process.env.YSD_BROWSER_PILOT_USER_IDS = PILOT;
  process.env.YSD_BROWSER_TOKEN_SECRET = TOKEN_SECRET;
  process.env.NEXT_PUBLIC_SITE_URL = "https://ysd.invalid";
  state.userId = PILOT;
  state.email = EMAIL;
  state.deviceUnavailable = false;
  state.deviceRecord = {
    ...state.deviceRecord,
    codeChallenge: sha256Base64Url(VERIFIER),
    state: STATE,
    status: "approved",
    userId: PILOT,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    lastPollAt: null,
    pollCount: 0,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.YSD_BROWSER_ASSISTANT_ENABLED;
  delete process.env.YSD_BROWSER_PILOT_USER_IDS;
  delete process.env.YSD_BROWSER_TOKEN_SECRET;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("Browser Assistant privacy-safe logging", () => {
  it("keeps device authorization codes out of logs", async () => {
    const logs = captureLogs();
    const response = await devicePost(request("/api/browser/v1/auth/device", {
      client_id: "ysd-browser",
      code_challenge: state.deviceRecord.codeChallenge,
      code_challenge_method: "S256",
      state: STATE,
    }));

    expect(response.status).toBe(200);
    expectIdentityFree(logs());
  });

  it("authorizes the allowlisted account without logging its Supabase user object", async () => {
    state.deviceRecord.status = "pending";
    const logs = captureLogs();
    const response = await authorizePost(request("/api/browser/v1/auth/authorize", {
      user_code: USER_CODE,
      decision: "approve",
    }));

    expect(response.status).toBe(200);
    expectIdentityFree(logs());
  });

  it("returns a generic denial and does not log the denied identity", async () => {
    state.userId = OTHER;
    const logs = captureLogs();
    const response = await authorizePost(request("/api/browser/v1/auth/authorize", {
      user_code: USER_CODE,
      decision: "approve",
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "pilot_not_allowed", code: "pilot_not_allowed" });
    expect(JSON.stringify(body)).not.toContain(OTHER);
    expectIdentityFree(logs());
  });

  it("returns a generic 401 without logging Supabase user or request metadata", async () => {
    state.userId = null;
    const logs = captureLogs();
    const response = await authorizePost(request("/api/browser/v1/auth/authorize", {
      user_code: USER_CODE,
      decision: "approve",
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "unauthorized", code: "unauthorized" });
    expectIdentityFree(logs());
  });

  it("mints a short-lived token without writing the token or account identity to logs", async () => {
    const logs = captureLogs();
    const response = await tokenPost(request("/api/browser/v1/auth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "ysd-browser",
      device_code: DEVICE_CODE,
      code_verifier: VERIFIER,
      state: STATE,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.access_token).toEqual(expect.any(String));
    expectIdentityFree(logs(), [body.access_token]);
  });

  it("does not log the Authorization header, token subject, or chat input on error paths", async () => {
    const made = createBrowserAccessToken(PILOT, "privacy-test-jti");
    expect(made).not.toBeNull();
    const logs = captureLogs();
    const response = await chatPost(request("/api/browser/v1/chat", {
      requestId: "privacy_request_01",
      mode: "chat",
      message: "",
    }, `Bearer ${made!.accessToken}`));

    expect(response.status).toBe(400);
    expectIdentityFree(logs(), [made!.accessToken]);
  });

  it("keeps backend error logs generic when device storage is unavailable", async () => {
    state.deviceUnavailable = true;
    const logs = captureLogs();
    const response = await devicePost(request("/api/browser/v1/auth/device", {
      client_id: "ysd-browser",
      code_challenge: state.deviceRecord.codeChallenge,
      code_challenge_method: "S256",
      state: STATE,
    }));

    expect(response.status).toBe(503);
    expectIdentityFree(logs());
  });
});
