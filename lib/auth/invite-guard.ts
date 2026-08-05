import "server-only";
import { createHmac } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";
import { rateLimit as memoryRateLimit } from "@/lib/rate-limit";

/**
 * حدّ معدّل مسارات الدعوة — **موزّع في القاعدة، ومفاتيحه HMAC** (v0.8.1).
 *
 * ── لماذا موزّع ──
 *
 * `lib/rate-limit.ts` عدّاده في ذاكرة العملية: مع نسختين يصير الحدّ ضعف
 * المقصود، ومع إعادة تشغيل يُصفَّر. ومهاجمٌ يريد استنزاف دعوة لا يحتاج أكثر
 * من أن يصادف نسخة أخرى. المصدر الآن `consume_invite_rate_limit` — عدّاد
 * ذرّي واحد يشترك فيه كل الاتصالات وكل النسخ.
 *
 * والذاكرة تبقى **احتياطًا** لا مصدرًا: تعذُّر القاعدة يعني حدًّا أضعف مع
 * رمز صريح في السجل — لا انفتاحًا كاملًا ولا سقوط المسار.
 *
 * ── لماذا HMAC لا SHA-256 عاريًا ──
 *
 * عنوان IP والبريد **منخفضا العشوائية**: مجال IPv4 كله أربعة مليارات، وقائمة
 * بريد شائعة أصغر بكثير. من يقرأ جدول العدّادات يستطيع بناء جدول قوس قزح
 * ويكشف كل عنوان وكل بريد مرّ بالنظام في دقائق. HMAC بمفتاح خادمي لا يملكه
 * قارئ الجدول يجعل ذلك مستحيلًا عمليًا.
 *
 * (كود الدعوة عالي العشوائية ≈80 بت فلا يحتاج ذلك، لكنه يمرّ بالمسار نفسه
 * توحيدًا — ولأن قواعد التصنيف تتغيّر ولا نريد استثناءً يُنسى.)
 *
 * ── المفتاح السرّي ──
 *
 * `RATE_LIMIT_HMAC_SECRET` **مطلوب ومستقلّ** — 32 بايتًا على الأقل. لا يُشتقّ
 * من أي سرٍّ آخر، ولا احتياطي له في الإنتاج. التفصيل عند `rateSecret()`.
 */

const BUCKETS = {
  verifyIp: "inv-verify-ip",
  verifyCode: "inv-verify-code",
  claimIp: "inv-claim-ip",
  claimCode: "inv-claim-code",
  claimEmail: "inv-claim-email",
} as const;

export type InviteBucket = (typeof BUCKETS)[keyof typeof BUCKETS];
export const INVITE_BUCKETS = BUCKETS;

/** الحدود — نافذة بالثواني */
export const INVITE_LIMITS: Record<InviteBucket, { limit: number; windowSeconds: number }> = {
  [BUCKETS.verifyIp]: { limit: 10, windowSeconds: 60 },
  [BUCKETS.verifyCode]: { limit: 20, windowSeconds: 300 },
  [BUCKETS.claimIp]: { limit: 10, windowSeconds: 60 },
  [BUCKETS.claimCode]: { limit: 15, windowSeconds: 300 },
  [BUCKETS.claimEmail]: { limit: 8, windowSeconds: 300 },
};

/** الحدّ الأدنى: 32 بايتًا — أقلّ من ذلك لا يُعتدّ به مفتاح HMAC */
export const RATE_LIMIT_SECRET_MIN_LENGTH = 32;

let secretWarned = false;

/** هل المفتاح مضبوط وصالح؟ — للفحص الصحي، بلا كشف قيمة ولا طول */
export function isRateSecretConfigured(): boolean {
  const v = process.env.RATE_LIMIT_HMAC_SECRET;
  return typeof v === "string" && v.length >= RATE_LIMIT_SECRET_MIN_LENGTH;
}

/**
 * المفتاح السرّي لمفاتيح الحدّ.
 *
 * **مطلوب صراحةً ولا يُشتقّ من غيره.** كان يسقط إلى
 * `SUPABASE_SERVICE_ROLE_KEY` عند غيابه، وذلك خطأ من وجهين: خلط الأسرار
 * يجعل تدوير أحدهما يكسر الآخر صامتًا (كل عدّادات الحدّ تُصبح مفاتيح جديدة
 * دفعةً واحدة، فينفتح الحدّ للجميع لحظةَ التدوير)، وتسريب أحدهما يفضح
 * الاثنين.
 *
 * **ولا احتياطي في الإنتاج**: غيابه هناك يرمي. الحماية التي تعمل بمفتاح
 * معلوم ليست حماية، والصمت عنها أسوأ من تعطّل ظاهر يُصلَح في دقيقة.
 * وفي التطوير وحده يُستعمل ثابتٌ معلوم مع تحذير صريح.
 */
function rateSecret(): string {
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
    console.warn("[invite] rate_key_secret=absent env=development protection=weak");
  }
  return "ysd-rate-limit-development-only-not-for-production";
}

/**
 * مفتاح الحدّ: HMAC-SHA256 على `bucket:value` — لا قيمة خام تصل القاعدة.
 * إدراج الـbucket داخل الرسالة يمنع أن يشترك عنوانٌ وبريدٌ متطابقان نصًّا
 * في العدّاد نفسه.
 */
export function inviteRateKey(bucket: InviteBucket, value: string): string {
  return createHmac("sha256", rateSecret())
    .update(`${bucket}:${value.trim().toLowerCase()}`)
    .digest("hex");
}

export interface InviteRateDecision {
  allowed: boolean;
  backend: "distributed" | "memory_fallback";
}

let fallbackWarned = false;
function warnFallback(reason: string): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(`[invite] rate_limit_backend=memory_fallback reason=${reason}`);
}

/**
 * يستهلك محاولة واحدة من الحدّ ويُرجع القرار.
 * لا يطبع القيمة الخام ولا الهاش في أي سجل.
 */
export async function consumeInviteRate(
  bucket: InviteBucket,
  value: string,
): Promise<InviteRateDecision> {
  const { limit, windowSeconds } = INVITE_LIMITS[bucket];
  const keyHash = inviteRateKey(bucket, value);

  const admin = getAdminClient();
  if (!admin) {
    warnFallback("no_service_role");
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
      warnFallback(error.code === "42883" || error.code === "42P01" ? "migration_missing" : "rpc_error");
      return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object" || typeof (row as { allowed?: unknown }).allowed !== "boolean") {
      warnFallback("bad_shape");
      return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
    }
    return { allowed: (row as { allowed: boolean }).allowed, backend: "distributed" };
  } catch {
    warnFallback("exception");
    return { allowed: memoryFallback(keyHash, limit, windowSeconds), backend: "memory_fallback" };
  }
}

function memoryFallback(keyHash: string, limit: number, windowSeconds: number): boolean {
  return memoryRateLimit(keyHash, limit, windowSeconds * 1000);
}

/** للاختبارات فقط */
export function _resetInviteRateWarnings(): void {
  fallbackWarned = false;
  secretWarned = false;
}
