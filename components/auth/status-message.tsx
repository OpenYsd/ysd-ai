"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export function StatusMessage({ kind }: { kind: "suspended" | "maintenance" }) {
  const { t } = useI18n();
  const title = kind === "suspended" ? t("suspendedTitle") : t("maintenanceTitle");
  const body = kind === "suspended" ? t("suspendedBody") : t("maintenanceBody");
  return (
    <div className="text-center space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong">{title}</h1>
      <p className="text-[13px] text-ink-dim leading-relaxed">{body}</p>
      {/**
       * ★ نصُّ الإيقاف يطلب التواصل — فليكن التواصل ممكنًا (المرحلة 6A).
       *
       * `suspendedBody` يقول «تواصل مع إدارة المنصة» منذ إصدارات، وليس في
       * المنتج كلّه طريقٌ إلى أحد. ومن أُوقف حسابه هو أوّل من يحتاجه.
       */}
      {kind === "suspended" && (
        <Link
          href="/support"
          data-status-support=""
          className="block text-[12.5px] text-primary-glow hover:brightness-125 transition-all rounded
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
        >
          {t("contactSupport")}
        </Link>
      )}
      <form action="/auth/signout" method="post">
        <button type="submit" className="text-[12.5px] text-ink-faint hover:text-ink">
          {t("logout")}
        </button>
      </form>
      <Link href="/login" className="block text-[12.5px] text-primary-glow">
        {t("login")}
      </Link>
    </div>
  );
}
