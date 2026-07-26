/**
 * مقاييس تشغيلية للوحة المراقبة (v0.6.6) — أرقام فقط، بلا أي محتوى.
 *
 * **لا يُسجَّل هنا**: نص المحادثة، ولا نص السؤال، ولا معرّف المستخدم، ولا أي
 * بيانات شخصية. المخزَّن: أزمنة، ورموز أخطاء، وعدّادات — لا غير.
 *
 * التخزين حلقة في ذاكرة العملية (كما lib/rate-limit.ts وmodel-cooldown.ts):
 * يكفي لنافذة مراقبة قصيرة بلا أي migration. القيد المعروف: تُفقد عند إعادة
 * تشغيل الحاوية، ولكل نسخة خادم حلقتها. التخزين الدائم يحتاج جدولًا في
 * القاعدة — مؤجَّل عمدًا خارج نطاق هذا الإصدار.
 */

/** سعة الحلقة — آخر N ردّ */
const CAPACITY = 500;
/** نافذة العرض الافتراضية */
export const WINDOW_MS = 60 * 60_000;

export interface ChatMetric {
  at: number;
  /** زمن أول نص ظاهر للمستخدم (ms) — أهم رقم في تجربة الانتظار */
  firstTextMs: number;
  totalMs: number;
  /** رمز الخطأ إن فشل الرد، وإلا null */
  errorCode: string | null;
  fallbackCount: number;
  providerCalls: number;
  mode: "general" | "protected";
  shortCircuit: boolean;
}

const ring: ChatMetric[] = [];

/** يسجّل ردًا واحدًا — يُستدعى من مسار المحادثة بعد اكتمال الرد */
export function recordChatMetric(m: ChatMetric): void {
  ring.push(m);
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
}

/** انتهاء جلسة مفاجئ (تعذّر تجديد التوكن) — عدّاد فقط بلا هوية */
const abruptSessionEnds: number[] = [];
export function recordAbruptSessionEnd(at = Date.now()): void {
  abruptSessionEnds.push(at);
  if (abruptSessionEnds.length > CAPACITY) {
    abruptSessionEnds.splice(0, abruptSessionEnds.length - CAPACITY);
  }
}

export interface HealthSummary {
  total: number;
  errorCount: number;
  errorRate: number;
  avgFirstTextMs: number | null;
  p95FirstTextMs: number | null;
  avgTotalMs: number | null;
  topErrors: { code: string; count: number }[];
  fallbackTotal: number;
  fallbackResponses: number;
  shortCircuits: number;
  protectedCount: number;
  abruptSessionEnds: number;
  windowMs: number;
  /** المقاييس في الذاكرة فقط — تُفقد عند إعادة التشغيل */
  volatile: true;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

/** ملخّص النافذة الأخيرة — كل الأرقام مشتقة، بلا أي نص */
export function summarize(windowMs = WINDOW_MS, now = Date.now()): HealthSummary {
  const since = now - windowMs;
  const rows = ring.filter((r) => r.at >= since);
  const ok = rows.filter((r) => !r.errorCode);
  const firstTexts = ok
    .map((r) => r.firstTextMs)
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
  const totals = rows.map((r) => r.totalMs).filter((n) => n >= 0);

  const errCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.errorCode) continue;
    errCounts.set(r.errorCode, (errCounts.get(r.errorCode) ?? 0) + 1);
  }
  const errorCount = rows.length - ok.length;

  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  return {
    total: rows.length,
    errorCount,
    errorRate: rows.length ? Math.round((errorCount / rows.length) * 1000) / 10 : 0,
    avgFirstTextMs: avg(firstTexts),
    p95FirstTextMs: percentile(firstTexts, 95),
    avgTotalMs: avg(totals),
    topErrors: [...errCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    fallbackTotal: rows.reduce((s, r) => s + r.fallbackCount, 0),
    fallbackResponses: rows.filter((r) => r.fallbackCount > 0).length,
    shortCircuits: rows.filter((r) => r.shortCircuit).length,
    protectedCount: rows.filter((r) => r.mode === "protected").length,
    abruptSessionEnds: abruptSessionEnds.filter((t) => t >= since).length,
    windowMs,
    volatile: true,
  };
}

/** للاختبارات فقط */
export function _resetMetrics(): void {
  ring.length = 0;
  abruptSessionEnds.length = 0;
}

// ── التخزين الدائم (v0.6.6 RC2) ───────────────────────────────────────────
// الحلقة أعلاه صارت cache سريعًا. المصدر الدائم جدول observability_events،
// فتنجو إحصاءات آخر 60 دقيقة من إعادة تشغيل الحاوية وتُجمَّع عبر النسخ.
// الأعمدة كلها أزمنة وعدّادات ورموز — بلا أي نص أو بيانات شخصية.

const UNDEFINED_TABLE = "42P01";

export interface DurableEvent {
  mode: "general" | "protected";
  errorCode: string | null;
  sessionRefreshResult: "refreshed" | "failed" | "not_needed" | null;
  authMs: number;
  conversationLookupMs: number;
  userMessageInsertMs: number;
  ragMs: number;
  providerFirstByteMs: number;
  totalFirstTextMs: number;
  totalResponseMs: number;
  providerCalls: number;
  fallbackCount: number;
  protectedShortCircuit: boolean;
}

interface InsertClient {
  from: (t: string) => {
    insert: (row: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;
  };
}

/** يكتب الحدث في القاعدة — لا يرمي ولا يُبطئ الرد (fire-and-forget عند الاستدعاء) */
export async function persistEvent(supabase: InsertClient, e: DurableEvent): Promise<void> {
  try {
    const { error } = await supabase.from("observability_events").insert({
      mode: e.mode,
      error_code: e.errorCode,
      session_refresh_result: e.sessionRefreshResult,
      auth_ms: e.authMs,
      conversation_lookup_ms: e.conversationLookupMs,
      user_message_insert_ms: e.userMessageInsertMs,
      rag_ms: e.ragMs,
      provider_first_byte_ms: e.providerFirstByteMs,
      total_first_text_ms: e.totalFirstTextMs,
      total_response_ms: e.totalResponseMs,
      provider_calls: e.providerCalls,
      fallback_count: e.fallbackCount,
      protected_short_circuit: e.protectedShortCircuit,
    });
    if (error && error.code !== UNDEFINED_TABLE) {
      console.error(`[observability] insert failed code=${error.code ?? "?"}`);
    }
  } catch {
    /* المقاييس لا تُفشل ردًا ناجحًا أبدًا */
  }
}

interface SelectClient {
  from: (t: string) => {
    select: (cols: string) => {
      gte: (c: string, v: string) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
}

/**
 * ملخّص من القاعدة (دائم). يُرجع null إن غاب الجدول أو تعذّرت القراءة،
 * فتقع اللوحة على ملخّص الذاكرة بدل أن تنكسر.
 */
export async function summarizeDurable(
  supabase: SelectClient,
  windowMs = WINDOW_MS,
  now = Date.now(),
): Promise<HealthSummary | null> {
  try {
    const since = new Date(now - windowMs).toISOString();
    const { data, error } = await supabase
      .from("observability_events")
      .select(
        "created_at, mode, error_code, total_first_text_ms, total_response_ms, fallback_count, protected_short_circuit",
      )
      .gte("created_at", since);
    if (error || !data) return null;

    const rows = data as {
      mode: string;
      error_code: string | null;
      total_first_text_ms: number;
      total_response_ms: number;
      fallback_count: number;
      protected_short_circuit: boolean;
    }[];

    const ok = rows.filter((r) => !r.error_code);
    const firstTexts = ok
      .map((r) => r.total_first_text_ms)
      .filter((n) => n >= 0)
      .sort((a, b) => a - b);
    const totals = rows.map((r) => r.total_response_ms).filter((n) => n >= 0);
    const errCounts = new Map<string, number>();
    for (const r of rows) {
      if (!r.error_code) continue;
      errCounts.set(r.error_code, (errCounts.get(r.error_code) ?? 0) + 1);
    }
    const errorCount = rows.length - ok.length;
    const avg = (arr: number[]) =>
      arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

    return {
      total: rows.length,
      errorCount,
      errorRate: rows.length ? Math.round((errorCount / rows.length) * 1000) / 10 : 0,
      avgFirstTextMs: avg(firstTexts),
      p95FirstTextMs: percentile(firstTexts, 95),
      avgTotalMs: avg(totals),
      topErrors: [...errCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      fallbackTotal: rows.reduce((s, r) => s + r.fallback_count, 0),
      fallbackResponses: rows.filter((r) => r.fallback_count > 0).length,
      shortCircuits: rows.filter((r) => r.protected_short_circuit).length,
      protectedCount: rows.filter((r) => r.mode === "protected").length,
      abruptSessionEnds: abruptSessionEnds.filter((t) => t >= now - windowMs).length,
      windowMs,
      volatile: true,
    };
  } catch {
    return null;
  }
}
