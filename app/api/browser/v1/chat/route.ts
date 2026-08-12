import { NextRequest } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { BUDGET_DENY_MESSAGE, estimateInputTokens, finalizeChatBudget, releaseChatBudget, reserveChatBudget } from "@/lib/ai/budget";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { resolveProviderForModel } from "@/lib/ai/registry";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/rate-limit-distributed";
import { browserChatRequestSchema, json, normalizeLegacyChatRequest } from "@/lib/browser/schema";
import { verifyBrowserAccessToken } from "@/lib/browser/token";
import { parseStructuredAssistantOutput } from "@/lib/browser/actions";

export const runtime = "nodejs";
export const maxDuration = 120;

const RATE_LIMIT = Number(process.env.YSD_BROWSER_CHAT_RATE_LIMIT ?? 30);
const RATE_WINDOW_SEC = Number(process.env.YSD_BROWSER_CHAT_RATE_WINDOW_SEC ?? 60);
const STREAM_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 1200;
const SYSTEM_PROMPT = [
  "You are YSD Assistant inside YSD Browser.",
  "Answer the user directly. Never request cookies, tokens, passwords, localStorage, browsing history, private URLs, or files.",
  "If you propose browser work, emit at most one fenced JSON block tagged ysd-browser-action after the human-readable answer.",
  "Allowed actions only: find_tab, open_tab, create_workspace, move_tabs. Never propose script, shell, filesystem, download_and_run, cookie, or credential access.",
].join("\n");

export async function POST(req: NextRequest) {
  const token = verifyBrowserAccessToken(req.headers.get("authorization"));
  if (!token.ok) return json({ error: "unauthorized", code: token.reason }, 401);

  const raw = await readBoundedJson(req, 40_000);
  const parsed = browserChatRequestSchema.safeParse(normalizeLegacyChatRequest(raw));
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const body = parsed.data;
  const privateSignal = req.headers.get("x-ysd-private-context") === "1";
  if (privateSignal && body.mode !== "chat") {
    return json({ error: "private_context_blocked", code: "private_context_blocked" }, 403);
  }

  const rl = await consumeRateLimit(token.claims.sub, "browser_chat", RATE_LIMIT, RATE_WINDOW_SEC);
  if (!rl.allowed) {
    return json({ error: "rate_limit", code: "rate_limit" }, 429, {
      ...rateLimitHeaders(rl),
      "Retry-After": String(rl.retryAfterSec),
    });
  }

  const supabase = getAdminClient();
  if (!supabase) return json({ error: "service_unavailable", code: "service_role_unavailable" }, 503);
  const { data: allowed } = await supabase.rpc("check_usage_allowed", { p_user_id: token.claims.sub });
  if (allowed === false) return json({ error: "quota_exceeded", code: "quota_exceeded" }, 403);

  const userContent = buildUserContent(body);
  const budget = await reserveChatBudget({
    userId: token.claims.sub,
    requestId: body.requestId,
    estimatedInputTokens: estimateInputTokens([SYSTEM_PROMPT, userContent]),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!budget.allowed) {
    const reason = budget.reason === "ok" || budget.reason === "already_reserved" ? "unavailable" : budget.reason;
    return json({ error: BUDGET_DENY_MESSAGE[reason], code: reason }, 403);
  }

  const provider = resolveProviderForModel(YSD_FREE_MODEL_ID);
  if (!provider) {
    await releaseChatBudget(body.requestId);
    return json({ error: "provider_unavailable", code: "provider_unavailable" }, 503);
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), STREAM_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  req.signal.addEventListener("abort", onAbort);
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  let text = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
      try {
        for await (const chunk of provider.streamChat({
          modelId: YSD_FREE_MODEL_ID,
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
          maxTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          signal: timeout.signal,
          grounding: body.mode === "chat" ? { source: "none" } : { source: "user_context" },
        })) {
          if (timeout.signal.aborted || req.signal.aborted) break;
          if (chunk.type === "text" && chunk.text) {
            text += chunk.text;
            send({ type: "text", text: chunk.text });
          } else if (chunk.type === "usage" && chunk.usage) {
            usage = chunk.usage;
          } else if (chunk.type === "error") {
            send({ type: "error", error: chunk.error ?? "generation_failed", code: chunk.errorCode ?? "provider_error" });
          }
        }

        const parsedOutput = parseStructuredAssistantOutput(text, body.tabSnapshotId);
        if (parsedOutput.message && parsedOutput.message !== text.trim()) {
          send({ type: "replace", message: parsedOutput.message });
        }
        if (parsedOutput.action) send({ type: "browser_action_proposal", action: parsedOutput.action });

        if (usage && !req.signal.aborted) {
          await supabase.from("usage_events").insert({
            user_id: token.claims.sub,
            conversation_id: null,
            model_id: YSD_FREE_MODEL_ID,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
          });
          await finalizeChatBudget(body.requestId, usage.inputTokens, usage.outputTokens);
        } else {
          await releaseChatBudget(body.requestId);
        }
        send({ type: "done", requestId: body.requestId });
      } catch {
        await releaseChatBudget(body.requestId);
        if (!req.signal.aborted) send({ type: "error", error: "stream_failed", code: "stream_failed" });
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "x-ysd-request-id": body.requestId,
      ...rateLimitHeaders(rl),
    },
  });
}

function buildUserContent(body: { mode: "chat" | "page" | "selection"; message: string; context?: { pageOrigin?: string; pageText?: string; selectedText?: string } }) {
  if (body.mode === "selection") {
    return `Mode: selection\nOrigin: ${sanitizeOrigin(body.context?.pageOrigin)}\nSelected text:\n${body.context?.selectedText ?? ""}\n\nUser request:\n${body.message}`;
  }
  if (body.mode === "page") {
    return `Mode: page\nOrigin: ${sanitizeOrigin(body.context?.pageOrigin)}\nPage text excerpt:\n${body.context?.pageText ?? ""}\n\nUser request:\n${body.message}`;
  }
  return `Mode: chat\nUser request:\n${body.message}`;
}

function sanitizeOrigin(origin?: string) {
  if (!origin) return "not-sent";
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid";
  }
}

async function readBoundedJson(req: NextRequest, maxChars: number) {
  const raw = await req.text();
  if (raw.length > maxChars) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
