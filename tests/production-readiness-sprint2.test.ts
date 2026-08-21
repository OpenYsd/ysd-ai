import fs from "node:fs";
import { describe, expect, it } from "vitest";

const BROWSER_MIGRATION =
  "supabase/migrations/20260821024622_browser_assistant_production_readiness.sql";
const DEFINER_MIGRATION =
  "supabase/migrations/20260821035648_security_definer_least_privilege.sql";
const VECTOR_MIGRATION =
  "supabase/migrations/20260821035652_harden_vector_extension_schema_v2.sql";

describe("Production Readiness Sprint 2 contracts", () => {
  it("keeps Browser Assistant and global privilege hardening independently deployable", () => {
    const browser = fs.readFileSync(BROWSER_MIGRATION, "utf8");
    const definer = fs.readFileSync(DEFINER_MIGRATION, "utf8");

    expect(browser).toContain("browser_device_authorizations");
    expect(browser).not.toContain("claim_rag_job");
    expect(browser).not.toContain("match_file_chunks");
    expect(definer).toContain("claim_rag_job");
    expect(definer).toContain("match_file_chunks");
    expect(definer).toMatch(/revoke execute on function %s from public, anon/i);
    expect(definer).toContain("PUBLIC or anon SECURITY DEFINER execution remains");
  });

  it("moves pgvector forward-only and preserves the RAG contract", () => {
    const sql = fs.readFileSync(VECTOR_MIGRATION, "utf8");

    expect(sql).toContain("alter extension vector set schema extensions");
    expect(sql).toContain("extensions.vector(384)");
    expect(sql).toContain("operator(extensions.<=>)");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("idx_chunks_embedding");
    expect(sql).toContain("a.atttypmod = 384");
    expect(sql).not.toMatch(/\bdrop\s+(table|schema|column|extension)\b/i);
  });

  it("pins the safe PostCSS release through a supported npm override", () => {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      devDependencies: Record<string, string>;
      overrides: Record<string, string>;
    };

    expect(manifest.devDependencies.postcss).toBe("8.5.26");
    expect(manifest.overrides.postcss).toBe("8.5.26");
  });
});
