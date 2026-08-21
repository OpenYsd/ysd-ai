import "server-only";
import { json } from "@/lib/browser/schema";

const ENABLED_VALUES = new Set(["1", "true"]);

export type DeploymentEnvironment = "production" | "staging" | "development" | "test" | "unknown";

export function deploymentEnvironment(): DeploymentEnvironment {
  // Railway's platform identity is authoritative and cannot be weakened by an
  // application-level override. This is especially important for QA faults.
  const railway = (process.env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase();
  if (railway === "production" || railway === "staging") return railway;
  if (railway) return "unknown";

  const explicit = (process.env.YSD_DEPLOYMENT_ENVIRONMENT ?? "").trim().toLowerCase();

  if (explicit === "production" || explicit === "staging" || explicit === "development") {
    return explicit;
  }
  if (explicit) return "unknown";
  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "development") return "development";
  return "unknown";
}

/** Explicit opt-in only. Missing, false, 0, or an unknown value is disabled. */
export function isBrowserAssistantEnabled(): boolean {
  return ENABLED_VALUES.has((process.env.YSD_BROWSER_ASSISTANT_ENABLED ?? "").trim().toLowerCase());
}

export function browserAssistantDisabledResponse(): Response | null {
  if (isBrowserAssistantEnabled()) return null;
  return json({ error: "assistant_disabled", code: "assistant_disabled" }, 503);
}

/** QA hooks can run only in an explicitly non-Production execution identity. */
export function isBrowserQaEnvironment(): boolean {
  const environment = deploymentEnvironment();
  if (process.env.NODE_ENV === "test") return environment === "staging" || environment === "test";
  return environment === "staging"
    && (process.env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase() === "staging"
    && Boolean(process.env.RAILWAY_ENVIRONMENT_ID?.trim());
}
