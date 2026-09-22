import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { runHealthChecks, type Check } from "@/lib/health/checks";
import { probeF2llmV2Column } from "@/lib/health/f2llm-probe";

/**
 * فحص عمود v2 في /api/health — خلف العَلَم فقط، HEAD بلا صفوف ولا كتابة.
 * ★ العَلَم مطفأ (الإنتاج) ⇒ المسار كما كان تمامًا: فحصان لا ثالث لهما (وحارس hotfix الإنتاج يبقى كما هو).
 */

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://health-test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-test-key-with-safe-test-length",
  OPENROUTER_API_KEY: "test-provider-key-with-safe-test-length",
  APP_ORIGIN: "https://ysd-ai-production.up.railway.app",
  RATE_LIMIT_HMAC_SECRET: "0".repeat(64),
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
              return Promise.resolve({ data: null, error: errors[`${table}.${columns}`] || errors[table] ? { code: "probe_failed" } : null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
const storageOk = async (): Promise<Check> => ({ status: "ok" });

describe("★ فحص v2 في الصحة", () => {
  it("★ ★ ★ العَلَم مطفأ: فحصان فقط ولا مفتاح pgvector_v2 — الإنتاج لا يتغيّر", async () => {
    const db = database();
    const r = await runHealthChecks({ getAdminClient: () => db.client, probeStorageReachable: storageOk });
    expect(db.calls).toEqual([
      { table: "usage_limits", columns: "tier", head: true, limit: 1 },
      { table: "file_chunks", columns: "embedding", head: true, limit: 1 },
    ]);
    expect(r.checks.pgvector_v2).toBeUndefined();
    expect(r.checks.embeddings?.detail).not.toContain("space=");
  });

  it("★ ★ ★ العَلَم مشتعل: فحصٌ ثالث HEAD على embedding_v2 وحده، ويظهر الفضاء في تفاصيل النموذج", async () => {
    vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
    const db = database();
    const r = await runHealthChecks({ getAdminClient: () => db.client, probeStorageReachable: storageOk });
    expect(db.calls).toEqual([
      { table: "usage_limits", columns: "tier", head: true, limit: 1 },
      { table: "file_chunks", columns: "embedding", head: true, limit: 1 },
      { table: "file_chunks", columns: "embedding_v2", head: true, limit: 1 },
    ]);
    expect(r.checks.pgvector_v2).toEqual({ status: "ok" });
    expect(r.checks.embeddings?.detail).toContain("space=f2llm");
    expect(r.overall).toBe("ok");
  });

  it("★ ★ ★ الترحيل 0048 غير مطبَّق (العمود غير مقروء) والعَلَم مشتعل ⇒ الصحة تُبلّغ بذلك — لا تشغيلٌ صامتٌ على قاعدةٍ ناقصة", async () => {
    vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
    const db = database({ "file_chunks.embedding_v2": true });
    const r = await runHealthChecks({ getAdminClient: () => db.client, probeStorageReachable: storageOk });
    expect(r.checks.pgvector_v2).toEqual({ status: "down", detail: "v2_column_missing_or_unreadable" });
    expect(r.checks.pgvector?.status).toBe("ok"); // مسار e5 سليم — الخلل في v2 وحده
    expect(r.overall).not.toBe("ok");
  });

  it("★ ★ ★ العَلَم مشتعل في بيئة production: يُتجاهل، فلا فحص v2 ولا تغيّر", async () => {
    vi.stubEnv("YSD_RAG_EMBEDDING_MODEL", "f2llm-v2-80m");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = database();
    const r = await runHealthChecks({ getAdminClient: () => db.client, probeStorageReachable: storageOk });
    expect(db.calls).toHaveLength(2);
    expect(r.checks.pgvector_v2).toBeUndefined();
  });
});

describe("★ probeF2llmV2Column", () => {
  it("مهلةٌ ⇒ down/timeout بلا تعليق", async () => {
    const never = { from: () => ({ select: () => ({ limit: () => new Promise(() => {}) }) }) } as unknown as SupabaseClient;
    expect(await probeF2llmV2Column(never, 20)).toEqual({ status: "down", detail: "timeout" });
  });
  it("استثناءٌ ⇒ down بلا تسريب رسالته", async () => {
    const boom = { from: () => { throw new Error("secret-detail-should-not-leak"); } } as unknown as SupabaseClient;
    const r = await probeF2llmV2Column(boom);
    expect(r).toEqual({ status: "down", detail: "v2_probe_failed" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("★ ★ ★ المصدر HEAD-only: بلا كتابة ولا RPC ولا قراءة مستخدم", () => {
    const src = readFileSync("lib/health/f2llm-probe.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    expect(src).not.toMatch(/cookies\(|getUser\(|getSession\(|auth\.uid|user\.id/);
    expect(src.match(/head:\s*true/g)).toHaveLength(1);
  });
});
