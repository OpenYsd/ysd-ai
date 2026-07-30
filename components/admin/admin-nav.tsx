"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Database,
  FileStack,
  Gauge,
  Mail,
  ScrollText,
  Settings,
  Users,
  Cpu,
} from "lucide-react";
import { Logo } from "@/components/logo";

const ITEMS = [
  { href: "/admin", label: "نظرة عامة", labelEn: "Overview", icon: BarChart3, exact: true },
  { href: "/admin/users", label: "المستخدمون", labelEn: "Users", icon: Users },
  { href: "/admin/models", label: "النماذج", labelEn: "Models", icon: Database },
  { href: "/admin/ai", label: "إدارة الذكاء الاصطناعي", labelEn: "AI", icon: Cpu },
  { href: "/admin/rag", label: "RAG", labelEn: "RAG", icon: FileStack },
  { href: "/admin/usage", label: "الاستهلاك", labelEn: "Usage", icon: Gauge },
  { href: "/admin/health", label: "صحة المحادثة", labelEn: "Health", icon: Activity },
  { href: "/admin/invites", label: "الدعوات", labelEn: "Invites", icon: Mail },
  { href: "/admin/audit", label: "سجل التدقيق", labelEn: "Audit", icon: ScrollText },
  { href: "/admin/settings", label: "الإعدادات", labelEn: "Settings", icon: Settings },
];

export function AdminNav({ isOwner }: { isOwner: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="md:w-60 shrink-0 border-e border-line/60 bg-surface/60 md:min-h-dvh">
      <div className="p-4">
        <Link href="/admin">
          <Logo tagline="لوحة الإدارة" />
        </Link>
      </div>
      <nav className="px-2 pb-3 flex md:flex-col gap-0.5 overflow-x-auto">
        {ITEMS.map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
          const Icon = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] whitespace-nowrap transition-colors ${
                active ? "bg-raised text-ink-strong" : "text-ink-dim hover:bg-raised/60"
              }`}
            >
              <Icon size={15} className="shrink-0" />
              {it.label}
            </Link>
          );
        })}
      </nav>
      {isOwner && (
        <div className="px-4 pb-4 hidden md:block">
          <div className="text-[10.5px] text-ink-faint leading-relaxed">
            صلاحية <span className="text-primary-glow">owner</span>: العمليات الحرجة
            (إنشاء/خفض owner، الإعدادات الأمنية).
          </div>
        </div>
      )}
    </aside>
  );
}
