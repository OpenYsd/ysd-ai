import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_MAX_POLL_COUNT,
  DEVICE_POLL_INTERVAL_SECONDS,
} from "@/lib/browser/schema";

const MIGRATION = "supabase/migrations/20260821052041_browser_assistant_production_readiness.sql";

afterEach(() => {
  for (const name of [
    "YSD_BROWSER_ASSISTANT_ENABLED",
    "YSD_BROWSER_TOKEN_SECRET",
    "YSD_DEPLOYMENT_ENVIRONMENT",
    "RAILWAY_ENVIRONMENT_NAME",
    "YSD_BROWSER_PROVIDER",
    "YSD_BROWSER_MODEL_ID",
    "OPENROUTER_API_KEY",
  ]) delete process.env[name];
  vi.restoreAllMocks();
});

describe("Browser Assistant Production kill switch", () => {
  it.each([undefined, "", "0", "false", "unexpected"])("fails closed for %s", async (value) => {
    if (value !== undefined) process.env.YSD_BROWSER_ASSISTANT_ENABLED = value;
    const { GET } = await import("@/app/api/browser/v1/capabilities/route");
    const response = await GET();
    const body = await response.json();
    expect(body).toMatchObject({
      assistant: false,
      streaming: false,
      deviceAuth: false,
      serviceStatus: "disabled",
    });
    expect(body.browserActions).toEqual([]);
  });

  it.each(["1", "true", "TRUE"])("enables only through an explicit true value: %s", async (value) => {
    process.env.YSD_BROWSER_ASSISTANT_ENABLED = value;
    process.env.YSD_BROWSER_TOKEN_SECRET = "s".repeat(64);
    const { GET } = await import("@/app/api/browser/v1/capabilities/route");
    const body = await (await GET()).json();
    expect(body.assistant).toBe(true);
    expect(body.deviceAuth).toBe(true);
    expect(body.serviceStatus).toBe("available");
  });

  it("guards every capability before auth, parsing, or provider work", () => {
    for (const route of [
      "app/api/browser/v1/auth/device/route.ts",
      "app/api/browser/v1/auth/token/route.ts",
      "app/api/browser/v1/auth/authorize/route.ts",
      "app/api/browser/v1/chat/route.ts",
    ]) {
      const source = fs.readFileSync(route, "utf8");
      const guard = source.indexOf("browserAssistantDisabledResponse()");
      expect(guard, route).toBeGreaterThan(0);
      for (const sensitive of ["getUser()", "readBoundedJson(", "verifyBrowserAccessToken(", "createDeviceAuthorization("]) {
        const at = source.indexOf(sensitive);
        if (at >= 0) expect(guard, `${route}: ${sensitive}`).toBeLessThan(at);
      }
    }
  });
});

describe("Device authorization hard bounds and abuse protection", () => {
  it("derives a finite total poll count from the full authorization lifetime", () => {
    expect(DEVICE_CODE_TTL_SECONDS).toBe(600);
    expect(DEVICE_POLL_INTERVAL_SECONDS).toBeGreaterThanOrEqual(5);
    expect(DEVICE_MAX_POLL_COUNT).toBe(
      Math.ceil(DEVICE_CODE_TTL_SECONDS / DEVICE_POLL_INTERVAL_SECONDS),
    );
    expect(DEVICE_MAX_POLL_COUNT).toBe(120);
  });

  it("enforces IP, user, endpoint, and hashed-code dimensions with Retry-After", () => {
    const device = fs.readFileSync("app/api/browser/v1/auth/device/route.ts", "utf8");
    const token = fs.readFileSync("app/api/browser/v1/auth/token/route.ts", "utf8");
    const authorize = fs.readFileSync("app/api/browser/v1/auth/authorize/route.ts", "utf8");
    const limiter = fs.readFileSync("lib/browser/auth-rate-limit.ts", "utf8");

    expect(device).toContain('bucket: DEVICE_BUCKET');
    expect(token).toContain('bucket: "br-token-ip"');
    expect(token).toContain('bucket: "br-token-code"');
    expect(token).toContain("sha256Hex(parsed.data.device_code)");
    expect(authorize).toContain('bucket: "br-authorize-ip"');
    expect(authorize).toContain('bucket: "br-authorize-user"');
    expect(authorize).toContain('bucket: "br-authorize-code"');
    expect(limiter).toContain('"Retry-After"');
    expect(limiter).not.toMatch(/account.*exist/i);
  });

  it("uses conditional poll and consume updates so replay cannot mint two tokens", () => {
    const store = fs.readFileSync("lib/browser/device-store.ts", "utf8");
    const token = fs.readFileSync("app/api/browser/v1/auth/token/route.ts", "utf8");
    expect(store).toContain('.eq("poll_count", record.pollCount)');
    expect(store).toContain('.lt("poll_count", DEVICE_MAX_POLL_COUNT)');
    expect(store).toContain('.eq("status", "approved")');
    expect(store).toContain('.select("device_code_hash")');
    expect(token.indexOf("await consumeDevice(record)")).toBeLessThan(token.indexOf("createBrowserAccessToken("));
    expect(token).toContain("record.pollCount >= DEVICE_MAX_POLL_COUNT");
  });
});

describe("deterministic Browser Assistant provider", () => {
  function registry(provider: Record<string, unknown> | null, model: Record<string, unknown> | null) {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === "ai_providers" ? provider : model,
              error: null,
            }),
          }),
        }),
      }),
    };
  }

  it("accepts only enabled OpenRouter + ysd/free registry state", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    const { resolveBrowserProvider } = await import("@/lib/browser/provider-readiness");
    const ready = await resolveBrowserProvider(registry(
      { id: "openrouter", enabled: true },
      { id: "ysd/free", provider_id: "openrouter", enabled: true },
    ) as never);
    expect(ready.ok).toBe(true);
    if (ready.ok) expect(ready.provider.id).toBe("openrouter");
  });

  it("fails closed on disabled, missing, mismatched, or contradictory state", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    const { resolveBrowserProvider } = await import("@/lib/browser/provider-readiness");

    await expect(resolveBrowserProvider(registry(
      { id: "openrouter", enabled: false },
      { id: "ysd/free", provider_id: "openrouter", enabled: true },
    ) as never)).resolves.toMatchObject({ ok: false, code: "provider_disabled" });

    await expect(resolveBrowserProvider(registry(
      { id: "openrouter", enabled: true },
      { id: "ysd/free", provider_id: "groq", enabled: true },
    ) as never)).resolves.toMatchObject({ ok: false, code: "model_provider_mismatch" });

    process.env.YSD_BROWSER_PROVIDER = "groq";
    await expect(resolveBrowserProvider(registry(
      { id: "openrouter", enabled: true },
      { id: "ysd/free", provider_id: "openrouter", enabled: true },
    ) as never)).resolves.toMatchObject({ ok: false, code: "environment_conflict" });
  });

  it("fails closed when the provider registry cannot be read", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    const { resolveBrowserProvider } = await import("@/lib/browser/provider-readiness");
    const unavailable = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => { throw new Error("registry unavailable"); } }),
        }),
      }),
    };
    await expect(resolveBrowserProvider(unavailable as never)).resolves.toMatchObject({
      ok: false,
      code: "provider_missing",
    });
  });

  it("never enters the generic Groq fallback path", () => {
    const route = fs.readFileSync("app/api/browser/v1/chat/route.ts", "utf8");
    expect(route).toContain("resolveBrowserProvider(");
    expect(route).not.toContain("getFallbackProvider");
    expect(route).not.toMatch(/from ["']@\/lib\/ai\/groq["']/);
  });

  it("uses only explicit free models with bounded output and durable budget accounting", async () => {
    const { FREE_MODEL_CHAIN } = await import("@/lib/ai/free-models");
    expect(FREE_MODEL_CHAIN.length).toBeGreaterThan(0);
    expect(FREE_MODEL_CHAIN.every((model) => model.endsWith(":free"))).toBe(true);
    const route = fs.readFileSync("app/api/browser/v1/chat/route.ts", "utf8");
    expect(route).toContain("const MAX_OUTPUT_TOKENS = 1200");
    expect(route).toContain("reserveChatBudget(");
    expect(route).toContain("finalizeChatBudget(");
    expect(route).toContain("releaseChatBudget(");
  });
});

describe("forward-only production migration contract", () => {
  it("is additive, conflict-detecting, bounded, indexed, and least-privilege", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("browser_device_authorizations conflicts");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("limit p_limit");
    expect(sql).toContain("alter table public.browser_device_authorizations force row level security");
    expect(sql).toMatch(/revoke all on table public\.browser_device_authorizations from public, anon, authenticated/i);
    expect(sql).toContain("ysd_browser_cleanup_v1_bounded_indexed");
    expect(sql).not.toMatch(/\bdrop\s+(table|function|schema|column)\b/i);
    expect(sql).not.toContain("0035_browser_assistant_device_auth.sql");
  });
});
