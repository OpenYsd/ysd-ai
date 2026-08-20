import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { publicOrigin } from "@/lib/http/origin";

export function base64url(input: Buffer | Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function sha256Base64Url(input: string): string {
  return base64url(createHash("sha256").update(input, "ascii").digest());
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function randomCode(bytes = 48): string {
  return base64url(randomBytes(bytes));
}

export function userCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function signHmac(value: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(value).digest());
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function browserTokenSecret(): string | null {
  const value = process.env.YSD_BROWSER_TOKEN_SECRET;
  return value && value.length >= 32 ? value : null;
}

/**
 * أصلُ التطبيق — يُفوَّض إلى `lib/http/origin` (المرحلة 6B).
 *
 * كان محسوبًا هنا بنفس السلسلة حرفًا بحرف، وصار للأصل مستعملٌ ثانٍ
 * (البيانات الوصفية وخريطة الموقع). وحسابان متطابقان اليوم يفترقان يوم
 * يُعدَّل أحدهما — ويبقى الآخر يبني روابط إلى نطاقٍ قديم بلا أن يُنبّه أحد.
 */
export function appOrigin(): string {
  return publicOrigin();
}
