import { z } from "zod";

export const BROWSER_API_VERSION = "1";
export const BROWSER_CLIENT_ID = "ysd-browser";
export const BROWSER_TOKEN_AUDIENCE = "ysd-browser";
export const BROWSER_TOKEN_ISSUER = "ysd-ai";
export const BROWSER_TOKEN_TTL_SECONDS = 60 * 60;
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

export const BROWSER_ACTIONS = ["find_tab", "open_tab", "create_workspace", "move_tabs"] as const;
export type BrowserActionName = (typeof BROWSER_ACTIONS)[number];

export const BROWSER_SCOPES = [
  "browser:chat",
  "browser:page-context",
  "browser:actions-propose",
] as const;
export type BrowserScope = (typeof BROWSER_SCOPES)[number];

export const browserDeviceRequestSchema = z.object({
  client_id: z.literal(BROWSER_CLIENT_ID),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  scope: z.string().max(128).optional(),
});

export const browserTokenRequestSchema = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  client_id: z.literal(BROWSER_CLIENT_ID),
  device_code: z.string().regex(/^[A-Za-z0-9_-]{43,256}$/),
  code_verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

export const browserAuthorizeSchema = z.object({
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  decision: z.enum(["approve", "deny"]),
});

const contextSchema = z.object({
  pageOrigin: z.string().url().max(256).optional(),
  pageText: z.string().max(24_000).optional(),
  selectedText: z.string().max(8_000).optional(),
}).optional();

export const browserChatRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  mode: z.enum(["chat", "page", "selection"]),
  message: z.string().min(1).max(8_000),
  context: contextSchema,
  locale: z.string().max(16).optional(),
  tabSnapshotId: z.string().max(128).optional(),
});

export function normalizeLegacyChatRequest(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  if ("requestId" in r || "message" in r || "mode" in r) return raw;

  const contextType = r.context_type === "page" || r.context_type === "selection" ? r.context_type : "chat";
  return {
    requestId: r.request_id,
    mode: contextType,
    message: r.prompt,
    locale: r.locale,
    context: {
      pageOrigin: r.source_origin,
      pageText: contextType === "page" ? r.content : undefined,
      selectedText: contextType === "selection" ? r.content : undefined,
    },
  };
}

export function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });
}
