import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  runHealthChecks,
  type Check,
  type HealthResult,
} from "@/lib/health/checks";
import { publicHealthResponse } from "@/lib/health/public-response";
import { GET as live } from "@/app/api/live/route";

const CHECKS_SOURCE = readFileSync("lib/health/checks.ts", "utf8");
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENROUTER_API_KEY",
  "APP_ORIGIN",
  "RATE_LIMIT_HMAC_SECRET",
] as const;
const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://health-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key-with-safe-test-length";
  process.env.OPENROUTER_API_KEY = "test-provider-key-with-safe-test-length";
  process.env.APP_ORIGIN = "https://ysd-ai-production.up.railway.app";
  process.env.RATE_LIMIT_HMAC_SECRET = "0".repeat(64);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function database(errors: Record<string, boolean> = {}) {
  const calls: Array<{ table: string; columns: string; head: boolean; limit: number }> = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string, options?: { head?: boolean }) {
          return {
            limit(limit: number) {
              calls.push({ table, columns, head: options?.head === true, limit });
              return Promise.resolve({
                data: null,
                error: errors[table] ? { code: "probe_failed" } : null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const storageOk = async (): Promise<Check> => ({ status: "ok" });

describe("Production health-probe security hotfix", () => {
  it("uses the existing server-only client and never asks anon to execute a business RPC", () => {
    const source = codeOnly(CHECKS_SOURCE);
    expect(source).toMatch(/from\s+"@\/lib\/supabase\/admin"/);
    expect(source).toContain("deps.getAdminClient()");
    expect(source).not.toMatch(/from\s+"@\/lib\/supabase\/server"/);
    expect(source).not.toMatch(/match_file_chunks|\.rpc\(/);
  });

  it("returns healthy readiness from HEAD-only server probes without reading rows", async () => {
    const db = database();
    const result = await runHealthChecks({
      getAdminClient: () => db.client,
      probeStorageReachable: storageOk,
    });

    expect(result.overall).toBe("ok");
    expect(result.checks.database?.status).toBe("ok");
    expect(result.checks.pgvector?.status).toBe("ok");
    expect(db.calls).toEqual([
      { table: "usage_limits", columns: "tier", head: true, limit: 1 },
      { table: "file_chunks", columns: "embedding", head: true, limit: 1 },
    ]);
    expect((await publicHealthResponse(result).json()).status).toBe("ok");
    expect(publicHealthResponse(result).status).toBe(200);
  });

  it("fails readiness safely when the server-side database probe fails", async () => {
    const db = database({ usage_limits: true });
    const result = await runHealthChecks({
      getAdminClient: () => db.client,
      probeStorageReachable: storageOk,
    });
    expect(result.overall).toBe("down");
    expect(result.checks.database).toEqual({ status: "down", detail: "query_failed" });
    expect(publicHealthResponse(result).status).toBe(503);
  });

  it("keeps liveness independent and always returns its minimal 200 response", async () => {
    const response = live();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "0.9.0-rc1" });
  });

  it("never exposes internal errors, credentials, headers, tokens, or private data", async () => {
    const privateResult: HealthResult = {
      overall: "down",
      checks: {
        database: {
          status: "down",
          detail:
            "SUPABASE_SERVICE_ROLE_KEY=private Authorization: Bearer token Cookie=email@example.test",
        },
      },
      env: {
        ok: false,
        missingRequired: ["SUPABASE_SERVICE_ROLE_KEY"],
        invalidFormat: [],
        items: [],
      },
      lowMemoryMode: false,
      ms: 1,
    };
    const response = publicHealthResponse(privateResult, new Date("2026-08-21T00:00:00Z"));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      status: "down",
      version: "0.9.0-rc1",
      checked_at: "2026-08-21T00:00:00.000Z",
      checks: { passing: 0, failing: 1 },
    });
    expect(body).not.toMatch(/SERVICE_ROLE|Authorization|Bearer|Cookie|private|@/i);
  });

  it("does not require user authentication and performs no database mutation", () => {
    const source = codeOnly(CHECKS_SOURCE);
    expect(source).not.toMatch(/cookies\(|getUser\(|getSession\(|auth\.uid|user\.id/);
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(source.match(/head:\s*true/g)).toHaveLength(2);
  });
});
