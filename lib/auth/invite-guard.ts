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
 * `YSD_RATE_LIMIT_SECRET` إن وُجد. وإلا فمشتقٌّ من `SUPABASE_SERVICE_ROLE_KEY`
 * — سرٌّ خادمي عالي العشوائية موجود أصلًا، فلا يفرض إعدادًا جديدًا. وغيابهما
 * معًا يعني بيئةً بلا أسرار (اختبار محلي)، فنستعمل ثابتًا معلومًا **مع رمز
 * تحذير**: الحماية حينها شكلية، ولا ندّعي غير ذلك.
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

let secretWarned = false;

function rateSecret(): string {
  const explicit = process.env.YSD_RATE_LIMIT_SECRET;
  if (explicit && explicit.length >= 16) return explicit;

  const derived = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (derived && derived.length >= 20) return `ysd-rate:${derived}`;

  if (!secretWarned) {
    secretWarned = true;
    // رمز فقط — لا قيمة ولا اسم متغيّر سرّي
    console.warn("[invite] rate_key_secret=absent protection=weak");
  }
  return "ysd-rate-limit-development-only";
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
