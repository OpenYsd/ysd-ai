import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * تجميع `usage_events` — **بلا سقفِ صفوفٍ صامت** (v0.9.14، المرحلة 6C).
 *
 * ── العطل ──
 *
 * كانت خمسة أسطحَ تحسب استهلاك الشهر هكذا:
 *
 *     const rows = await db.from("usage_events").select("input_tokens, …");
 *     const messages = rows.length;
 *     const tokens   = rows.reduce(…);
 *
 * و PostgREST يقصّ الاستجابة عند `max-rows` (ألفٌ على Supabase) **بلا خطأ
 * وبلا إشارة**. فمن تجاوز ألف حدثٍ في الشهر يرى `1000` مهما بلغ، ومجموعَ
 * رموزٍ يخصّ أوّل ألفٍ فقط. والرقم لا يبدو معطوبًا — يبدو رقمًا.
 *
 * وأخطرُ ما فيه أنه يظهر **عند المستخدم الأكثر استعمالًا وحده**: صاحب
 * الباقة المجانية (٢٠٠ شهريًّا) لا يبلغه أبدًا، فيمرّ العيب في كل اختبارٍ
 * يدويّ.
 *
 * ── العلاج ──
 *
 * (أ) **العدد** يُقرأ عدًّا خادميًّا دقيقًا: `count: "exact", head: true`.
 *     لا صفوف تعود أصلًا، فلا سقف يقصّها. رحلةٌ واحدة مهما بلغ العدد.
 *
 * (ب) **المجموع** يحتاج القيم، فيُقرأ بترقيمٍ **محدود ومحدَّد**: نعرف العدد
 *     من (أ)، فنحسب عدد الصفحات ونطلبها **متوازيةً** بدل تسلسلٍ يضاعف
 *     زمن الصفحة.
 *
 * ── ولماذا ترتيبٌ صريح ──
 *
 * `range()` بلا `order` ليس مضمون الثبات: قد يُعيد المخطِّط الصفَّ نفسه في
 * صفحتين ويُسقط آخر. فالترتيب `(created_at, id)` يجعل النوافذ متقاطعةً
 * تمامًا لا متداخلة — و`id` فاصلٌ نهائيّ حين يتساوى الوقت.
 *
 * ── وحدٌّ أعلى يُعلَن ولا يُخفى ──
 *
 * المسحُ مقيَّد بـ`MAX_PAGES`. وما تجاوزه يُعلَن `truncated: true` فتقول
 * الواجهة «+» — لأن رقمًا ناقصًا يُعرض كأنه تامّ هو العيب الذي نُصلحه، ولا
 * يجوز أن نعيد إنتاجه بحدٍّ آخر صامت.
 */

/** سقف PostgREST على Supabase — حجم الصفحة الواحدة */
const PAGE_SIZE = 1000;

/**
 * أقصى ما يُمسح: ٣٠ صفحة = ٣٠٬٠٠٠ حدث.
 *
 * يغطّي `free` (٢٠٠) و`plus` (٢٠٠٠) و`pro` (١٠٬٠٠٠) بهامش. و`business`
 * (١٠٠٬٠٠٠) يتجاوزه فيُعلَن مقصوصًا — والحلّ الصحيح له دالّة تجميعٍ في
 * القاعدة، وهي تحتاج ترحيلًا فتُؤجَّل بقرار.
 */
const MAX_PAGES = 30;

/** كم صفحةً تُطلب معًا — توازٍ يقصّر الزمن بلا أن يُغرق التجمّع */
const PARALLEL = 6;

export interface UsageAggregate {
  /** عدد الأحداث — **دقيقٌ دائمًا** مهما بلغ */
  events: number;
  /** مجموع رموز الدخل والخرج ضمن ما مُسح */
  tokens: number;
  /** هل تجاوز العدد سقف المسح فبقي المجموع ناقصًا؟ */
  truncated: boolean;
  /** تفصيلٌ لكل نموذج — يُملأ عند طلبه فقط */
  byModel: Map<string, { requests: number; tokens: number }>;
}

interface UsageRow {
  model_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

/**
 * ★ نوعُ العميل هو نوعُ Supabase نفسه.
 *
 * جرّبتُ واجهةً بنيوية دنيا أوّلًا فلم تنطبق: باني الاستعلام في المكتبة
 * سلسلةُ أنواعٍ معمَّمة، ومطابقتُها بنيويًّا تفشل أو تُجبر على `any`. وحملُ
 * كل مستدعٍ على تحويلٍ صريح ضجيجٌ في شيفرة الإنتاج.
 *
 * فالإنتاج يمرّر عميله كما هو، والاختبار وحده يحوّل قاعدته الوهمية — وهو
 * الموضع الذي يجوز فيه ذلك.
 */

export interface UsageFilter {
  /** حصرُ النتيجة بمستخدم — يُترك فارغًا للمجاميع الإدارية عبر الجميع */
  userId?: string | null;
  /** بداية المدى (ISO) — يُترك فارغًا للمدى الكامل */
  since?: string | null;
  /** نهاية المدى (ISO)، حصريّة */
  until?: string | null;
}

/**
 * ★ شكلٌ محلّيٌّ صغير لباني الاستعلام — وتحويلٌ واحد عند الحدّ.
 *
 * تمريرُ باني Supabase المعمَّم عبر دالّةٍ معمَّمة يُفجّر المدقّق
 * (`TS2589: type instantiation is excessively deep`): سلسلةُ أنواعه تتضاعف
 * مع كل حلقة. والشكلُ المحلّيّ يقطع تلك السلسلة، والتحويل يقع **هنا**
 * مرّتين لا في كل مستدعٍ.
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
  const res = (await (applyFilter(base, filter) as unknown as PromiseLike<{
    count?: number | null;
    error?: unknown;
  }>));
  if (res.error) return 0;
  return res.count ?? 0;
}

/**
 * العدد والمجموع معًا.
 *
 * `withModels` يضيف `model_id` إلى الأعمدة — لا يُطلب في مسار المستخدم لأنه
 * لا يعرضه، وكلُّ عمودٍ زائد بايتاتٌ على كل صفّ.
 */
export async function aggregateUsageEvents(
  db: SupabaseClient,
  filter: UsageFilter = {},
  options: { withModels?: boolean } = {},
): Promise<UsageAggregate> {
  const events = await countUsageEvents(db, filter);
  const byModel = new Map<string, { requests: number; tokens: number }>();

  if (events === 0) {
    return { events: 0, tokens: 0, truncated: false, byModel };
  }

  const neededPages = Math.ceil(events / PAGE_SIZE);
  const pages = Math.min(neededPages, MAX_PAGES);
  const truncated = neededPages > MAX_PAGES;
  const columns = options.withModels
    ? "model_id, input_tokens, output_tokens"
    : "input_tokens, output_tokens";

  let tokens = 0;

  for (let start = 0; start < pages; start += PARALLEL) {
    const batch = [];
    for (let i = start; i < Math.min(start + PARALLEL, pages); i += 1) {
      /**
       * ★ ترتيبٌ صريح على عمودين.
       *
       * `range()` بلا ترتيبٍ ثابت قد يُعيد صفًّا مرّتين ويُسقط آخر — وهو
       * عطلٌ أسوأ من الأوّل لأنه غير قابل لإعادة الإنتاج.
       */
      const base = db.from("usage_events").select(columns) as unknown as Filterable;
      const q = applyFilter(base, filter)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1);
      batch.push(q);
    }

    const results = await Promise.all(batch);
    for (const res of results) {
      if (res.error) continue;
      for (const row of (res.data ?? []) as UsageRow[]) {
        const t = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
        tokens += t;
        if (options.withModels) {
          const key = row.model_id ?? "unknown";
          const cur = byModel.get(key) ?? { requests: 0, tokens: 0 };
          cur.requests += 1;
          cur.tokens += t;
          byModel.set(key, cur);
        }
      }
    }
  }

  return { events, tokens, truncated, byModel };
}

/** للاختبارات والتقارير — الثوابت مُعلَنة لا مخفيّة */
export const USAGE_SCAN = { PAGE_SIZE, MAX_PAGES, PARALLEL } as const;
