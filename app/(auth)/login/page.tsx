"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthError, AuthInput } from "@/components/auth/fields";
import { GoogleButton } from "@/components/auth/google-button";
import { AUTH_REASON_MESSAGE, type OAuthReason } from "@/lib/auth/oauth-error";

type FormValues = { email: string; password: string };

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { register, handleSubmit } = useForm<FormValues>();

  /**
   * رسائل معامل `reason` القادم من نقطة الرجوع أو الوسيط — رموز مغلقة تُترجم
   * من الخريطة المشتركة. **لا يُعرَض إلا ما كان مفتاحًا معروفًا فيها**، فأي
   * قيمة أخرى في شريط العنوان — بما فيها نصّ خطأ يحقنه أحد — تُهمَل ولا تُطبع.
   *
   * دخول Google **لا يتجاوز** نظام الدعوة: مستخدم جديد بلا دعوة يرفضه المُحفّز
   * عند القاعدة، فنشرح السبب بدل رسالة فشل عامة.
   */
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get("reason");
    if (!reason) return;
    const message = AUTH_REASON_MESSAGE[reason as OAuthReason];
    if (message) setError(message);
  }, []);

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(t("loginFailed"));
      return;
    }
    router.push("/chat");
    router.refresh();
  });

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong mb-4">{t("login")}</h1>
      <AuthInput
        {...register("email", { required: true })}
        type="email"
        autoComplete="email"
        placeholder={t("email")}
        dir="ltr"
      />
      <AuthInput
        {...register("password", { required: true })}
        type="password"
        autoComplete="current-password"
        placeholder={t("password")}
        dir="ltr"
      />
      {error && <AuthError>{error}</AuthError>}
      <AuthButton disabled={loading}>
        {loading ? t("loggingIn") : t("login")}
      </AuthButton>

      <GoogleButton />
      <div className="flex items-center justify-between pt-2 text-[13px]">
        <Link href="/forgot-password" className="text-ink-dim hover:text-ink transition-colors">
          {t("forgotPassword")}
        </Link>
        <Link href="/register" className="text-primary-glow hover:brightness-125 transition-all">
          {t("register")}
        </Link>
      </div>
    </form>
  );
}
