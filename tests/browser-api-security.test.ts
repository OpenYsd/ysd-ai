import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

import { BROWSER_API_VERSION, browserChatRequestSchema } from "@/lib/browser/schema";
import { createBrowserAccessToken, verifyBrowserAccessToken } from "@/lib/browser/token";
import { parseStructuredAssistantOutput, sanitizeActionProposal } from "@/lib/browser/actions";
import { sha256Base64Url, signHmac } from "@/lib/browser/crypto";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
  delete process.env.YSD_BROWSER_TOKEN_SECRET;
  delete process.env.YSD_BROWSER_ASSISTANT_ENABLED;
  vi.useRealTimers();
});

describe("YSD Browser API capabilities", () => {
  it("returns versioned capabilities without secrets", async () => {
    process.env.YSD_BROWSER_TOKEN_SECRET = SECRET;
    process.env.YSD_BROWSER_ASSISTANT_ENABLED = "1";
    const { GET } = await import("@/app/api/browser/v1/capabilities/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.apiVersion).toBe(BROWSER_API_VERSION);
    expect(body.streaming).toBe(true);
    expect(body.deviceAuth).toBe(true);
    expect(body.browserActions).toEqual(["find_tab", "open_tab", "create_workspace", "move_tabs"]);
    expect(JSON.stringify(body)).not.toMatch(/key|secret|service_role|openrouter|anthropic/i);
  });
});

describe("YSD Browser scoped tokens", () => {
  it("signs short-lived browser audience tokens only", () => {
    process.env.YSD_BROWSER_TOKEN_SECRET = SECRET;
    const token = createBrowserAccessToken("11111111-1111-4111-8111-111111111111", "jti-1");

    expect(token).not.toBeNull();
    expect(token!.expiresIn).toBeLessThanOrEqual(3600);
    const verified = verifyBrowserAccessToken(`Bearer ${token!.accessToken}`);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.aud).toBe("ysd-browser");
      expect(verified.claims.scope).toContain("browser:chat");
      expect(verified.claims.scope).not.toContain("service_role");
    }
  });

  it("fails closed for wrong audience, expired tokens, and malformed tokens", () => {
    process.env.YSD_BROWSER_TOKEN_SECRET = SECRET;
    const made = createBrowserAccessToken("11111111-1111-4111-8111-111111111111", "jti-2")!;
    const parts = made.accessToken.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    payload.aud = "other-client";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");

    expect(verifyBrowserAccessToken(`Bearer ${parts.join(".")}`)).toMatchObject({ ok: false });
    expect(verifyBrowserAccessToken("Bearer not-a-token")).toEqual({ ok: false, reason: "malformed" });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3_700_000);
    expect(verifyBrowserAccessToken(`Bearer ${made.accessToken}`)).toEqual({ ok: false, reason: "expired" });
  });

  it("fails closed for missing browser chat scope", () => {
    process.env.YSD_BROWSER_TOKEN_SECRET = SECRET;
    const made = createBrowserAccessToken("11111111-1111-4111-8111-111111111111", "jti-3")!;
    const parts = made.accessToken.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    payload.scope = ["browser:page-context"];
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    parts[2] = signHmac(`${parts[0]}.${parts[1]}`, SECRET);

    expect(verifyBrowserAccessToken(`Bearer ${parts.join(".")}`)).toMatchObject({ ok: false });
  });
});

describe("YSD Browser action proposals", () => {
  it("drops unknown and dangerous actions", () => {
    for (const action of ["execute_script", "shell", "powershell", "filesystem", "download_and_run", "read_file", "write_file"]) {
      expect(sanitizeActionProposal({ type: "browser_action_proposal", action, arguments: {} })).toBeNull();
    }
  });

  it("validates known action schemas and source origin", () => {
    const ok = sanitizeActionProposal({
      type: "browser_action_proposal",
      action: "open_tab",
      arguments: { url: "https://example.com/path" },
    });
    expect(ok).not.toBeNull();
    expect(ok!.sourceOrigin).toBe("https://ysd-ai-production.up.railway.app");
    expect(sanitizeActionProposal({
      type: "browser_action_proposal",
      action: "open_tab",
      arguments: { url: "file:///C:/secret.txt" },
    })).toBeNull();
  });

  it("accepts only minimal semantic workspace arguments", () => {
    const create = sanitizeActionProposal({
      type: "browser_action_proposal",
      action: "create_workspace",
      arguments: { name: "QA Workspace", query: "QA source" },
    }, "tabs-v1", "workspaces-v1", "request_12345678");
    expect(create).toMatchObject({
      id: "request_12345678",
      tabSnapshotId: "tabs-v1",
      workspaceSnapshotId: "workspaces-v1",
      arguments: { name: "QA Workspace", query: "QA source" },
    });

    const move = sanitizeActionProposal({
      type: "browser_action_proposal",
      action: "move_tabs",
      arguments: { query: "QA source", targetWorkspace: "QA Workspace" },
    }, "tabs-v1", "workspaces-v1", "request_12345678");
    expect(move).not.toBeNull();

    for (const dangerous of [
      { name: "QA", query: "QA", command: "powershell" },
      { name: "QA", query: "QA", tabIds: ["invented"] },
      { query: "QA", targetWorkspace: "QA", execute_script: "alert(1)" },
    ]) {
      const action = "targetWorkspace" in dangerous ? "move_tabs" : "create_workspace";
      expect(sanitizeActionProposal({ type: "browser_action_proposal", action, arguments: dangerous })).toBeNull();
    }
  });

  it("binds retries of one request to one stable proposal id", () => {
    const raw = {
      type: "browser_action_proposal",
      action: "open_tab",
      arguments: { url: "https://example.com/qa" },
    };
    const first = sanitizeActionProposal(raw, "tabs", "workspaces", "request_same_123");
    const duplicate = sanitizeActionProposal(raw, "tabs", "workspaces", "request_same_123");
    expect(first?.id).toBe("request_same_123");
    expect(duplicate?.id).toBe(first?.id);
  });

  it("parses only the exact line-bounded fenced proposal envelope", () => {
    const output = [
      "I found the matching tab.",
      "```ysd-browser-action",
      JSON.stringify({
        type: "browser_action_proposal",
        action: "find_tab",
        arguments: { query: "Example Domains" },
      }),
      "```",
    ].join("\n");

    const parsed = parseStructuredAssistantOutput(output, "tabs-v1", "workspaces-v1", "request_12345678");
    expect(parsed.message).toBe("I found the matching tab.");
    expect(parsed.action).toMatchObject({
      id: "request_12345678",
      action: "find_tab",
      arguments: { query: "Example Domains" },
    });

    const inline = "prefix```ysd-browser-action\n{}\n```";
    expect(parseStructuredAssistantOutput(inline)).toEqual({ message: inline, action: null });
  });
});

describe("YSD Browser request idempotency wiring", () => {
  it("claims the request before provider execution and rejects duplicates", () => {
    const route = fs.readFileSync("app/api/browser/v1/chat/route.ts", "utf8");
    const claimAt = route.indexOf("await claimRequestDurable(");
    const rateLimitAt = route.indexOf("await consumeRateLimit(");
    const quotaAt = route.indexOf('supabase.rpc("check_usage_allowed"');
    const providerAt = route.indexOf("provider.streamChat(");
    const usageAt = route.indexOf('from("usage_events").insert');
    expect(claimAt).toBeGreaterThan(0);
    expect(rateLimitAt).toBeGreaterThan(claimAt);
    expect(quotaAt).toBeGreaterThan(rateLimitAt);
    expect(providerAt).toBeGreaterThan(quotaAt);
    expect(usageAt).toBeGreaterThan(providerAt);
    expect(route).toContain('code: "duplicate_request"');
    expect(route).toContain("body.requestId, null, true");
    expect(route).toContain('throw new Error("browser_stream_aborted")');
    expect(route).not.toContain("await req.text()");
    expect(route).not.toContain("chunk.error ??");
    expect(route).not.toContain("chunk.errorCode ??");
  });

  it("fails closed when a durable browser idempotency claim is unavailable", async () => {
    const { _resetIdempotency, claimRequestDurable } = await import("@/lib/chat/idempotency");
    _resetIdempotency();
    const unavailable = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { code: "57P01" } }),
          }),
        }),
      }),
    };

    const result = await claimRequestDurable(
      unavailable as never,
      "browser-user",
      "request_durable_123",
      null,
      true,
    );
    expect(result).toMatchObject({ ok: false, duplicate: false });
  });
});

describe("YSD Browser device auth contract", () => {
  it("uses PKCE S256 verifier matching", () => {
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".slice(0, 64);
    expect(sha256Base64Url(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("migration stores no browsing content or secrets", () => {
    const sql = fs.readFileSync("supabase/migrations/0035_browser_assistant_device_auth.sql", "utf8");
    const table = sql.slice(sql.indexOf("create table"), sql.indexOf("create index"));
    for (const forbidden of [/\bpassword\b/i, /\bcookie/i, /\btoken\b/i, /\bpage_text\b/i, /\burl\b/i, /\bhistory\b/i, /\bprovider\b/i, /\bapi_key\b/i]) {
      expect(table).not.toMatch(forbidden);
    }
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.browser_device_authorizations from anon, authenticated/i);
  });
});

describe("YSD Browser context minimization limits", () => {
  it("rejects oversized browser cloud payload fields", () => {
    const base = { requestId: "req_12345678", mode: "page", message: "summarize" };

    expect(browserChatRequestSchema.safeParse({
      ...base,
      context: { pageOrigin: "https://example.com", pageText: "x".repeat(24_001) },
    }).success).toBe(false);
    expect(browserChatRequestSchema.safeParse({
      requestId: "req_12345679",
      mode: "selection",
      message: "explain",
      context: { pageOrigin: "https://example.com", selectedText: "x".repeat(8_001) },
    }).success).toBe(false);
    expect(browserChatRequestSchema.safeParse({
      requestId: "req_12345680",
      mode: "chat",
      message: "x".repeat(8_001),
    }).success).toBe(false);
  });

  it("builds provider context from only the selected mode and sanitized origin", async () => {
    const { buildUserContent } = await import("@/lib/browser/context");
    const selection = buildUserContent({
      mode: "selection",
      message: "explain",
      context: {
        pageOrigin: "https://example.test/account/private-page?token=fake-secret&user=test#fragment",
        selectedText: "known selected text",
        pageText: "UNRELATED-PAGE-CANARY PASSWORD-TEST-VALUE HIDDEN-DOM-CANARY",
      },
    });

    expect(selection).toContain("Origin: https://example.test");
    expect(selection).toContain("known selected text");
    expect(selection).not.toMatch(/private-page|fake-secret|user=test|fragment/);
    expect(selection).not.toMatch(/UNRELATED-PAGE-CANARY|PASSWORD-TEST-VALUE|HIDDEN-DOM-CANARY/);

    const page = buildUserContent({
      mode: "page",
      message: "summarize",
      context: {
        pageOrigin: "https://example.test/sensitive/path?token=fake-secret",
        pageText: "VISIBLE-PAGE-TEXT",
        selectedText: "UNRELATED-SELECTION-CANARY",
      },
    });
    expect(page).toContain("Origin: https://example.test");
    expect(page).toContain("VISIBLE-PAGE-TEXT");
    expect(page).not.toMatch(/sensitive\/path|fake-secret|UNRELATED-SELECTION-CANARY/);
  });

  it("rejects credential-bearing or non-http origin metadata", async () => {
    const { sanitizeOrigin } = await import("@/lib/browser/context");
    expect(sanitizeOrigin("https://user:password@example.test/private")).toBe("invalid");
    expect(sanitizeOrigin("file:///C:/private.txt")).toBe("invalid");
    expect(sanitizeOrigin("https://example.test/private?secret=yes")).toBe("https://example.test");
  });
});
