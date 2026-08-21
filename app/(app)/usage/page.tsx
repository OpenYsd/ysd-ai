import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UsageView } from "@/components/usage/usage-view";
import { aggregateUsageEvents, countUsageEvents } from "@/lib/usage/aggregate";

export const dynamic = "force-dynamic";

/**
 * صفحة الاستهلاك.
 *
 * ── ما صُحّح في المرحلة 6C ──
 *
 * كان الشهر يُحسب من صفوفٍ تُجلب كلّها: `rows.length` للعدد و`reduce` للرموز.
 * و PostgREST يقصّ عند ألف صفٍّ بلا خطأ — فمن تجاوزها رأى `1000` مهما بلغ،
 * ومجموعَ رموزٍ يخصّ أوّل ألفٍ فقط. والعدد يُقرأ الآن عدًّا خادميًّا دقيقًا،
 * والمجموع بترقيمٍ محدود ومحدَّد. راجع `lib/usage/aggregate`.
 */
export default async function UsagePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [{ data: sub }, month, dayMessages, { data: files }] = await Promise.all([
    supabase.from("subscriptions").select("tier").eq("user_id", user.id).maybeSingle(),
    /**
      * ★ `scope: "self"` — ولا معرّف يُمرَّر.
      *
      * `usage_totals_self` تشتقّ الهوية من `auth.uid()` داخل القاعدة، فلا
      * يملك هذا السطر — ولا المتصفّح — أن يُسمّي غير صاحب الجلسة.
      */
    aggregateUsageEvents(supabase, { since: monthStart.toISOString() }, { scope: "self" }),
    countUsageEvents(supabase, { userId: user.id, since: dayStart.toISOString() }),
    supabase.from("files").select("size_bytes, status").eq("user_id", user.id).is("deleted_at", null),
  ]);

  const tier = sub?.tier ?? "free";
  const { data: limits } = await supabase
    .from("usage_limits")
    .select("monthly_messages, monthly_tokens, daily_messages, max_files, max_storage_mb")
    .eq("tier", tier)
    .maybeSingle();

  const fileRows = files ?? [];
  const ragReady = fileRows.filter((f) => f.status === "ready_for_rag").length;

  return (
    <UsageView
      tier={tier}
      dayMessages={dayMessages}
      monthMessages={month.events}
      monthTokens={month.tokens}
      /**
       * ★ لم يعد «تقريبيًّا» — صار «غيرَ متاح» أو دقيقًا.
       *
       * المجموع يأتي من `usage_totals_*` فهو دقيقٌ مهما بلغ العدد. وما بقي
       * هو حالةُ تعذّرٍ: لا رقمَ يُعرض حينها، لأن رقمًا خاطئًا يبدو صحيحًا
       * هو العطل الذي أُغلق.
       */
      tokensUnavailable={month.unavailable}
      tokensApproximate={month.truncated}
      filesCount={fileRows.length}
      storageBytes={fileRows.reduce((a, f) => a + (f.size_bytes ?? 0), 0)}
      ragReady={ragReady}
      limits={{
        dailyMessages: limits?.daily_messages ?? 0,
        monthlyMessages: limits?.monthly_messages ?? 0,
        monthlyTokens: limits?.monthly_tokens ?? 0,
        maxFiles: limits?.max_files ?? 0,
        maxStorageMb: limits?.max_storage_mb ?? 0,
      }}
    />
  );
}
