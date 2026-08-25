const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|token|secret|password|credential|api[_-]?key|service[_-]?role|access[_-]?key|refresh[_-]?key|headers?)/i;
const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /sk-or-[A-Za-z0-9_-]{12,}/gi,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]*)?/g,
  /sb_[A-Za-z0-9_-]{20,}/g,
  // Stable account identifiers are not operational log dimensions. Supabase's
  // privileged Auth audit log is the only place where platform-required user
  // metadata may appear; application/Railway logs must remain identity-free.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
];

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MaxDepth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message).slice(0, 160),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactLogValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactLogValue(item, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

export function sanitizedErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const code = record.code ?? record.name;
  return typeof code === "string"
    && /^[A-Za-z0-9_-]{1,64}$/.test(code)
    && redactString(code) === code
    ? code
    : "error";
}
