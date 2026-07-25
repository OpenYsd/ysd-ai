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
