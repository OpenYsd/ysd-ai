import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";

import {
  BROWSER_PILOT_ALLOWLIST_VARIABLE,
  BROWSER_PILOT_MAX_USERS,
  browserPilotAccessResponse,
  browserPilotAllowlistConfigured,
  browserPilotInfrastructureResponse,
  browserPilotUserAllowed,
} from "@/lib/browser/pilot-allowlist";

const PILOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  delete process.env[BROWSER_PILOT_ALLOWLIST_VARIABLE];
});

describe("Browser limited-pilot identity allowlist", () => {
  it("fails closed when missing, malformed, duplicated, or oversized", async () => {
    expect(browserPilotAllowlistConfigured()).toBe(false);
    expect((await browserPilotInfrastructureResponse()!.json()).code).toBe(
      "pilot_allowlist_unconfigured",
    );

    for (const value of [
      "",
      "   ",
      "not-a-user-id",
      `${PILOT},${PILOT}`,
      Array.from({ length: BROWSER_PILOT_MAX_USERS + 1 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ).join(","),
    ]) {
      process.env[BROWSER_PILOT_ALLOWLIST_VARIABLE] = value;
      expect(browserPilotAllowlistConfigured(), value).toBe(false);
    }
  });

  it("matches only an exact stable server-side user id", async () => {
    process.env[BROWSER_PILOT_ALLOWLIST_VARIABLE] = PILOT;
    expect(browserPilotAllowlistConfigured()).toBe(true);
    expect(browserPilotUserAllowed(PILOT)).toBe(true);
    expect(browserPilotUserAllowed(OTHER)).toBe(false);
    expect(browserPilotAccessResponse(PILOT)).toBeNull();

    const denied = browserPilotAccessResponse(OTHER)!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("pilot_not_allowed");
  });

  it("guards authorization, token minting, and chat before privileged work", () => {
    const expectations = [
      ["app/api/browser/v1/auth/authorize/route.ts", "markUserDecision("],
      ["app/api/browser/v1/auth/token/route.ts", "createBrowserAccessToken("],
      ["app/api/browser/v1/chat/route.ts", "getAdminClient("],
    ] as const;

    for (const [path, privilegedCall] of expectations) {
      const source = fs.readFileSync(path, "utf8");
      const guard = source.indexOf("browserPilotAccessResponse(");
      expect(guard, path).toBeGreaterThan(0);
      expect(guard, path).toBeLessThan(source.indexOf(privilegedCall));
    }
  });

  it("hard-bounds pilot cost before provider execution", () => {
    const route = fs.readFileSync("app/api/browser/v1/chat/route.ts", "utf8");
    expect(route).toContain("const RATE_LIMIT = 3");
    expect(route).toContain("const PILOT_DAILY_LIMIT = 10");
    expect(route).toContain("const MAX_OUTPUT_TOKENS = 400");
    expect(route).toContain('"browser_pilot_day"');
    expect(route).toContain('acquireSlot(token.claims.sub, body.requestId, "free")');
    expect(route).not.toContain("getFallbackProvider");
    expect(FREE_MODEL_CHAIN).toHaveLength(3);
    expect(FREE_MODEL_CHAIN.every((model) => model.endsWith(":free"))).toBe(true);
  });
});
