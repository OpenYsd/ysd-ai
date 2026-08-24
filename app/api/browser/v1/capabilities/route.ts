import { BROWSER_ACTIONS, BROWSER_API_VERSION, BROWSER_TOKEN_TTL_SECONDS, json } from "@/lib/browser/schema";
import { browserTokenSecret } from "@/lib/browser/crypto";
import { isBrowserAssistantEnabled } from "@/lib/browser/feature";
import { browserPilotAllowlistConfigured } from "@/lib/browser/pilot-allowlist";

export const runtime = "nodejs";

export async function GET() {
  const enabled = isBrowserAssistantEnabled();
  const authConfigured = Boolean(browserTokenSecret());
  const pilotConfigured = browserPilotAllowlistConfigured();
  const available = enabled && authConfigured && pilotConfigured;
  return json({
    apiVersion: BROWSER_API_VERSION,
    assistant: available,
    streaming: available,
    deviceAuth: available,
    pageContext: available,
    selectionContext: available,
    browserActions: available ? BROWSER_ACTIONS : [],
    maxInputChars: 8_000,
    maxPageContextChars: 24_000,
    maxSelectionContextChars: 8_000,
    tokenLifetimeSeconds: BROWSER_TOKEN_TTL_SECONDS,
    supportedLanguages: ["ar", "en"],
    serviceStatus: !enabled
      ? "disabled"
      : !pilotConfigured
        ? "pilot_unconfigured"
        : authConfigured
          ? "available"
          : "auth_unconfigured",
  });
}
