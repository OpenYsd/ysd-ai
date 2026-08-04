"use client";

/**
 * «التسجيل باستخدام Google بدعوة».
 *
 * الترتيب مقصود: **الزر لا يظهر قبل نجاح التحقق**. لو ظهر من البداية لكان
 * بابًا لتسجيل Google عام — وهو بالضبط ما لا نريده ما دام `allow_registration`
 * مغلقًا. المستخدم يُثبت أنه يملك دعوة أولًا، فيُنشأ له تصريح خادمي مربوط
 * بالبريد الذي أدخله، ثم يُفتح له الباب.
 *
 * والزر هنا **ليس** زر Google العام: يمرّ بـ`prompt=select_account` كي يُخيَّر
 * المستخدم بين حساباته بدل أن يُدخَل صامتًا بحساب لا يطابق التصريح.
 *
 * لا يُخزَّن الكود ولا البريد ولا التصريح في localStorage ولا في شريط العنوان —
 * التصريح يعيش في القاعدة وحدها، وعلامةُ «التدفّق جارٍ» كوكي خادمي HttpOnly.
 */

import { useState } from "react";
import { AuthButton, AuthError, AuthInput, AuthNotice } from "@/components/auth/fields";
import { GoogleButton } from "@/components/auth/google-button";

export function GoogleInviteForm() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);

  const verify = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/google-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), email: email.trim() }),
      });
      if (res.status === 429) {
        setError("محاولات كثيرة — انتظر قليلًا.");
        return;
      }
      if (!res.ok) {
        setError("كود الدعوة أو البريد غير صالح. تأكّد منهما ثم أعد المحاولة.");
        return;
      }
      setAuthorized(true);
    } catch {
      setError("تعذّر التحقق. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-line bg-raised px-4 py-2.5 text-[13px] text-ink-strong transition-colors hover:border-primary/40"
      >
        التسجيل باستخدام Google بدعوة
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-line bg-raised/50 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13.5px] font-semibold text-ink-strong">
          التسجيل باستخدام Google بدعوة
        </h2>
        {!authorized && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[12px] text-ink-faint hover:text-ink transition-colors"
          >
            إغلاق
          </button>
        )}
      </div>

      {authorized ? (
        <div className="space-y-2">
          <AuthNotice>تم التحقق من الدعوة. تابع بحساب Google المطابق للبريد المدخل.</AuthNotice>
          <GoogleButton label="المتابعة باستخدام Google" promptSelectAccount />
          <p className="text-[11.5px] text-ink-faint leading-relaxed">
            اختر حساب Google الذي بريده مطابق تمامًا للبريد الذي أدخلته. أي حساب آخر
            سيُرفض. التصريح صالح عشر دقائق.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] text-ink-faint leading-relaxed">
            أدخل كود الدعوة وبريد Google الذي ستستخدمه. لن تُستهلك الدعوة قبل نجاح
            الدخول.
          </p>
          <AuthInput
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            placeholder="كود الدعوة"
            dir="ltr"
          />
          <AuthInput
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            type="email"
            autoComplete="email"
            placeholder="بريد Google"
            dir="ltr"
          />
          {error && <AuthError>{error}</AuthError>}
          <AuthButton
            type="button"
            onClick={verify}
            disabled={loading || code.trim().length < 8 || email.trim().length < 3}
          >
            {loading ? "جارٍ التحقق…" : "تحقّق وتابع"}
          </AuthButton>
        </div>
      )}
    </div>
  );
}
