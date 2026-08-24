import "server-only";
import { json } from "@/lib/browser/schema";

/**
 * Production pilot membership is an explicit server-side identity allowlist.
 *
 * Values are Supabase Auth user UUIDs stored only in Railway. They are never
 * accepted from Browser requests, copied into tokens as roles, or written to
 * logs. Missing, malformed, duplicated, or oversized configuration fails
 * closed so enabling the global feature flag cannot expose all users.
 */
export const BROWSER_PILOT_ALLOWLIST_VARIABLE = "YSD_BROWSER_PILOT_USER_IDS";
export const BROWSER_PILOT_MAX_USERS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pilotUsers(): ReadonlySet<string> | null {
  const raw = process.env[BROWSER_PILOT_ALLOWLIST_VARIABLE]?.trim();
  if (!raw) return null;

  const values = raw.split(",").map((value) => value.trim().toLowerCase());
  if (
    values.length === 0 ||
    values.length > BROWSER_PILOT_MAX_USERS ||
    values.some((value) => !UUID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    return null;
  }
  return new Set(values);
}

export function browserPilotAllowlistConfigured(): boolean {
  return pilotUsers() !== null;
}

export function browserPilotUserAllowed(userId: string): boolean {
  const users = pilotUsers();
  return users?.has(userId.trim().toLowerCase()) === true;
}

/** Blocks anonymous Device Auth setup when the server-side guard is absent. */
export function browserPilotInfrastructureResponse(): Response | null {
  if (browserPilotAllowlistConfigured()) return null;
  return json(
    { error: "pilot_unavailable", code: "pilot_allowlist_unconfigured" },
    503,
  );
}

/** Rechecked at authorization, token minting, and every chat request. */
export function browserPilotAccessResponse(userId: string): Response | null {
  if (!browserPilotAllowlistConfigured()) return browserPilotInfrastructureResponse();
  if (browserPilotUserAllowed(userId)) return null;
  return json({ error: "pilot_not_allowed", code: "pilot_not_allowed" }, 403);
}
