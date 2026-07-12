"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthInput, AuthNotice } from "@/components/auth/fields";

type FormValues = { email: string };

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<FormValues>();

  const onSubmit = handleSubmit(async ({ email }) => {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setLoading(false);
    // لا نكشف هل البريد مسجل أم لا — رسالة واحدة دائمًا
    setSent(true);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong mb-4">{t("resetPassword")}</h1>
      {sent ? (
        <AuthNotice>{t("resetLinkSent")}</AuthNotice>
      ) : (
        <>
          <AuthInput
            {...register("email", { required: true })}
            type="email"
            autoComplete="email"
            placeholder={t("email")}
            dir="ltr"
          />
          <AuthButton disabled={loading}>{t("sendResetLink")}</AuthButton>
        </>
      )}
      <div className="pt-2 text-center text-[13px]">
        <Link href="/login" className="text-ink-dim hover:text-ink transition-colors">
          {t("login")}
        </Link>
      </div>
    </form>
  );
}
