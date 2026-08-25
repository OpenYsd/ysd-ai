import { describe, expect, it, vi } from "vitest";

import { logger, newCorrelationId } from "@/lib/logger";
import { redactLogValue, sanitizedErrorCode } from "@/lib/log-redaction";
import { browserMetric } from "@/lib/browser/metrics";

const PROVIDER_KEY = "sk" + "-or-v1-testkeythatmustneverappear1234567890";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "a".repeat(32) + "." + "b".repeat(32);
const BROWSER_SECRET = "browser_secret_" + "c".repeat(48);
const HMAC_SECRET = "hmac_secret_" + "d".repeat(48);
const PILOT_UUID = "11111111-1111-4111-8111-111111111111";
const PILOT_EMAIL = "pilot@example.invalid";

describe("log redaction", () => {
  it("removes raw provider, service role, browser, HMAC, and Authorization values", () => {
    const redacted = JSON.stringify(redactLogValue({
      provider: { apiKey: PROVIDER_KEY },
      supabase: { service_role_key: SERVICE_ROLE },
      browser: { token: BROWSER_SECRET },
      rate: { secret: HMAC_SECRET },
      headers: { authorization: `Bearer ${PROVIDER_KEY}`, cookie: "sb-auth-token=abc" },
    }));

    for (const secret of [PROVIDER_KEY, SERVICE_ROLE, BROWSER_SECRET, HMAC_SECRET, "Bearer "]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it("sanitizes nested errors before logger output", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.error({
      event: "provider.failure",
      code: "provider_error",
      metadata: {
        request: {
          headers: { Authorization: `Bearer ${PROVIDER_KEY}` },
          config: { api_key: SERVICE_ROLE },
        },
      },
    } as never);

    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).not.toContain(PROVIDER_KEY);
    expect(line).not.toContain(SERVICE_ROLE);
    expect(line).not.toMatch(/Authorization.*Bearer/i);
    expect(line).toContain("[REDACTED]");
    spy.mockRestore();
  });

  it("keeps provider failure metadata to safe codes only", () => {
    expect(sanitizedErrorCode({ code: "provider_timeout", authorization: `Bearer ${PROVIDER_KEY}` })).toBe("provider_timeout");
    expect(sanitizedErrorCode({ code: "bad code with spaces", apiKey: PROVIDER_KEY })).toBe("error");
  });

  it("removes stable account identifiers from application logs", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logger.warn({
      event: "browser.auth.failure",
      code: PILOT_UUID,
      ref: PILOT_EMAIL,
    });

    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).not.toContain(PILOT_UUID);
    expect(line).not.toContain(PILOT_EMAIL);
    expect(line.match(/\[REDACTED\]/g)?.length).toBe(2);
    spy.mockRestore();
  });

  it("uses anonymous non-UUID correlation ids", () => {
    const correlation = newCorrelationId();
    expect(correlation).toMatch(/^corr_[a-f0-9]{32}$/);
    expect(correlation).not.toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  });

  it("does not accept identity or credentials as metric codes", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const code of [PILOT_UUID, PILOT_EMAIL, PROVIDER_KEY]) {
      browserMetric("browser.auth.failure", "warn", { code });
    }

    const lines = spy.mock.calls.flat().join("\n");
    for (const value of [PILOT_UUID, PILOT_EMAIL, PROVIDER_KEY]) {
      expect(lines).not.toContain(value);
    }
    spy.mockRestore();
  });
});
