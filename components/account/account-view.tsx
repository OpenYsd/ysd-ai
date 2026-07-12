"use client";

/** الحساب والاستهلاك: بيانات حقيقية من قاعدة البيانات */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { MobileMenuButton } from "@/components/shell/app-shell";

interface AccountViewProps {
  email: string;
  displayName: string;
  tier: string;
  messagesUsed: number;
  messagesLimit: number;
  tokensUsed: number;
  tokensLimit: number;
}

export function AccountView({
  email,
  displayName,
  tier,
  messagesUsed,
  messagesLimit,
  tokensUsed,
  tokensLimit,
}: AccountViewProps) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [name, setName] = useState(displayName);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const tierLabel =
    tier === "plus"
      ? t("plusTier")
      : tier === "pro"
        ? t("proTier")
        : tier === "business"
          ? t("businessTier")
          : t("freeTier");

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: name.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    }
  }

  const fmt = (n: number) => n.toLocaleString(locale === "ar" ? "ar-EG" : "en-US");

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("account")}</h1>
        {saved && <span className="text-[12px] text-emerald-400">{t("saved")}</span>}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-[560px] mx-auto space-y-5">
          {/* الملف الشخصي */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5">
            <h2 className="text-[13px] font-medium text-ink-strong mb-3">{t("profile")}</h2>
            <form onSubmit={saveName} className="space-y-3">
              <div>
                <label className="block text-[12px] text-ink-dim mb-1.5">
                  {t("displayName")}
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  className="w-full rounded-xl bg-raised border border-line px-3 py-2.5 text-[13px] text-ink-strong focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-[12px] text-ink-dim mb-1.5">{t("email")}</label>
                <input
                  value={email}
                  disabled
                  dir="ltr"
                  className="w-full rounded-xl bg-raised/50 border border-line px-3 py-2.5 text-[13px] text-ink-faint"
                />
              </div>
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className="px-4 py-2 rounded-xl text-[13px] font-medium text-white disabled:opacity-50 transition-all hover:brightness-110"
                style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
              >
                {t("save")}
              </button>
            </form>
          </section>

          {/* الباقة */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5">
            <h2 className="text-[13px] font-medium text-ink-strong mb-2">{t("plan")}</h2>
            <div className="text-[14px] text-primary-glow font-medium">{tierLabel}</div>
          </section>

          {/* الاستهلاك */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5 space-y-4">
            <h2 className="text-[13px] font-medium text-ink-strong">
              {t("usageThisMonth")}
            </h2>
            <UsageBar
              label={t("messages")}
              used={messagesUsed}
              limit={messagesLimit}
              ofLabel={t("of")}
              fmt={fmt}
            />
            <UsageBar
              label={t("tokens")}
              used={tokensUsed}
              limit={tokensLimit}
              ofLabel={t("of")}
              fmt={fmt}
            />
          </section>
        </div>
      </div>
    </>
  );
}

function UsageBar({
  label,
  used,
  limit,
  ofLabel,
  fmt,
}: {
  label: string;
  used: number;
  limit: number;
  ofLabel: string;
  fmt: (n: number) => string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[12.5px] mb-1.5">
        <span className="text-ink-dim">{label}</span>
        <span className="text-ink" dir="ltr">
          {fmt(used)} {limit > 0 ? `/ ${fmt(limit)}` : ""}
        </span>
      </div>
      <div className="h-2 rounded-full bg-raised overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)",
          }}
        />
      </div>
      <span className="sr-only">
        {fmt(used)} {ofLabel} {fmt(limit)}
      </span>
    </div>
  );
}
