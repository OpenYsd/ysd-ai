"use client";

/** صفحة "قريبًا" — للميزات غير المكتملة، بلا أي ادعاء */

import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { LogoMark } from "@/components/logo";
import { MobileMenuButton } from "@/components/shell/app-shell";

export function ComingSoon({ titleKey }: { titleKey: "projects" | "files" }) {
  const { t } = useI18n();
  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t(titleKey)}</h1>
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-raised text-ink-faint border border-line/60">
          {t("comingSoon")}
        </span>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center px-5 text-center">
        <div className="mb-5 opacity-60">
          <LogoMark size={48} />
        </div>
        <p className="text-[14px] text-ink-dim max-w-sm leading-relaxed">
          {t("comingSoonPage")}
        </p>
        <Link
          href="/chat"
          className="mt-6 px-4 py-2 rounded-xl text-[13px] font-medium text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          {t("backToChat")}
        </Link>
      </div>
    </>
  );
}
