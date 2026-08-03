"use client";

/**
 * «المتابعة باستخدام Google» — يستعمل تدفّق OAuth القائم في Supabase.
 *
 * **لا يتجاوز نظام الدعوة**: المُحفّز `handle_new_user` يعمل على كل إدراج في
 * auth.users أيًّا كان مصدره، فمستخدم جديد بلا تذكرة دعوة (والوضع invite_only)
 * يُرفض عند القاعدة لا في الواجهة. Google هنا مسار **دخول** لمن يملك حسابًا،
 * وليس بابًا خلفيًا للتسجيل. ونقطة الرجوع تترجم الرفض إلى رسالة مفهومة.
 *
 * `redirectTo` يُبنى من `window.location.origin` — عنوان المتصفح الفعلي، لا
 * أي عنوان خادم. هذا هو الموضع الوحيد الذي يجوز فيه بناء عنوان مطلق، لأنه
 * يقع في المتصفح أصلًا.
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function GoogleButton({ next }: { next?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/chat";
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });
      // النجاح يعني مغادرة الصفحة إلى Google، فلا نُطفئ التحميل هنا
      if (err) {
        setError("تعذّر بدء الدخول عبر Google. حاول مرة أخرى.");
        setLoading(false);
      }
    } catch {
      setError("تعذّر بدء الدخول عبر Google. حاول مرة أخرى.");
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[11.5px] text-ink-faint">أو</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
        className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-line bg-raised px-4 py-2.5 text-[13.5px] text-ink-strong transition-colors hover:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {/* شعار Google الرسمي — SVG مضمّن، بلا طلب خارجي */}
        <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
          <path
            fill="#FFC107"
            d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
          />
          <path
            fill="#FF3D00"
            d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
          />
          <path
            fill="#4CAF50"
            d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
          />
          <path
            fill="#1976D2"
            d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571h.003l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
          />
        </svg>
        <span>{loading ? "جارٍ التحويل…" : "المتابعة باستخدام Google"}</span>
      </button>

      {error && (
        <p role="alert" className="text-[12.5px] text-rose-300 text-center">
          {error}
        </p>
      )}
    </div>
  );
}
