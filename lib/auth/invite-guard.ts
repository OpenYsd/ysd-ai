import "server-only";
import {
  consumeKeyedRate,
  isRateSecretConfigured as isKeyedRateSecretConfigured,
  keyedRateKey,
  RATE_LIMIT_SECRET_MIN_LENGTH as KEYED_SECRET_MIN_LENGTH,
  _resetKeyedRateWarnings,
} from "@/lib/rate-limit-keyed";

/**
 * حدّ معدّل مسارات الدعوة — **موزّع في القاعدة، ومفاتيحه HMAC** (v0.8.1).
 *
 * ── ما تغيّر في المرحلة 6C ──
 *
 * التنفيذ انتقل إلى `lib/rate-limit-keyed`: نفس الدالّة الذرّية، ونفس
 * الجدول، ونفس اشتقاق المفتاح — لكن بلا اسمٍ يحصره في الدعوة.
 *
 * والسبب أن مسارًا عامًّا ثانيًا احتاج الحدّ نفسه (تفويض الجهاز)، وكان
 * البديل إمّا نسخةً ثانية من اشتقاق المفتاح — أي **مصدرين للسرّ** يفترقان
 * يوم يُدوَّر أحدهما — وإمّا حشرَ دلوٍ لا علاقة له بالدعوة في قائمتها.
 *
 * وهذا الملفّ يبقى صاحب **سياسة** الدعوة: دلاؤها وحدودها، لا آليّتها.
 *
 * ── وما لم يتغيّر ──
 *
 * الدلاء والحدود والأسماء المصدَّرة كما هي حرفًا. والاحتياط عند تعذُّر
 * القاعدة كما هو: حدٌّ أضعف مع رمزٍ صريح، لا انفتاحٌ ولا سقوطُ مسار.
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
export const RATE_LIMIT_SECRET_MIN_LENGTH = KEYED_SECRET_MIN_LENGTH;

/** هل المفتاح مضبوط وصالح؟ — للفحص الصحي، بلا كشف قيمة ولا طول */
export function isRateSecretConfigured(): boolean {
  return isKeyedRateSecretConfigured();
}

/**
 * مفتاح الحدّ: HMAC-SHA256 على `bucket:value` — لا قيمة خام تصل القاعدة.
 * إدراج الـbucket داخل الرسالة يمنع أن يشترك عنوانٌ وبريدٌ متطابقان نصًّا
 * في العدّاد نفسه.
 */
export function inviteRateKey(bucket: InviteBucket, value: string): string {
  return keyedRateKey(bucket, value);
}

export interface InviteRateDecision {
  allowed: boolean;
  backend: "distributed" | "memory_fallback";
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
  return consumeKeyedRate(bucket, value, limit, windowSeconds, "invite");
}

/** للاختبارات فقط */
export function _resetInviteRateWarnings(): void {
  _resetKeyedRateWarnings();
}
