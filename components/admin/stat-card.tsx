export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-line/70 bg-surface/60 p-4">
      <div className="text-[12px] text-ink-dim">{label}</div>
      <div className="text-[22px] font-bold text-ink-strong mt-1 tabular-nums" dir="ltr">
        {typeof value === "number" ? value.toLocaleString("en-US") : value}
      </div>
      {sub && <div className="text-[11px] text-ink-faint mt-0.5">{sub}</div>}
    </div>
  );
}

export function StatusPill({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${tone}`}>
      <div className="text-[11px] opacity-80">{label}</div>
      <div className="text-[17px] font-bold tabular-nums" dir="ltr">
        {count.toLocaleString("en-US")}
      </div>
    </div>
  );
}
