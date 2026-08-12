/**
 * سجلّات منظّمة — لا نصوص مستخدمين ولا ملفات ولا مقاطع ولا مفاتيح.
 * كل سطر JSON بحقل correlation_id (correlation) لربط الطلبات والوظائف.
 */

import { redactLogValue } from "@/lib/log-redaction";

type LogLevel = "info" | "warn" | "error";

/** حقول مسموحة فقط — منع تسريب محتوى حساس */
export interface LogFields {
  correlation?: string;
  event: string;
  status?: string | number;
  ms?: number;
  count?: number;
  size?: number;
  rss?: number;
  code?: string;
  /** معرّف مختصر/hash — لا معرّفات كاملة حساسة */
  ref?: string;
}

function emit(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify(redactLogValue({ level, ts: new Date().toISOString(), ...fields }));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (f: LogFields) => emit("info", f),
  warn: (f: LogFields) => emit("warn", f),
  error: (f: LogFields) => emit("error", f),
};

/** correlation_id جديد للطلب أو العملية */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}
