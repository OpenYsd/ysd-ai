/**
 * Shared by build-image.mjs and run-acceptance.mjs.
 *
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are read STATICALLY by lib/supabase/server.ts, so Next inlines
 * the values that exist at BUILD time (see the header of the Dockerfile). The acceptance image therefore has to be built
 * with the very URL and anon key the run will use — which is why both scripts derive them from one throwaway secret file
 * kept OUTSIDE the repository (`--secret-file`). The secret protects nothing real: it only signs tokens for a local
 * PostgREST in front of a disposable database.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export const GW_PORT = 54321;
export const SUPABASE_URL = `http://host.docker.internal:${GW_PORT}`;

export function loadSecret(file) {
  if (!file) throw new Error("--secret-file <path> is required (a file holding a random hex string; keep it outside the repo)");
  const s = readFileSync(file, "utf8").trim();
  if (s.length < 32) throw new Error("secret file must hold at least 32 characters");
  return s;
}

const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
export function mintJwt(secret, claims, ttlSec = 30 * 86400) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "HS256", typ: "JWT" });
  const p = b64u({ iat: now, exp: now + ttlSec, ...claims });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
/** The anon key is baked into the image, so it must stay valid for as long as the image is used: fixed iat/exp window. */
export function anonKey(secret) {
  const h = b64u({ alg: "HS256", typ: "JWT" });
  const p = b64u({ role: "anon", iss: "acceptance", iat: 1_700_000_000, exp: 4_102_444_800 });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
