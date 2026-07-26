import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin/guard";
import { summarize, summarizeDurable } from "@/lib/admin/health-metrics";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** رمز الخطأ → وصف عربي مختصر للوحة */
const ERROR_LABEL: Record<string, string> = {
  provider_unavailable: "المزوّد غير متاح",
  network_error: "انقطاع شبكة",
  auth_expired: "انتهاء جلسة",
  timeout: "تجاوز الوقت",
  rate_limit: "حد المعدّل",
  quality_guard: "حارس الجودة",
  unknown: "غير مصنّف",
};

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-line/60 bg-surface/40 px-4 py-3">
      <div className="text-[12px] text-ink-dim">{label}</div>
      <div className="text-[22px] font-semibold mt-0.5 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-ink-faint mt-0.5">{hint}</div>}
    </div>
  );
}

const ms = (n: number | null) => (n === null ? "—" : `${n} ms`);

/**
 * لوحة صحة المحادثة — أرقام مشتقة فقط.
 * لا تعرض نص محادثة ولا سؤالًا ولا هوية مستخدم: المصدر عدّادات في الذاكرة.
 */
export default async function AdminHealthPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/chat");

  // المصدر الدائم أولًا (ينجو من إعادة التشغيل)، والذاكرة احتياطًا إن لم
  // تُطبَّق الـmigration بعد أو تعذّرت القراءة.
  const supabase = await createClient();
  const durable = await summarizeDurable(supabase as never);
  const s = durable ?? summarize();
  const persistent = durable !== null;
  const minutes = Math.round(s.windowMs / 60_000);

  return (
    <div className="px-4 md:px-6 py-5 space-y-5">
      <div>
        <h1 className="text-[18px] font-semibold">صحة المحادثة</h1>
        <p className="text-[12.5px] text-ink-dim mt-1">
          آخر {minutes} دقيقة · {s.total} رد. أرقام فقط — لا نصوص محادثات ولا بيانات مستخدمين.
        </p>
      </div>

      {s.total === 0 ? (
        <div className="rounded-xl border border-line/60 bg-surface/40 px-4 py-6 text-[13px] text-ink-dim">
          لا توجد ردود في هذه النافذة بعد.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="متوسط زمن أول نص"
              value={ms(s.avgFirstTextMs)}
              hint={`p95: ${ms(s.p95FirstTextMs)}`}
            />
            <Stat
              label="نسبة الأخطاء"
              value={`${s.errorRate}%`}
              hint={`${s.errorCount} من ${s.total}`}
            />
            <Stat
              label="ردود احتاجت احتياطًا"
              value={String(s.fallbackResponses)}
              hint={`إجمالي مرات الاحتياط: ${s.fallbackTotal}`}
            />
            <Stat
              label="جلسات انتهت فجأة"
              value={String(s.abruptSessionEnds)}
              hint="تعذّر تجديد التوكن"
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="متوسط زمن الرد الكامل" value={ms(s.avgTotalMs)} />
            <Stat label="أسئلة محمية" value={String(s.protectedCount)} />
            <Stat
              label="ردود فورية بلا مزوّد"
              value={String(s.shortCircuits)}
              hint="اختصار الوضع المحمي"
            />
            <Stat label="إجمالي الردود" value={String(s.total)} />
          </div>

          <div className="rounded-xl border border-line/60 bg-surface/40 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-line/50 text-[13px] font-medium">
              أكثر أنواع الأخطاء
            </div>
            {s.topErrors.length === 0 ? (
              <div className="px-4 py-4 text-[13px] text-ink-dim">لا أخطاء في هذه النافذة.</div>
            ) : (
              <ul className="divide-y divide-line/40">
                {s.topErrors.map((e) => (
                  <li key={e.code} className="px-4 py-2.5 flex items-center justify-between">
                    <span className="text-[13px]">{ERROR_LABEL[e.code] ?? e.code}</span>
                    <span className="text-[13px] text-ink-dim tabular-nums">{e.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <p className="text-[11.5px] text-ink-faint">
        {persistent
          ? "المصدر: جدول observability_events — تبقى الإحصاءات بعد إعادة تشغيل الحاوية وتُجمَّع عبر النسخ. أرقام ورموز فقط، بلا أي نص أو بيانات شخصية."
          : "المصدر: ذاكرة الخادم (الاحتياطي) — تُصفَّر عند إعادة التشغيل. لتفعيل التخزين الدائم طبّق migration رقم 0018."}
      </p>
    </div>
  );
}
