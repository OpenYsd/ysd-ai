"use client";

/**
 * نموذج قبول الشروط — الخطوة الأخيرة قبل دخول التطبيق لمستخدمي Google.
 *
 * لا يمكن تخطّيه: تخطيط التطبيق يعيد التحويل إلى هنا ما دامت صفوف الموافقة
 * غائبة، فحتى من كتب /chat في شريط العنوان يعود. والقبول يُسجَّل خادميًا
 * بنسخة الوثيقة من الإعدادات لا من العميل.
 */

import { useState } from "react";
import Link from "next/link";
import { AuthButton, AuthError } from "@/components/auth/fields";

export function AcceptTermsForm({ version }: { version: string }) {
  const [agree, setAgree] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    if (!agree || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/consent", { method: "POST" });
      if (!r.ok) {
        setError("تعذّر حفظ الموافقة. حاول مرة أخرى.");
        setLoading(false);
        return;
      }
      // تحويل كامل لا router.push: التخطيط يقرأ الموافقة على الخادم، ونريد
      // طلبًا جديدًا يراها بدل تنقّل عميل يعتمد على ذاكرة الموجّه
      window.location.assign("/chat");
    } catch {
      setError("تعذّر حفظ الموافقة. حاول مرة أخرى.");
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-strong">خطوة أخيرة</h1>
        <p className="mt-1.5 text-[13px] text-ink-dim leading-relaxed">
          قبل استخدام YSD AI، يلزم قبول شروط الاستخدام وسياسة الخصوصية.
        </p>
      </div>

      <label className="flex items-start gap-2 text-[12.5px] text-ink-dim leading-relaxed cursor-pointer">
        <input
          type="checkbox"
          checked={agree}
          onChange={(e) => setAgree(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          أوافق على{" "}
          <Link href="/terms" target="_blank" className="text-primary-glow hover:underline">
            شروط الاستخدام
          </Link>
          {" · "}
          <Link href="/privacy" target="_blank" className="text-primary-glow hover:underline">
            سياسة الخصوصية
          </Link>
          {version && <span className="text-ink-faint"> — {version}</span>}
        </span>
      </label>

      {error && <AuthError>{error}</AuthError>}

      {/* type=button صراحةً: AuthButton افتراضه submit، ولا نموذج هنا */}
      <AuthButton type="button" disabled={!agree || loading} onClick={onAccept}>
        {loading ? "جارٍ الحفظ…" : "أوافق ومتابعة"}
      </AuthButton>

      <form action="/auth/signout" method="post" className="pt-1 text-center">
        <button
          type="submit"
          className="text-[12.5px] text-ink-faint hover:text-ink transition-colors"
        >
          تسجيل الخروج
        </button>
      </form>
    </div>
  );
}
