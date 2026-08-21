import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * تجميع `usage_events` — **دقيقٌ في القاعدة** (v0.9.18، المرحلة 6G).
 *
 * ── العطل الأصليّ (6C) ──
 *
 * كانت خمسة أسطحَ تحسب استهلاك الشهر بجلب الصفوف ثم جمعها في التطبيق.
 * و PostgREST يقصّ عند `max-rows` (ألفٌ على Supabase) **بلا خطأ وبلا إشارة**،
 * فمن تجاوز ألف حدثٍ يرى `1000` مهما بلغ. والرقم لا يبدو معطوبًا — يبدو رقمًا.
 *
 * ── وما فعلته 6C ──
 *
 * عدًّا خادميًّا دقيقًا (`count: exact, head: true`) للعدد، وترقيمًا محدودًا
 * للمجموع بسقفٍ **معلَن** (ثلاثون ألفًا) يظهر «+» عند تجاوزه. صدقٌ، لكنه
 * ليس رقمًا: صاحبُ `business` (١٠٠٬٠٠٠ شهريًّا) لا يرى مجموعه أبدًا.
 *
 * ── وما تفعله هذه المرحلة ──
 *
 * الجمعُ ينتقل إلى موضعه: `usage_totals_self` و`usage_totals_for` (الترحيل
 * 0047). رحلةٌ واحدة، ومجموعٌ دقيقٌ مهما بلغ العدد. أُثبت على PostgreSQL
 * حقيقي عند 0 و1 و999 و1000 و1001 و30٬000 و30٬001 و**100٬000**.
 *
 * ── والتفويض ليس هنا ──
 *
 * الدالّتان `security invoker`، فـRLS يعمل كما يعمل على أي استعلام. ومسارُ
 * المستخدم `usage_totals_self` لا يأخذ معرّفًا أصلًا: المتصفّح لا يملك أن
 * يُسمّي غيره ولو أراد.
 *
 * ── وحين تتعذّر الدالّة ──
 *
 * لا يُعرض مجموعٌ مقصوصٌ **كأنه دقيق** أبدًا. لكنه لا يُخفى أيضًا:
 *
 *   • غابت الدالّة (شيفرةٌ نُشرت قبل الترحيل) ⇒ مسحُ 6C المحدود، و`truncated`
 *     مرفوعة، فتكتب الواجهة «+» كما كانت. سلوكُ الأمس المُعلَن — لا كذبةٌ
 *     جديدة، ولا فقدانُ رقمٍ كان يراه صاحبه.
 *   • تعذّر المسح كذلك ⇒ `unavailable`، فتكتب الواجهة «—» ولا رقم.
 *
 * والعدد دقيقٌ في الحالتين: مسارُه مستقلٌّ لا يمرّ بالدالّة.
 */

/**
 * ★ ما بقي من المسح — ولماذا.
 *
 * تفصيلُ «لكل نموذج» يحتاج `model_id` لكل صفّ، ولا تُرجعه دالّةُ المجاميع.
 * وهو سطحٌ إداريٌّ وحده، فبقي مسحًا محدودًا — ويحمل **علمَ قصٍّ خاصًّا به**
 * لا يُخلط بعلم المجاميع. فالمجاميع دقيقةٌ دائمًا الآن، والتفصيل قد يُقصّ،
 * وقولُ ذلك في حقلين منفصلين أصدق من حقلٍ واحد يصف الاثنين.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 30;
const PARALLEL = 6;

export interface UsageAggregate {
  /** عدد الأحداث — دقيقٌ دائمًا */
  events: number;
  /** مجموع رموز الدخل والخرج — دقيقٌ دائمًا ما لم تُرفع `unavailable` */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * تعذّر الحصول على مجموعٍ موثوق بأي طريق.
   *
   * حين تُرفع: `tokens` بلا معنًى ولا يجوز عرضه رقمًا. والعدد يبقى دقيقًا.
   */
  unavailable: boolean;
  /**
   * ★ المجموع من المسح المحدود لا من القاعدة — فهو **حدٌّ أدنى**.
   *
   * يقع حين لا تكون دالّة 0047 مطبَّقة بعد. والواجهة تكتب «+» كما كانت في
   * 6C: أسوأُ ما يمكن هنا أن نعود إلى سلوكٍ **مُعلَن** سبق أن شُحن، لا أن
   * نعرض رقمًا مقصوصًا كأنه تامّ.
   *
   * وهذا ما يجعل نشرَ الشيفرة قبل الترحيل آمنًا: لا نافذةَ تعارضٍ يظهر فيها
   * «—» لمستخدمٍ كان يرى رقمًا.
   */
  truncated: boolean;
  /** تفصيلٌ لكل نموذج — يُملأ عند طلبه فقط */
  byModel: Map<string, { requests: number; tokens: number }>;
  /** ★ هل قُصّ **التفصيل** وحده؟ لا علاقة له بدقّة المجاميع أعلاه */
  modelsTruncated: boolean;
}

interface UsageRow {
  model_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

export interface UsageFilter {
  /** حصرُ النتيجة بمستخدم — يُترك فارغًا للمجاميع الإدارية عبر الجميع */
  userId?: string | null;
  /** بداية المدى (ISO) — شاملة */
  since?: string | null;
  /** نهاية المدى (ISO) — حصرية */
  until?: string | null;
}

/**
 * ★ شكلٌ محلّيٌّ صغير لباني الاستعلام — وتحويلٌ واحد عند الحدّ.
 *
 * تمريرُ باني Supabase المعمَّم عبر دالّةٍ معمَّمة يُفجّر المدقّق
 * (`TS2589`): سلسلةُ أنواعه تتضاعف مع كل حلقة. والشكلُ المحلّيّ يقطعها،
 * والتحويل يقع **هنا** لا في كل مستدعٍ.
 */
type Filterable = {
  eq: (column: string, value: unknown) => Filterable;
  gte: (column: string, value: string) => Filterable;
  lt: (column: string, value: string) => Filterable;
  order: (column: string, options: { ascending: boolean }) => Filterable;
  range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

function applyFilter(q: Filterable, f: UsageFilter): Filterable {
  let out = q;
  if (f.userId) out = out.eq("user_id", f.userId);
  if (f.since) out = out.gte("created_at", f.since);
  if (f.until) out = out.lt("created_at", f.until);
  return out;
}

/**
 * عددُ الأحداث — **دقيق**، بلا إعادة أي صفّ.
 *
 * `head: true` يجعل PostgREST يردّ الترويسة وحدها، فسقفُ الصفوف لا يمسّه.
 */
export async function countUsageEvents(
  db: SupabaseClient,
  filter: UsageFilter = {},
): Promise<number> {
  const base = db
    .from("usage_events")
    .select("id", { count: "exact", head: true }) as unknown as Filterable;
  const res = await (applyFilter(base, filter) as unknown as PromiseLike<{
    count?: number | null;
    error?: unknown;
  }>);
  if (res.error) return 0;
  return res.count ?? 0;
}

interface TotalsRow {
  event_count?: number | string | null;
  input_tokens?: number | string | null;
  output_tokens?: number | string | null;
  total_tokens?: number | string | null;
}

/**
 * ★ `bigint` يعبر السلك رقمًا — فيُفحص قبل أن يُصدَّق.
 *
 * PostgREST يُسلّم `bigint` عددًا في JSON، وما تجاوز `Number.MAX_SAFE_INTEGER`
 * يفقد دقّته صامتًا. وهو بعيدٌ عمليًّا (٩ آلاف تريليون رمز)، لكن «بعيد» ليس
 * «مستحيل» — والفحص أرخص من رقمٍ كاذبٍ لا يُكتشف.
 */
function safeInt(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * المجاميع الدقيقة عبر دالّة القاعدة.
 *
 * `userId` فارغًا في مسار المستخدم يعني «أنا»، فتُستدعى `usage_totals_self`
 * التي لا تقبل معرّفًا. وما عداه يمرّ بـ`usage_totals_for` — و RLS هو من
 * يحسم ما يُرى، لا هذا السطر.
 */
async function fetchExactTotals(
  db: SupabaseClient,
  filter: UsageFilter,
  scope: "self" | "any",
): Promise<{ ok: true; row: Required<Pick<UsageAggregate, "events" | "tokens" | "inputTokens" | "outputTokens">> } | { ok: false }> {
  const args =
    scope === "self"
      ? { p_since: filter.since ?? null, p_until: filter.until ?? null }
      : {
          p_user_id: filter.userId ?? null,
          p_since: filter.since ?? null,
          p_until: filter.until ?? null,
        };
  const fn = scope === "self" ? "usage_totals_self" : "usage_totals_for";

  const { data, error } = await db.rpc(fn, args);
  if (error) return { ok: false };

  const rows = (Array.isArray(data) ? data : data ? [data] : []) as TotalsRow[];
  const row = rows[0];
  if (!row) return { ok: false };

  const events = safeInt(row.event_count);
  const input = safeInt(row.input_tokens);
  const output = safeInt(row.output_tokens);
  const total = safeInt(row.total_tokens);
  if (events === null || input === null || output === null || total === null) {
    return { ok: false };
  }
  return { ok: true, row: { events, tokens: total, inputTokens: input, outputTokens: output } };
}

/**
 * العدد والمجاميع — دقيقة.
 *
 * `scope: "self"` لأسطح المستخدم: لا معرّف يُمرَّر أصلًا.
 * `withModels` يضيف مسحَ التفصيل الإداريّ (محدودًا ومُعلَنًا).
 */
export async function aggregateUsageEvents(
  db: SupabaseClient,
  filter: UsageFilter = {},
  options: { withModels?: boolean; scope?: "self" | "any" } = {},
): Promise<UsageAggregate> {
  const scope = options.scope ?? "any";
  const byModel = new Map<string, { requests: number; tokens: number }>();

  const totals = await fetchExactTotals(db, filter, scope);

  if (!totals.ok) {
    /**
     * ★ تراجعٌ **مُعلَن** لا رقمٌ مُخمَّن.
     *
     * الدالّة قد تغيب لحظةَ نُشرت الشيفرة قبل أن يُطبَّق الترحيل. والسقوطُ
     * حينها إلى «—» يجعل مستخدمًا كان يرى رقمًا يفقده بلا سبب يفهمه.
     *
     * فيُستعمل مسحُ 6C المحدود، ويُعلَن `truncated` فتكتب الواجهة «+» كما
     * كانت. أسوأُ حالٍ هنا هو سلوكُ الأمس المُعلَن — لا كذبةٌ جديدة.
     *
     * وإن تعذّر المسح كذلك، يُرفع `unavailable` ولا يُعرض رقم.
     */
    return await boundedScan(db, filter, options.withModels === true, byModel);
  }

  const base: UsageAggregate = {
    ...totals.row,
    unavailable: false,
    truncated: false,
    byModel,
    modelsTruncated: false,
  };

  if (!options.withModels || base.events === 0) return base;

  /* ── التفصيل الإداريّ: مسحٌ محدود، وعلمُ قصٍّ خاصٌّ به ── */
  const scanned = await scanRows(db, filter, base.events, byModel);
  base.modelsTruncated = scanned.truncated;
  return base;
}

/**
 * مسحُ الصفوف المحدود — يُستعمل للتفصيل، وللتراجع حين تغيب الدالّة.
 *
 * ويعيد المجموع والقصّ معًا كي يقرّر المستدعي ماذا يفعل بهما.
 */
async function scanRows(
  db: SupabaseClient,
  filter: UsageFilter,
  events: number,
  byModel: Map<string, { requests: number; tokens: number }>,
): Promise<{ tokens: number; inputTokens: number; outputTokens: number; truncated: boolean; failed: boolean }> {
  const neededPages = Math.ceil(events / PAGE_SIZE);
  const pages = Math.min(neededPages, MAX_PAGES);
  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;

  for (let start = 0; start < pages; start += PARALLEL) {
    const batch = [];
    for (let i = start; i < Math.min(start + PARALLEL, pages); i += 1) {
      /**
       * ترتيبٌ صريح على عمودين: `range()` بلا ترتيبٍ ثابت قد يُعيد صفًّا
       * مرّتين ويُسقط آخر — عطلٌ غير قابلٍ لإعادة الإنتاج.
       */
      const q = db.from("usage_events").select("model_id, input_tokens, output_tokens") as unknown as Filterable;
      batch.push(
        applyFilter(q, filter)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1),
      );
    }

    const results = await Promise.all(batch);
    for (const res of results) {
      if (res.error) {
        failed = true;
        continue;
      }
      for (const row of (res.data ?? []) as UsageRow[]) {
        const i = row.input_tokens ?? 0;
        const o = row.output_tokens ?? 0;
        inputTokens += i;
        outputTokens += o;
        tokens += i + o;
        const key = row.model_id ?? "unknown";
        const cur = byModel.get(key) ?? { requests: 0, tokens: 0 };
        cur.requests += 1;
        cur.tokens += i + o;
        byModel.set(key, cur);
      }
    }
  }

  return { tokens, inputTokens, outputTokens, truncated: neededPages > MAX_PAGES, failed };
}

/** التراجع المُعلَن — العدد دقيقٌ دائمًا، والمجموع حدٌّ أدنى يُقال */
async function boundedScan(
  db: SupabaseClient,
  filter: UsageFilter,
  _withModels: boolean,
  byModel: Map<string, { requests: number; tokens: number }>,
): Promise<UsageAggregate> {
  const events = await countUsageEvents(db, filter);
  if (events === 0) {
    return {
      events: 0, tokens: 0, inputTokens: 0, outputTokens: 0,
      unavailable: false, truncated: false, byModel, modelsTruncated: false,
    };
  }

  const scanned = await scanRows(db, filter, events, byModel);
  if (scanned.failed) {
    /** لم يُقرأ شيءٌ موثوق — ولا يُعرض رقم */
    return {
      events, tokens: 0, inputTokens: 0, outputTokens: 0,
      unavailable: true, truncated: false, byModel, modelsTruncated: false,
    };
  }

  return {
    events,
    tokens: scanned.tokens,
    inputTokens: scanned.inputTokens,
    outputTokens: scanned.outputTokens,
    unavailable: false,
    truncated: scanned.truncated,
    byModel,
    modelsTruncated: scanned.truncated,
  };
}

/** للاختبارات والتقارير — الثوابت مُعلَنة لا مخفيّة */
export const USAGE_SCAN = { PAGE_SIZE, MAX_PAGES, PARALLEL } as const;
/** أسماء دالّتي القاعدة — مصدرٌ واحد يمنع خطأً مطبعيًّا صامتًا */
export const USAGE_RPC = { self: "usage_totals_self", any: "usage_totals_for" } as const;
