import "server-only";
import { getAdminClient } from "./supabase/admin";
import { rateLimit as memoryRateLimit } from "./rate-limit";

/**
 * حدّ المعدّل الموزّع (v0.7.0 RC2).
 *
 * lib/rate-limit.ts يبقى موجودًا لكنه صار **احتياطًا** لا مصدرًا: عدّاده في
 * ذاكرة العملية، فمع نسختين يصير الحدّ الفعلي ضعف المقصود ويُصفَّر عند كل
 * إعادة تشغيل. المصدر الآن دالة ذرّية في القاعدة يشترك فيها كل النسخ.
 *
 * لا يسقط المسار أبدًا: غياب مفتاح الخدمة أو تعذّر القاعدة يعني رجوعًا إلى
 * الذاكرة مع رمز صريح — ولا ندّعي حينها أن الحماية موزّعة.
 */

export type RateLimitBackend = "distributed" | "memory_fallback";

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ثانية Unix لإعادة الضبط — لترويسة X-RateLimit-Reset */
  resetAtSec: number;
  /** ثوانٍ حتى إعادة الضبط — لترويسة Retry-After */
  retryAfterSec: number;
  backend: RateLimitBackend;
}

/** أسماء الدلاء المسموحة — تطابق قيد القاعدة (^[a-z][a-z0-9_-]{2,31}$) */
export const BUCKET_CHAT = "chat";

/** رمز غياب الدالة — يعني أن migration 0019 لم تُطبَّق بعد */
const UNDEFINED_FUNCTION = "42883";
const UNDEFINED_TABLE = "42P01";

let fallbackLogged = false;

function logFallbackOnce(reason: string): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  // رمز فقط — لا مفاتيح ولا user_id ولا أي محتوى
  console.warn(`[rate-limit] rate_limit_backend=memory_fallback reason=${reason}`);
}

function memoryDecision(
  userId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): RateLimitDecision {
  const windowMs = windowSeconds * 1000;
  const allowed = memoryRateLimit(`${bucket}:${userId}`, limit, windowMs);
  const resetAtSec = Math.ceil((Math.floor(Date.now() / windowMs) * windowMs + windowMs) / 1000);
  return {
    allowed,
    limit,
    // الذاكرة لا تُرجع العدّاد؛ نكتفي بإشارة ثنائية صادقة
    remaining: allowed ? Math.max(0, limit - 1) : 0,
    resetAtSec,
    retryAfterSec: Math.max(1, resetAtSec - Math.floor(Date.now() / 1000)),
    backend: "memory_fallback",
  };
}

interface RpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/**
 * يستهلك طلبًا واحدًا من حدّ المستخدم ويُرجع القرار.
 * يُستدعى **مرة واحدة لكل طلب مقبول** — لا للطلب المكرر (idempotency) ولا
 * لفحوص الصحة ولا لصفحات الإدارة.
 */
export async function consumeRateLimit(
  userId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const admin = getAdminClient() as RpcClient | null;
  if (!admin) {
    logFallbackOnce("no_service_role");
    return memoryDecision(userId, bucket, limit, windowSeconds);
  }

  try {
    const { data, error } = await admin.rpc("consume_distributed_rate_limit", {
      p_user_id: userId,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      logFallbackOnce(
        error.code === UNDEFINED_FUNCTION || error.code === UNDEFINED_TABLE
          ? "migration_missing"
          : "rpc_error",
      );
      return memoryDecision(userId, bucket, limit, windowSeconds);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      logFallbackOnce("bad_shape");
      return memoryDecision(userId, bucket, limit, windowSeconds);
    }

    const r = row as {
      allowed: boolean;
      remaining: number;
      reset_at: string;
      current_count: number;
    };
    const resetAtSec = Math.ceil(new Date(r.reset_at).getTime() / 1000);
    return {
      allowed: Boolean(r.allowed),
      limit,
      remaining: Math.max(0, Number(r.remaining) || 0),
      resetAtSec,
      retryAfterSec: Math.max(1, resetAtSec - Math.floor(Date.now() / 1000)),
      backend: "distributed",
    };
  } catch {
    logFallbackOnce("exception");
    return memoryDecision(userId, bucket, limit, windowSeconds);
  }
}

/** ترويسات المعدّل الموحّدة — تُرسل في القبول والرفض معًا */
export function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(d.limit),
    "X-RateLimit-Remaining": String(d.remaining),
    "X-RateLimit-Reset": String(d.resetAtSec),
  };
}

/** للاختبارات فقط */
export function _resetFallbackLog(): void {
  fallbackLogged = false;
}
