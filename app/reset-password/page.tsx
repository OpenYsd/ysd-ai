"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthError, AuthInput } from "@/components/auth/fields";
import { Logo } from "@/components/logo";

type FormValues = { password: string };

/** تُفتح من رابط استعادة كلمة المرور بعد تبادل الجلسة في /auth/callback */
export default function ResetPasswordPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<FormValues>();

  const onSubmit = handleSubmit(async ({ password }) => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setError(t("registerFailed"));
      return;
    }
    router.push("/chat");
    router.refresh();
  });

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rise">
        <div className="flex justify-center mb-8">
          <Logo tagline="منصة الذكاء العربي" />
        </div>
        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-line bg-surface/60 backdrop-blur p-6 space-y-3"
        >
          <h1 className="text-lg font-semibold text-ink-strong mb-4">
            {t("resetPassword")}
          </h1>
          <AuthInput
            {...register("password", { required: true, minLength: 8 })}
            type="password"
            autoComplete="new-password"
            placeholder={t("newPassword")}
            dir="ltr"
          />
          {error && <AuthError>{error}</AuthError>}
          <AuthButton disabled={loading}>{t("save")}</AuthButton>
        </form>
      </div>
    </main>
  );
}
