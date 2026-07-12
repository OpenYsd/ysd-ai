"use client";

/** حقول وأزرار موحّدة لنماذج المصادقة */

import { forwardRef } from "react";

export const AuthInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function AuthInput(props, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className="w-full rounded-xl bg-raised border border-line px-4 py-3 text-sm text-ink-strong placeholder-ink-faint focus:outline-none focus:border-primary transition-colors"
    />
  );
});

export function AuthButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...props}
      className="w-full rounded-xl py-3 text-sm font-medium text-white disabled:opacity-50 transition-all hover:brightness-110"
      style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
    >
      {children}
    </button>
  );
}

export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}

export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}
