/**
 * منع ازدواج الطلب (v0.6.6) — client_request_id لمرة واحدة.
 *
 * رُصد حيًّا: النقر مرتين على «إرسال» كان يحفظ الرسالة مرتين، لأن حارس
 * `generating` في الواجهة حالةُ React لا تُضبط إلا بعد إنشاء المحادثة — فالنقرة
 * الثانية تمرّ خلال ذلك الانتظار. القفل في الواجهة يغلق النافذة، وهذا الحارس
 * الخادمي يغلقها أيضًا لما لا تملكه الواجهة: إعادة الاتصال وإعادة إرسال الشبكة.
 *
 * التخزين في ذاكرة العملية (كما lib/rate-limit.ts وmodel-cooldown.ts): يكفي
 * لنافذة الازدواج القصيرة. لا يحمي من ازدواج عبر نسختَي خادم — وذلك يحتاج
 * قيدًا فريدًا في القاعدة (مؤجَّل: يتطلب migration).
 */

/** نافذة اعتبار الطلب مكررًا */
const TTL_MS = 2 * 60_000;
/** سقف احترازي لحجم الذاكرة */
const MAX_ENTRIES = 5_000;

interface Entry {
  at: number;
  /** معرّف رسالة المستخدم المحفوظة — يُعاد للطلب المكرر بدل حفظ صف ثانٍ */
  userMessageId: string | null;
}

const seen = new Map<string, Entry>();

function sweep(now: number): void {
  if (seen.size < MAX_ENTRIES) return;
  for (const [k, v] of seen) {
    if (now - v.at > TTL_MS) seen.delete(k);
  }
  // ما زال ممتلئًا (ضغط شديد) → أسقط الأقدم
  if (seen.size >= MAX_ENTRIES) {
    const oldest = [...seen.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 500);
    for (const [k] of oldest) seen.delete(k);
  }
}

/** المفتاح يشمل المستخدم فلا يتصادم معرّف عميل مع آخر */
function keyOf(userId: string, clientRequestId: string): string {
  return `${userId}:${clientRequestId}`;
}

/**
 * يسجّل الطلب ويقول هل هو **جديد**.
 * true = أول مرة (تابع التنفيذ) · false = مكرر (لا تحفظ رسالة ثانية).
 */
export function claimRequest(
  userId: string,
  clientRequestId: string | undefined,
  now = Date.now(),
): { isNew: boolean; previousUserMessageId: string | null } {
  if (!clientRequestId) return { isNew: true, previousUserMessageId: null };
  const key = keyOf(userId, clientRequestId);
  const prev = seen.get(key);
  if (prev && now - prev.at <= TTL_MS) {
    return { isNew: false, previousUserMessageId: prev.userMessageId };
  }
  sweep(now);
  seen.set(key, { at: now, userMessageId: null });
  return { isNew: true, previousUserMessageId: null };
}

/** يربط معرّف الرسالة المحفوظة بالطلب — ليعيده أي تكرار لاحق */
export function recordRequestMessage(
  userId: string,
  clientRequestId: string | undefined,
  userMessageId: string | null,
  now = Date.now(),
): void {
  if (!clientRequestId) return;
  seen.set(keyOf(userId, clientRequestId), { at: now, userMessageId });
}

/** للاختبارات فقط */
export function _resetIdempotency(): void {
  seen.clear();
}
