import { BROWSER_ACTIONS, BROWSER_API_VERSION, BROWSER_TOKEN_TTL_SECONDS, json } from "@/lib/browser/schema";
import { browserTokenSecret } from "@/lib/browser/crypto";

export const runtime = "nodejs";

export async function GET() {
  return json({
    apiVersion: BROWSER_API_VERSION,
    assistant: true,
    streaming: true,
    deviceAuth: true,
    pageContext: true,
    selectionContext: true,
    browserActions: BROWSER_ACTIONS,
    maxInputChars: 8_000,
    maxPageContextChars: 24_000,
    maxSelectionContextChars: 8_000,
    tokenLifetimeSeconds: BROWSER_TOKEN_TTL_SECONDS,
    supportedLanguages: ["ar", "en"],
    serviceStatus: browserTokenSecret() ? "available" : "auth_unconfigured",
  });
}
