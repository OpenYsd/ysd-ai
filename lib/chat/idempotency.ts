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

// ── الحماية الدائمة عبر القاعدة (v0.6.6 RC2) ──────────────────────────────
// ذاكرة العملية أعلاه صارت **cache** فقط. المصدر الموثوق حجز ذرّي على قيد
// unique(user_id, client_request_id): محاولة ثانية تفشل بـ23505 مهما كانت
// النسخة التي استقبلتها. وإن غاب الجدول (migration لم تُطبَّق بعد) نسقط إلى
// الذاكرة بدل أن ينكسر المسار.

/** رمز خطأ Postgres لانتهاك القيد الفريد */
const UNIQUE_VIOLATION = "23505";
/** رمز غياب الجدول — يعني أن الـmigration لم تُطبَّق */
const UNDEFINED_TABLE = "42P01";

export type ClaimOutcome =
  | { ok: true; storage: "db" | "memory" }
  | { ok: false; duplicate: true; previousUserMessageId: string | null }
  | { ok: false; duplicate: false; reason: string };

interface MinimalClient {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => {
      select: (cols: string) => {
        single: () => Promise<{ data: unknown; error: { code?: string } | null }>;
      };
    };
    select: (cols: string) => {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => Promise<{ error: unknown }>;
      };
    };
  };
}

/**
 * حجز ذرّي للطلب. يُستدعى **قبل** حفظ رسالة المستخدم.
 * التكرار يُكتشف من انتهاك القيد الفريد لا من قراءة مسبقة — فلا سباق.
 */
export async function claimRequestDurable(
  supabase: MinimalClient,
  userId: string,
  clientRequestId: string | undefined,
  conversationId: string | null,
  requireDurable = false,
): Promise<ClaimOutcome> {
  if (!clientRequestId) return { ok: true, storage: "memory" };

  // فحص الذاكرة أولًا: يوفّر رحلة قاعدة في الحالة الشائعة (نفس النسخة)
  const local = claimRequest(userId, clientRequestId);
  if (!local.isNew) {
    return { ok: false, duplicate: true, previousUserMessageId: local.previousUserMessageId };
  }

  const { error } = await supabase
    .from("chat_request_ids")
    .insert({
      user_id: userId,
      client_request_id: clientRequestId,
      conversation_id: conversationId,
      status: "in_progress",
    })
    .select("id")
    .single();

  if (!error) return { ok: true, storage: "db" };

  if (error.code === UNIQUE_VIOLATION) {
    // نسخة أخرى (أو طلب أسبق) حجزته — اقرأ معرّف الرسالة إن كُتب
    const { data } = await supabase
      .from("chat_request_ids")
      .select("user_message_id")
      .eq("user_id", userId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    const prev = (data as { user_message_id?: string | null } | null)?.user_message_id ?? null;
    return { ok: false, duplicate: true, previousUserMessageId: prev };
  }

  if (error.code === UNDEFINED_TABLE) {
    if (requireDurable) {
      return { ok: false, duplicate: false, reason: "idempotency_table_unavailable" };
    }
    // الـmigration لم تُطبَّق — الذاكرة وحدها (حماية داخل النسخة فقط)
    console.error("[idempotency] chat_request_ids missing — falling back to memory");
    return { ok: true, storage: "memory" };
  }

  if (requireDurable) {
    return { ok: false, duplicate: false, reason: `idempotency_claim_failed_${error.code ?? "unknown"}` };
  }

  // عطل قاعدة آخر: لا نمنع المستخدم من الإرسال بسببه
  console.error(`[idempotency] claim failed code=${error.code ?? "?"} — memory only`);
  return { ok: true, storage: "memory" };
}

/** يحدّث الحجز بعد حفظ الرسالة أو عند الفشل — لا يرمي أبدًا */
export async function finalizeRequest(
  supabase: MinimalClient,
  userId: string,
  clientRequestId: string | undefined,
  status: "completed" | "failed",
  userMessageId: string | null,
): Promise<void> {
  if (!clientRequestId) return;
  recordRequestMessage(userId, clientRequestId, userMessageId);
  try {
    await supabase
      .from("chat_request_ids")
      .update({ status, ...(userMessageId ? { user_message_id: userMessageId } : {}) })
      .eq("user_id", userId)
      .eq("client_request_id", clientRequestId);
  } catch {
    /* التحديث تحسين لا شرط — الحجز نفسه هو الحماية */
  }
}
