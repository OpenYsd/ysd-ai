import "server-only";
import {
  BROWSER_CLIENT_ID,
  BROWSER_SCOPES,
  BROWSER_TOKEN_AUDIENCE,
  BROWSER_TOKEN_ISSUER,
  BROWSER_TOKEN_TTL_SECONDS,
  type BrowserScope,
} from "./schema";
import { base64url, browserTokenSecret, safeEqual, signHmac } from "./crypto";

export interface BrowserTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: BrowserScope[];
  iat: number;
  exp: number;
  jti: string;
}

export type TokenResult =
  | { ok: true; claims: BrowserTokenClaims }
  | { ok: false; reason: "unconfigured" | "malformed" | "bad_signature" | "expired" | "wrong_audience" };

export function createBrowserAccessToken(userId: string, jti: string) {
  const secret = browserTokenSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const claims: BrowserTokenClaims = {
    iss: BROWSER_TOKEN_ISSUER,
    aud: BROWSER_TOKEN_AUDIENCE,
    sub: userId,
    client_id: BROWSER_CLIENT_ID,
    scope: [...BROWSER_SCOPES],
    iat: now,
    exp: now + BROWSER_TOKEN_TTL_SECONDS,
    jti,
  };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = signHmac(`${header}.${payload}`, secret);
  return { accessToken: `${header}.${payload}.${signature}`, expiresIn: BROWSER_TOKEN_TTL_SECONDS };
}

export function verifyBrowserAccessToken(headerValue: string | null): TokenResult {
  const secret = browserTokenSecret();
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!headerValue?.startsWith("Bearer ")) return { ok: false, reason: "malformed" };
  const token = headerValue.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return { ok: false, reason: "malformed" };
  const expected = signHmac(`${header}.${payload}`, secret);
  if (!safeEqual(signature, expected)) return { ok: false, reason: "bad_signature" };

  let claims: BrowserTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== BROWSER_TOKEN_ISSUER || claims.client_id !== BROWSER_CLIENT_ID) {
    return { ok: false, reason: "wrong_audience" };
  }
  if (claims.aud !== BROWSER_TOKEN_AUDIENCE) return { ok: false, reason: "wrong_audience" };
  if (!claims.sub || !Array.isArray(claims.scope) || !claims.scope.includes("browser:chat")) {
    return { ok: false, reason: "wrong_audience" };
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
