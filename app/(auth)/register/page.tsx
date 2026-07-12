"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthError, AuthInput, AuthNotice } from "@/components/auth/fields";

type FormValues = { displayName: string; email: string; password: string };

export default function RegisterPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<FormValues>();

  const onSubmit = handleSubmit(async ({ displayName, email, password }) => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setLoading(false);
    if (error) {
      setError(t("registerFailed"));
      return;
    }
    // إن كان تأكيد البريد مفعّلًا في Supabase لا تُنشأ جلسة مباشرة
    if (!data.session) {
      setConfirmSent(true);
      return;
    }
    router.push("/chat");
    router.refresh();
  });

  if (confirmSent) {
    return (
      <div className="space-y-4">
        <AuthNotice>{t("confirmEmailSent")}</AuthNotice>
        <Link href="/login" className="block text-center text-[13px] text-primary-glow hover:brightness-125">
          {t("login")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong mb-4">{t("register")}</h1>
      <AuthInput
        {...register("displayName", { required: true, maxLength: 60 })}
        type="text"
        autoComplete="name"
        placeholder={t("displayName")}
      />
      <AuthInput
        {...register("email", { required: true })}
        type="email"
        autoComplete="email"
        placeholder={t("email")}
        dir="ltr"
      />
      <AuthInput
        {...register("password", { required: true, minLength: 8 })}
        type="password"
        autoComplete="new-password"
        placeholder={t("password")}
        dir="ltr"
      />
      {error && <AuthError>{error}</AuthError>}
      <AuthButton disabled={loading}>
        {loading ? t("registering") : t("register")}
      </AuthButton>
      <div className="pt-2 text-center text-[13px] text-ink-dim">
        {t("haveAccount")}{" "}
        <Link href="/login" className="text-primary-glow hover:brightness-125">
          {t("login")}
        </Link>
      </div>
    </form>
  );
}
