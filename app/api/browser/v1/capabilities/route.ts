import { BROWSER_ACTIONS, BROWSER_API_VERSION, BROWSER_TOKEN_TTL_SECONDS, json } from "@/lib/browser/schema";
import { browserTokenSecret } from "@/lib/browser/crypto";
import { isBrowserAssistantEnabled } from "@/lib/browser/feature";

export const runtime = "nodejs";

export async function GET() {
  const enabled = isBrowserAssistantEnabled();
  const authConfigured = Boolean(browserTokenSecret());
  return json({
    apiVersion: BROWSER_API_VERSION,
    assistant: enabled,
    streaming: enabled,
    deviceAuth: enabled && authConfigured,
    pageContext: enabled,
    selectionContext: enabled,
    browserActions: enabled ? BROWSER_ACTIONS : [],
    maxInputChars: 8_000,
    maxPageContextChars: 24_000,
    maxSelectionContextChars: 8_000,
    tokenLifetimeSeconds: BROWSER_TOKEN_TTL_SECONDS,
    supportedLanguages: ["ar", "en"],
    serviceStatus: !enabled ? "disabled" : authConfigured ? "available" : "auth_unconfigured",
  });
}
