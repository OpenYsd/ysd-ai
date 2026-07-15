import Link from "next/link";
import { BetaIntro } from "@/components/auth/beta-intro";

export default function BetaPage() {
  return (
    <div className="space-y-4">
      <BetaIntro />
      <div className="flex flex-col gap-2">
        <Link
          href="/register"
          className="w-full text-center rounded-xl py-3 text-sm font-medium text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          الانضمام بكود دعوة
        </Link>
        <Link href="/login" className="text-center text-[13px] text-ink-dim hover:text-ink">
          لديّ حساب — تسجيل الدخول
        </Link>
      </div>
    </div>
  );
}
