"use client";

import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MobileMenuButton } from "@/components/shell/app-shell";

interface UsageViewProps {
  tier: string;
  dayMessages: number;
  monthMessages: number;
  monthTokens: number;
  filesCount: number;
  storageBytes: number;
  ragReady: number;
  limits: {
    dailyMessages: number;
    monthlyMessages: number;
    monthlyTokens: number;
    maxFiles: number;
    maxStorageMb: number;
  };
}

export function UsageView(props: UsageViewProps) {
  const { t, locale } = useI18n();
  const fmt = (n: number) => n.toLocaleString(locale === "ar" ? "ar-EG" : "en-US");
  const storageMb = props.storageBytes / 1024 / 1024;

  const bars = [
    { label: t("dailyMessages"), used: props.dayMessages, limit: props.limits.dailyMessages },
    { label: t("monthlyMessages"), used: props.monthMessages, limit: props.limits.monthlyMessages },
    { label: t("tokens"), used: props.monthTokens, limit: props.limits.monthlyTokens },
    { label: t("files"), used: props.filesCount, limit: props.limits.maxFiles },
    { label: t("storageUsage") + " (MB)", used: Math.round(storageMb), limit: props.limits.maxStorageMb },
  ];

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("usageTitle")}</h1>
        <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-primary/15 text-primary-glow border border-primary/30 ms-auto">
          {props.tier}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-[620px] mx-auto space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <MiniStat label={t("ragOps")} value={fmt(props.ragReady)} />
            <MiniStat label={t("files")} value={fmt(props.filesCount)} />
            <MiniStat label={t("tokens")} value={fmt(props.monthTokens)} />
          </div>

          <div className="rounded-2xl border border-line bg-surface/60 p-5 space-y-4">
            {bars.map((b) => (
              <UsageBar key={b.label} {...b} fmt={fmt} tRemaining={t("remaining")} tNear={t("nearLimit")} tAt={t("atLimit")} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface/60 border border-line/60 py-3">
      <div className="text-[17px] font-bold text-ink-strong tabular-nums" dir="ltr">{value}</div>
      <div className="text-[10.5px] text-ink-faint mt-0.5">{label}</div>
    </div>
  );
}

function UsageBar({
  label, used, limit, fmt, tRemaining, tNear, tAt,
}: {
  label: string; used: number; limit: number; fmt: (n: number) => string;
  tRemaining: string; tNear: string; tAt: string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remaining = Math.max(0, limit - used);
  const near = limit > 0 && pct >= 80 && pct < 100;
  const at = limit > 0 && used >= limit;
  const color = at ? "#ef4444" : near ? "#f59e0b" : "#8B6CF6";

  return (
    <div>
      <div className="flex items-center justify-between text-[12.5px] mb-1.5">
        <span className="text-ink-dim">{label}</span>
        <span className="text-ink tabular-nums" dir="ltr">
          {fmt(used)} {limit > 0 ? `/ ${fmt(limit)}` : ""}
        </span>
      </div>
      <div className="h-2 rounded-full bg-raised overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10.5px] text-ink-faint">{tRemaining}: {fmt(remaining)}</span>
        {(near || at) && (
          <span className={`flex items-center gap-1 text-[10.5px] ${at ? "text-red-400" : "text-amber-400"}`}>
            <AlertTriangle size={11} /> {at ? tAt : tNear}
          </span>
        )}
      </div>
    </div>
  );
}
