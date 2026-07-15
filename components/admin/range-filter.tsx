"use client";

import { useRouter, useSearchParams } from "next/navigation";

const RANGES = [
  { key: "today", label: "اليوم" },
  { key: "7d", label: "٧ أيام" },
  { key: "30d", label: "٣٠ يومًا" },
  { key: "all", label: "الكل" },
];

export function AdminRangeFilter({ current }: { current: string }) {
  const router = useRouter();
  const params = useSearchParams();

  function set(range: string) {
    const p = new URLSearchParams(params.toString());
    p.set("range", range);
    router.push(`?${p.toString()}`);
  }

  return (
    <div className="flex gap-1 rounded-xl bg-raised border border-line p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.key}
          onClick={() => set(r.key)}
          className={`px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
            current === r.key ? "bg-primary/20 text-ink-strong" : "text-ink-dim hover:text-ink"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
