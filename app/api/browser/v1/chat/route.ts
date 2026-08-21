import { NextRequest } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { BUDGET_DENY_MESSAGE, estimateInputTokens, finalizeChatBudget, releaseChatBudget, reserveChatBudget } from "@/lib/ai/budget";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/rate-limit-distributed";
import { browserChatRequestSchema, json, normalizeLegacyChatRequest } from "@/lib/browser/schema";
import { verifyBrowserAccessToken } from "@/lib/browser/token";
import { parseStructuredAssistantOutput } from "@/lib/browser/actions";
import { buildUserContent } from "@/lib/browser/context";
import { claimRequestDurable, finalizeRequest } from "@/lib/chat/idempotency";
import { readBoundedJson } from "@/lib/browser/bounded-json";
import { browserQaFaultResponse } from "@/lib/browser/qa-fault";
import { browserAssistantDisabledResponse } from "@/lib/browser/feature";
import { resolveBrowserProvider } from "@/lib/browser/provider-readiness";
import { browserMetric } from "@/lib/browser/metrics";

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
  "The fenced block must contain exactly this strict envelope: {\"type\":\"browser_action_proposal\",\"action\":\"<allowed action>\",\"arguments\":{...}}.",
  "Use exactly one arguments schema: find_tab {query}; open_tab {url}; create_workspace {name, query}; move_tabs {query, targetWorkspace}.",
  "Example fenced proposal:",
  "```ysd-browser-action",
  "{\"type\":\"browser_action_proposal\",\"action\":\"find_tab\",\"arguments\":{\"query\":\"Example Domains\"}}",
  "```",
  "Arguments are semantic and minimal. Never invent or request tab ids, workspace ids, commands, scripts, headers, cookies, tokens, filesystem paths, or extra fields.",
].join("\n");

export async function POST(req: NextRequest) {
  const disabled = browserAssistantDisabledResponse();
  if (disabled) return disabled;
  const startedAt = Date.now();
  browserMetric("browser.assistant.request");

  const token = verifyBrowserAccessToken(req.headers.get("authorization"));
  if (!token.ok) return json({ error: "unauthorized", code: token.reason }, 401);

  const bounded = await readBoundedJson(req, 40_000);
  if (!bounded.ok) {
    const code = bounded.reason === "too_large" ? "request_too_large" : "invalid_request";
    return json({ error: code, code }, bounded.reason === "too_large" ? 413 : 400);
  }
  const parsed = browserChatRequestSchema.safeParse(normalizeLegacyChatRequest(bounded.value));
  if (!parsed.success) return json({ error: "invalid_request", code: "invalid_request" }, 400);

  const body = parsed.data;
  const privateSignal = req.headers.get("x-ysd-private-context") === "1";
  if (privateSignal && body.mode !== "chat") {
    return json({ error: "private_context_blocked", code: "private_context_blocked" }, 403);
  }

  const qaFault = browserQaFaultResponse(req, token.claims.sub, body.requestId);
  if (qaFault) return qaFault;

  const supabase = getAdminClient();
  if (!supabase) return json({ error: "service_unavailable", code: "service_role_unavailable" }, 503);
  const claim = await claimRequestDurable(supabase as never, token.claims.sub, body.requestId, null, true);
  if (!claim.ok) {
    if (claim.duplicate) {
      return json({ error: "duplicate_request", code: "duplicate_request" }, 409, {
        "x-ysd-request-id": body.requestId,
      });
    }
    return json({ error: "service_unavailable", code: "idempotency_unavailable" }, 503);
  }

  const rl = await consumeRateLimit(token.claims.sub, "browser_chat", RATE_LIMIT, RATE_WINDOW_SEC);
  if (!rl.allowed) {
    await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "failed", null);
    browserMetric("browser.rate_limited", "warn", { code: "chat", status: 429 });
    return json({ error: "rate_limit", code: "rate_limit" }, 429, {
      ...rateLimitHeaders(rl),
      "Retry-After": String(rl.retryAfterSec),
    });
  }

  const { data: allowed } = await supabase.rpc("check_usage_allowed", { p_user_id: token.claims.sub });
  if (allowed === false) {
    await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "failed", null);
    browserMetric("browser.quota_rejected", "warn", { code: "usage_quota", status: 403 });
    return json({ error: "quota_exceeded", code: "quota_exceeded" }, 403);
  }

  const userContent = buildUserContent(body);
  const budget = await reserveChatBudget({
    userId: token.claims.sub,
    requestId: body.requestId,
    estimatedInputTokens: estimateInputTokens([SYSTEM_PROMPT, userContent]),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!budget.allowed) {
    await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "failed", null);
    const reason = budget.reason === "ok" || budget.reason === "already_reserved" ? "unavailable" : budget.reason;
    browserMetric("browser.quota_rejected", "warn", { code: reason, status: 403 });
    return json({ error: BUDGET_DENY_MESSAGE[reason], code: reason }, 403);
  }

  const providerReadiness = await resolveBrowserProvider(supabase as never);
  if (!providerReadiness.ok) {
    await releaseChatBudget(body.requestId);
    await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "failed", null);
    browserMetric("browser.provider_failure", "error", { code: providerReadiness.code, status: 503 });
    return json({ error: "provider_unavailable", code: "provider_unavailable" }, 503);
  }
  const provider = providerReadiness.provider;

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
            // Provider errors can contain implementation details. Fail the stream
            // through the sanitized catch path and never forward provider text.
            throw new Error("provider_stream_error");
          }
        }

        if (timeout.signal.aborted || req.signal.aborted) {
          throw new Error("browser_stream_aborted");
        }

        const parsedOutput = parseStructuredAssistantOutput(
          text,
          body.tabSnapshotId,
          body.workspaceSnapshotId,
          body.requestId,
        );
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
        await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "completed", null);
        browserMetric("browser.assistant.sse_complete", "info", { ms: Date.now() - startedAt });
        send({ type: "done", requestId: body.requestId });
      } catch {
        await releaseChatBudget(body.requestId);
        await finalizeRequest(supabase as never, token.claims.sub, body.requestId, "failed", null);
        if (req.signal.aborted || timeout.signal.aborted) {
          browserMetric("browser.assistant.sse_disconnect", "warn", { ms: Date.now() - startedAt });
        } else {
          browserMetric("browser.provider_failure", "error", { code: "stream_failed", ms: Date.now() - startedAt });
        }
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
