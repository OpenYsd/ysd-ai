import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * تشخيصُ ثوابت التدريب — **قراءةٌ فقط، وبلا إصلاح** (v0.9.18، المرحلة 6G).
 *
 * ── ما هذا وما ليس ──
 *
 * ليس عمليةً خلفية، ولا مهمّةً دورية، ولا شيئًا يعمل من تلقاء نفسه. هو
 * استعلاماتُ عدٍّ تُستدعى من لوحة الإدارة حين يفتحها إنسان — لا أكثر.
 *
 * وليس مُصلِحًا. يعدّ ويُبلّغ ويسكت. فحالةٌ مستحيلة تعني أن شيئًا كُسر في
 * موضعٍ لا نعرفه بعد، وإصلاحُها تلقائيًّا يمحو الدليل ويُخفي السبب — ثم
 * يقع العطل ثانيةً بلا أثر.
 *
 * ── ولماذا هذان الثابتان بالذات ──
 *
 * كلاهما يصف قرارًا اتّخذه صاحبُه ولا يجوز أن يُنقض:
 *
 *   • مرشّحٌ سُحب لا يصير `approved` — سحبُ الإذن ليس حالةً مؤقّتة.
 *   • ومعتمَدٌ بلا بوّابةِ خصوصيةٍ مجتازة — القيد يمنعه في القاعدة، وهذا
 *     يكشف ما لو التفّ أحدٌ حوله من مسارٍ آخر.
 *
 * ── وما لا يُقاس لا يُدّعى ──
 *
 * «أثرٌ مُمحيّ عاد صالحًا» ثابتٌ نريده، لكن لا سبيل إلى قياسه هنا: الجدول
 * يحمل الحالة الراهنة لا تاريخَها، فأثرٌ `ready` قد يكون جديدًا مشروعًا.
 * وحارسٌ يعدّ الحالة الراهنة كأنها كسرٌ يُطلق إنذارًا كاذبًا في أوّل بناءٍ
 * سليم — ثم يُتجاهَل حين يصدق. فتُرك حتى يوجد سجلُّ انتقالاتٍ يُقاس عليه.
 *
 * ── وخارج `lib/training/**` عمدًا ──
 *
 * التدريب مجمَّد. وهذا الملفّ لا يمسّ قاعدةً ولا يغيّر سياسة — فبقي خارج
 * الشجرة المجمَّدة كي لا يُقرأ يومًا كأنه جزءٌ من منطقها.
 */

/** ثابتٌ مكسور — اسمٌ من مجموعةٍ مغلقة وعددٌ، بلا معرّفات ولا محتوى */
export interface InvariantBreach {
  name: "candidate_revoked_became_approved" | "candidate_approved_without_gates";
  count: number;
}

export interface InvariantReport {
  /** تعذّر الفحص — ولا يُقال «سليم» حين لم يُقرأ شيء */
  unavailable: boolean;
  breaches: InvariantBreach[];
}

type CountQuery = {
  eq: (column: string, value: unknown) => CountQuery;
  neq: (column: string, value: unknown) => CountQuery;
  not: (column: string, operator: string, value: unknown) => CountQuery;
};

/**
 * عدٌّ خادميّ — لا صفوف تعود، فلا محتوى تدريبٍ يمرّ بالتطبيق أصلًا.
 *
 * ويُرجع `null` عند التعثّر بدل صفر: صفرٌ يعني «فُحص فلم يُوجد كسر»،
 * والتعثّر يعني «لم يُفحص». والخلطُ بينهما يجعل عطلًا في القراءة يبدو
 * شهادةَ سلامة.
 */
async function countBreach(
  db: SupabaseClient,
  table: string,
  narrow: (q: CountQuery) => CountQuery,
): Promise<number | null> {
  const base = db.from(table).select("id", { count: "exact", head: true });
  const res = (await (narrow(base as unknown as CountQuery) as unknown as PromiseLike<{
    count?: number | null;
    error?: unknown;
  }>));
  if (res.error) return null;
  return res.count ?? 0;
}

/** يقرأ ولا يكتب. */
export async function checkTrainingInvariants(db: SupabaseClient): Promise<InvariantReport> {
  const breaches: InvariantBreach[] = [];

  const resurrected = await countBreach(db, "training_candidates", (q) =>
    q.eq("status", "approved").not("revoked_at", "is", null),
  );
  const ungated = await countBreach(db, "training_candidates", (q) =>
    q.eq("status", "approved").neq("privacy_status", "passed"),
  );

  const unavailable = resurrected === null || ungated === null;

  if (resurrected !== null && resurrected > 0) {
    breaches.push({ name: "candidate_revoked_became_approved", count: resurrected });
  }
  if (ungated !== null && ungated > 0) {
    breaches.push({ name: "candidate_approved_without_gates", count: ungated });
  }

  return { unavailable, breaches };
}
