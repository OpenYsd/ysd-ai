import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { redactLogValue, sanitizedErrorCode } from "@/lib/log-redaction";

const PROVIDER_KEY = "sk" + "-or-v1-testkeythatmustneverappear1234567890";
const SERVICE_ROLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "a".repeat(32) + "." + "b".repeat(32);
const BROWSER_SECRET = "browser_secret_" + "c".repeat(48);
const HMAC_SECRET = "hmac_secret_" + "d".repeat(48);

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
});
