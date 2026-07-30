import "server-only";

/**
 * حراسة الإجراءات الإدارية على المزوّدين (v0.8.0): حدّ معدّل + منع التزامن.
 *
 * زرّا «اختبار الاتصال» و«تحديث النماذج» يُصدران طلبًا خارجيًا لكل نقرة. بلا
 * حارس يصير النقر المتكرر مولّد طلبات نحو المزوّد — يستنزف حصّة المشغّل وقد
 * يُحدث تهدئة عنده. الحارسان مختلفان ولا يغني أحدهما عن الآخر: الحدّ يمنع
 * الكثرة عبر الزمن، ومنع التزامن يمنع طلبين متوازيين من نقرتين متتاليتين
 * قبل أن يعود الأول.
 *
 * في الذاكرة كما rate-limit.ts وmodel-cooldown.ts: نافذة قصيرة تكفي لزرّ
 * إداري، ولا تحتاج جدولًا ولا migration.
 */

/** نافذة الحدّ ونصيبها */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();
/** الإجراءات الجارية الآن — مفتاحها لا يشمل المستخدم: المورد هو المزوّد */
const inFlight = new Set<string>();

export function _resetProviderActions(): void {
  buckets.clear();
  inFlight.clear();
}

export interface ActionGate {
  allowed: boolean;
  reason?: "rate_limited" | "in_flight";
  retryAfterSec?: number;
}

/** يحجز فتحة لإجراء إداري — يجب استدعاء releaseProviderAction بعده */
export function consumeProviderAction(
  userId: string,
  action: "test" | "refresh",
  providerId: string,
  now = Date.now(),
): ActionGate {
  const resourceKey = `${action}:${providerId}`;
  if (inFlight.has(resourceKey)) {
    return { allowed: false, reason: "in_flight" };
  }
  const key = `${userId}:${resourceKey}`;
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    inFlight.add(resourceKey);
    return { allowed: true };
  }
  if (b.count >= MAX_PER_WINDOW) {
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  b.count++;
  inFlight.add(resourceKey);
  return { allowed: true };
}

export function releaseProviderAction(action: "test" | "refresh", providerId: string): void {
  inFlight.delete(`${action}:${providerId}`);
}

/** هل هناك إجراء جارٍ الآن على هذا المورد؟ (للاختبارات والعرض) */
export function isProviderActionInFlight(action: "test" | "refresh", providerId: string): boolean {
  return inFlight.has(`${action}:${providerId}`);
}
