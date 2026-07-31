"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n";
import { AuthButton, AuthError, AuthInput, AuthNotice } from "@/components/auth/fields";
import {
  classifySignupError,
  SIGNUP_ERROR_MESSAGE,
} from "@/lib/auth/registration-mode";

type FormValues = { displayName: string; email: string; password: string };

export function RegisterForm({
  allowRegistration,
  requireInvite,
  termsVersion,
  initialCode,
}: {
  allowRegistration: boolean;
  requireInvite: boolean;
  termsVersion: string;
  initialCode: string;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState(initialCode);
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [agree, setAgree] = useState(false);
  const { register, handleSubmit } = useForm<FormValues>();

  // التسجيل مغلق كليًا (لا دعوة)
  if (!allowRegistration && !requireInvite) {
    return <AuthNotice>{t("registrationClosed")}</AuthNotice>;
  }

  /** التحقق عبر مسارنا (Rate Limit بالـIP) لا عبر RPC مباشرة */
  async function verifyInvite() {
    setChecking(true);
    setInviteOk(null);
    setError(null);
    const res = await fetch("/api/invite/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    if (res.status === 429) {
      setError("محاولات كثيرة — انتظر قليلًا.");
      setChecking(false);
      return;
    }
    const j = (await res.json().catch(() => null)) as { valid?: boolean } | null;
    setInviteOk(j?.valid === true);
    setChecking(false);
  }

  const onSubmit = handleSubmit(async ({ displayName, email, password }) => {
    if (!agree) {
      setError(t("mustAgree"));
      return;
    }
    if (requireInvite && inviteOk !== true) {
      setError(t("inviteInvalid"));
      return;
    }
    setLoading(true);
    setError(null);

    // استبدل كود الدعوة بتذكرة مؤقتة أحادية الاستخدام قبل أي اتصال بـGoTrue.
    // أي مفتاح يُرسَل في signUp.data ينتهي في استجابة GoTrue وفي الـJWT، فلا
    // يجوز أن يصله الكود الخام إطلاقًا.
    let ticket = "";
    if (code.trim()) {
      const res = await fetch("/api/invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (res.status === 429) {
        setError("محاولات كثيرة — انتظر قليلًا.");
        setLoading(false);
        return;
      }
      const j = (await res.json().catch(() => null)) as { ticket?: string } | null;
      if (!res.ok || !j?.ticket) {
        setError(t("inviteInvalid"));
        setInviteOk(false);
        setLoading(false);
        return;
      }
      ticket = j.ticket;
    }

    const supabase = createClient();
    // نرسل «وافق» فقط — رقم النسخة يختمه المُحفّز من platform_settings (لا يُوثق بالعميل)
    const meta: Record<string, string> = { display_name: displayName, terms_accepted: "true" };
    if (ticket) meta.invite_ticket = ticket;
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: meta, emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (error) {
      /**
       * كل حالة متوقّعة رسالتها الخاصة.
       *
       * كانت الرسالة تُختار من requireInvite وحدها: فيقال «رمز الدعوة غير
       * صالح» لكلمة مرور ضعيفة أو بريد مسجَّل مسبقًا، ويقال «تعذّر التسجيل»
       * لتسجيل مغلق. المستخدم يصحّح ما ليس خطأ ولا يعرف ما الخطأ.
       *
       * والتصنيف يقع في وحدة واحدة تُخرج رمزًا من مجموعة مغلقة — فلا يظهر
       * اسم دالة ولا قيد ولا SQL ولا stack trace مهما كان نصّ المزوّد.
       */
      setError(SIGNUP_ERROR_MESSAGE[classifySignupError(error)]);
      return;
    }
    if (!data.session) {
      setConfirmSent(true);
      return;
    }
    window.location.href = "/chat";
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
      <h1 className="text-lg font-semibold text-ink-strong mb-1">{t("register")}</h1>
      {requireInvite && (
        <p className="text-[12px] text-ink-faint leading-relaxed">{t("betaIntro")}</p>
      )}

      {requireInvite && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <AuthInput
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setInviteOk(null);
              }}
              placeholder={t("inviteCode")}
              dir="ltr"
            />
            <button
              type="button"
              onClick={verifyInvite}
              disabled={checking || code.trim().length < 8}
              className="shrink-0 px-3 rounded-xl text-[12.5px] text-ink bg-raised border border-line hover:border-primary/40 disabled:opacity-50"
            >
              {t("checkInvite")}
            </button>
          </div>
          {inviteOk === true && <AuthNotice>{t("inviteValid")}</AuthNotice>}
          {inviteOk === false && <AuthError>{t("inviteInvalid")}</AuthError>}
        </div>
      )}

      <AuthInput {...register("displayName", { required: true, maxLength: 60 })} type="text" autoComplete="name" placeholder={t("displayName")} />
      <AuthInput {...register("email", { required: true })} type="email" autoComplete="email" placeholder={t("email")} dir="ltr" />
      <AuthInput {...register("password", { required: true, minLength: 8 })} type="password" autoComplete="new-password" placeholder={t("password")} dir="ltr" />

      <label className="flex items-start gap-2 text-[12px] text-ink-dim leading-relaxed cursor-pointer">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
        <span>
          {t("agreeTerms")} (
          <Link href="/terms" target="_blank" className="text-primary-glow hover:underline">{t("termsLink")}</Link>
          {" · "}
          <Link href="/privacy" target="_blank" className="text-primary-glow hover:underline">{t("privacyLink")}</Link>
          ){termsVersion && <span className="text-ink-faint"> — {termsVersion}</span>}
        </span>
      </label>

      {error && <AuthError>{error}</AuthError>}
      <AuthButton disabled={loading || (requireInvite && inviteOk !== true) || !agree}>
        {loading ? t("registering") : t("register")}
      </AuthButton>
      <div className="pt-1 text-center text-[13px] text-ink-dim">
        {t("haveAccount")}{" "}
        <Link href="/login" className="text-primary-glow hover:brightness-125">{t("login")}</Link>
      </div>
    </form>
  );
}
