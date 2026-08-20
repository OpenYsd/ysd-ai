import "server-only";
import { createHmac } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { rateLimit as memoryRateLimit } from "@/lib/rate-limit";

/**
 * حدّ معدّل موزّع **بمفتاح مُجزَّأ** — لا `user_id` (v0.9.14، المرحلة 6C).
 *
 * ── لماذا وحدة ثانية بجانب `rate-limit-distributed` ──
 *
 * تلك تُفهرس بـ`user_id uuid` ولها مفتاحٌ أجنبيّ إلى `auth.users`. فهي
 * للمصادَقين وحدهم، ولا سبيل لتمرير عنوانٍ أو أي بُعدٍ آخر إليها بلا تعديل
 * مخطّط.
 *
 * وهذه تستعمل `consume_invite_rate_limit` (ترحيل 0030) — وجدولُه يحفظ
 * `key_hash` نصًّا و`bucket` بقيدٍ **عامّ** (`^[a-z][a-z0-9_-]{2,31}$`) لا
 * يخصّ الدعوة. أي أن البنية الموزّعة للمسارات العامّة **قائمة سلفًا**، وما
 * كان ينقص اسمًا يقول ذلك.
 *
 * ── ولماذا HMAC لا هاشًا عاريًا ──
 *
 * عنوان IP منخفض العشوائية: مجال IPv4 كلّه أربعة مليارات. ومن يقرأ جدول
 * العدّادات يبني جدول قوس قزح فيكشف كل عنوان مرّ بالنظام في دقائق. ومفتاحٌ
 * سرّيّ لا يملكه قارئ الجدول يمنع ذلك عمليًّا.
 *
 * ولا تصل القيمة الخام القاعدةَ ولا السجلّ: تدخل HMAC هنا وتخرج ستّين حرفًا.
 */

/** الحدّ الأدنى: 32 بايتًا — أقلّ من ذلك لا يُعتدّ به مفتاح HMAC */
export const RATE_LIMIT_SECRET_MIN_LENGTH = 32;

/** رمزا «الدالّة/الجدول غير موجود» — يعنيان ترحيلًا لم يُطبَّق */
const UNDEFINED_FUNCTION = "42883";
const UNDEFINED_TABLE = "42P01";

let secretWarned = false;

/** هل المفتاح مضبوط وصالح؟ — للفحص الصحي، بلا كشف قيمة ولا طول */
export function isRateSecretConfigured(): boolean {
  const v = process.env.RATE_LIMIT_HMAC_SECRET;
  return typeof v === "string" && v.length >= RATE_LIMIT_SECRET_MIN_LENGTH;
}

/**
 * المفتاح السرّي لمفاتيح الحدّ.
 *
 * **مطلوب صراحةً ولا يُشتقّ من غيره.** خلطُ الأسرار يجعل تدوير أحدهما يكسر
 * الآخر صامتًا — كلُّ عدّادات الحدّ تصير مفاتيح جديدة دفعةً واحدة، فينفتح
 * الحدّ للجميع لحظةَ التدوير — وتسريبُ أحدهما يفضح الاثنين.
 *
 * **ولا احتياطي في الإنتاج**: غيابه هناك يرمي. حمايةٌ تعمل بمفتاح معلوم
 * ليست حماية، والصمت عنها أسوأ من تعطّل ظاهر يُصلَح في دقيقة.
 */
export function rateSecret(): string {
  const explicit = process.env.RATE_LIMIT_HMAC_SECRET;
  if (explicit && explicit.length >= RATE_LIMIT_SECRET_MIN_LENGTH) return explicit;

  if (process.env.NODE_ENV === "production") {
    // لا اسم قيمة ولا جزء منها — رسالة إعداد فقط
    throw new Error(
      "RATE_LIMIT_HMAC_SECRET مفقود أو أقصر من 32 بايتًا — مطلوب في الإنتاج",
    );
  }

  if (!secretWarned) {
    secretWarned = true;
    console.warn("[rate-limit] rate_key_secret=absent env=development protection=weak");
  }
  return "ysd-rate-limit-development-only-not-for-production";
}

/**
 * مفتاح الحدّ: HMAC-SHA256 على `bucket:value`.
 *
 * وإدراجُ الدلو داخل الرسالة يمنع أن يشترك عنوانٌ وبريدٌ متطابقان نصًّا في
 * العدّاد نفسه — ولولاه لَاستنفد أحدُهما حدّ الآخر.
 */
export function keyedRateKey(bucket: string, value: string): string {
  return createHmac("sha256", rateSecret())
    .update(`${bucket}:${value.trim().toLowerCase()}`)
    .digest("hex");
}

export type KeyedRateBackend = "distributed" | "memory_fallback";

export interface KeyedRateDecision {
  allowed: boolean;
  backend: KeyedRateBackend;
}

let fallbackWarned = false;
function warnFallback(scope: string, reason: string): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[${scope}] rate_limit_backend=memory_fallback reason=${reason}`);
}

/**
 * يستهلك محاولة واحدة ويُرجع القرار.
 *
 * لا يطبع القيمة الخام ولا الهاش في أي سجل. وتعذُّرُ القاعدة يعني حدًّا
 * أضعف مع رمزٍ صريح — لا انفتاحًا كاملًا ولا سقوط المسار.
 */
export async function consumeKeyedRate(
  bucket: string,
  value: string,
  limit: number,
  windowSeconds: number,
  scope = "rate-limit",
): Promise<KeyedRateDecision> {
  const keyHash = keyedRateKey(bucket, value);

  const admin = getAdminClient();
  if (!admin) {
    warnFallback(scope, "no_service_role");
    return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
  }

  try {
    const { data, error } = await admin.rpc("consume_invite_rate_limit", {
      p_key_hash: keyHash,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      warnFallback(
        scope,
        error.code === UNDEFINED_FUNCTION || error.code === UNDEFINED_TABLE
          ? "migration_missing"
          : "rpc_error",
      );
      return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object" || typeof (row as { allowed?: unknown }).allowed !== "boolean") {
      warnFallback(scope, "bad_shape");
      return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
    }
    return { allowed: (row as { allowed: boolean }).allowed, backend: "distributed" };
  } catch {
    warnFallback(scope, "exception");
    return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
  }
}

function memoryFallback(keyHash: string, limit: number, windowSeconds: number): boolean {
  return memoryRateLimit(keyHash, limit, windowSeconds * 1000);
}

/** للاختبارات فقط */
export function _resetKeyedRateWarnings(): void {
  fallbackWarned = false;
  secretWarned = false;
}
