"use client";

/**
 * الهيكل الرئيسي للتطبيق: شريط جانبي قابل للطي (RTL/LTR)
 * محادثات حقيقية من قاعدة البيانات + بحث + إعادة تسمية + حذف.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  FolderKanban,
  Languages,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Logo, LogoMark } from "@/components/logo";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/components/theme";
import { ShellProvider, useShell } from "./shell-context";

export interface ConversationItem {
  id: string;
  title: string;
  updated_at: string;
}

interface AppShellProps {
  userName: string;
  tier: string;
  conversations: ConversationItem[];
  children: React.ReactNode;
}

export function AppShell(props: AppShellProps) {
  return (
    <ShellProvider>
      <ShellInner {...props} />
    </ShellProvider>
  );
}

function ShellInner({ userName, tier, conversations, children }: AppShellProps) {
  const { t, locale, setLocale, dir } = useI18n();
  const { theme, setTheme } = useTheme();
  const { mobileOpen, setMobileOpen } = useShell();
  const router = useRouter();
  const pathname = usePathname();

  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const filtered = useMemo(
    () =>
      conversations.filter(
        (c) => !search || c.title.toLowerCase().includes(search.toLowerCase()),
      ),
    [conversations, search],
  );

  const tierLabel =
    tier === "plus"
      ? t("plusTier")
      : tier === "pro"
        ? t("proTier")
        : tier === "business"
          ? t("businessTier")
          : t("freeTier");

  async function saveRename(id: string) {
    const title = editValue.trim();
    setEditingId(null);
    if (!title) return;
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    router.refresh();
  }

  async function deleteConversation(id: string) {
    if (!window.confirm(t("confirmDelete"))) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (pathname === `/chat/${id}`) router.push("/chat");
    router.refresh();
  }

  const CollapseIcon = dir === "rtl" ? ChevronsRight : ChevronsLeft;
  const ExpandIcon = dir === "rtl" ? ChevronsLeft : ChevronsRight;

  return (
    <div className="h-dvh w-full flex overflow-hidden">
      {/* غطاء الجوال */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ===== الشريط الجانبي ===== */}
      <aside
        className={`z-40 flex flex-col border-e border-line/60 bg-surface/95 backdrop-blur transition-all duration-200
          fixed inset-y-0 start-0 md:static
          ${mobileOpen ? "translate-x-0" : dir === "rtl" ? "translate-x-full md:translate-x-0" : "-translate-x-full md:translate-x-0"}`}
        style={{ width: collapsed ? 68 : 288 }}
      >
        <div className="p-4 flex items-center justify-between">
          <Link href="/chat" onClick={() => setMobileOpen(false)}>
            <Logo compact={collapsed} tagline={t("tagline")} />
          </Link>
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={t("collapseSidebar")}
            className="hidden md:flex w-7 h-7 items-center justify-center rounded-lg text-ink-dim hover:bg-raised transition-colors"
          >
            {collapsed ? <ExpandIcon size={15} /> : <CollapseIcon size={15} />}
          </button>
          <button
            onClick={() => setMobileOpen(false)}
            className="md:hidden w-7 h-7 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised"
          >
            <X size={16} />
          </button>
        </div>

        {/* محادثة جديدة */}
        <div className="px-3">
          <Link
            href="/chat"
            onClick={() => setMobileOpen(false)}
            className="w-full flex items-center justify-center gap-2.5 rounded-xl px-3 py-2.5 text-[13.5px] font-medium text-white transition-all hover:brightness-110"
            style={{
              background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)",
              boxShadow: "0 4px 16px rgba(108,75,240,.28)",
            }}
          >
            <Plus size={16} />
            {!collapsed && t("newChat")}
          </Link>
        </div>

        {/* البحث */}
        {!collapsed && (
          <div className="px-3 mt-3">
            <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2">
              <Search size={13} className="text-ink-faint shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="bg-transparent w-full text-[13px] text-ink placeholder-ink-faint focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* المحادثات */}
        <div className="flex-1 overflow-y-auto px-3 mt-4 space-y-0.5">
          {!collapsed && (
            <div className="px-1 pb-1.5 text-[11px] font-medium text-ink-faint">
              {t("conversations")}
            </div>
          )}
          {filtered.length === 0 && !collapsed && (
            <div className="px-1 py-3 text-[12.5px] text-ink-faint leading-relaxed whitespace-pre-line">
              {t("noConversations")}
            </div>
          )}
          {filtered.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            if (editingId === c.id && !collapsed) {
              return (
                <form
                  key={c.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveRename(c.id);
                  }}
                  className="flex items-center gap-1 rounded-lg bg-raised border border-primary/50 px-2 py-1"
                >
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                    className="bg-transparent w-full text-[13px] text-ink-strong focus:outline-none py-1"
                  />
                  <button type="submit" className="p-1 text-primary-glow hover:brightness-125">
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="p-1 text-ink-faint hover:text-ink"
                  >
                    <X size={14} />
                  </button>
                </form>
              );
            }
            return (
              <div
                key={c.id}
                className={`group flex items-center rounded-lg transition-colors ${
                  active ? "bg-raised text-ink-strong" : "text-ink-dim hover:bg-raised/60"
                }`}
              >
                <Link
                  href={`/chat/${c.id}`}
                  onClick={() => setMobileOpen(false)}
                  className="flex-1 min-w-0 px-3 py-2 text-[13px] truncate"
                  title={c.title}
                >
                  {collapsed ? "◦" : c.title}
                </Link>
                {!collapsed && (
                  <div className="hidden group-hover:flex items-center pe-1.5 gap-0.5 shrink-0">
                    <button
                      onClick={() => {
                        setEditingId(c.id);
                        setEditValue(c.title);
                      }}
                      title={t("rename")}
                      className="p-1 rounded text-ink-faint hover:text-ink"
                    >
                      <Pencil size={12.5} />
                    </button>
                    <button
                      onClick={() => void deleteConversation(c.id)}
                      title={t("delete")}
                      className="p-1 rounded text-ink-faint hover:text-red-400"
                    >
                      <Trash2 size={12.5} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* الروابط السفلية */}
        <div className="p-3 border-t border-line/60 space-y-0.5">
          <NavItem
            href="/projects"
            icon={<FolderKanban size={15} />}
            label={t("projects")}
            collapsed={collapsed}
            active={pathname.startsWith("/projects")}
          />
          <NavItem
            href="/files"
            icon={<FileText size={15} />}
            label={t("files")}
            badge={t("comingSoon")}
            collapsed={collapsed}
            active={pathname.startsWith("/files")}
          />
          <NavItem
            href="/account"
            icon={<User size={15} />}
            label={t("account")}
            collapsed={collapsed}
            active={pathname.startsWith("/account")}
          />
          <NavItem
            href="/settings"
            icon={<Settings size={15} />}
            label={t("settings")}
            collapsed={collapsed}
            active={pathname.startsWith("/settings")}
          />

          {/* المستخدم + أدوات سريعة */}
          <div
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 mt-1 ${collapsed ? "justify-center" : ""}`}
          >
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#7C5CFF] to-[#3D2AA8] flex items-center justify-center text-[12px] font-bold text-white shrink-0">
              {userName.slice(0, 1) || "؟"}
            </div>
            {!collapsed && (
              <>
                <div className="leading-tight flex-1 min-w-0">
                  <div className="text-[13px] text-ink truncate">{userName}</div>
                  <div className="text-[10.5px] text-ink-faint">{tierLabel}</div>
                </div>
                <button
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                  title={theme === "dark" ? t("themeLight") : t("themeDark")}
                  className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-raised transition-colors"
                >
                  {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                </button>
                <button
                  onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
                  title={locale === "ar" ? "English" : "العربية"}
                  className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-raised transition-colors"
                >
                  <Languages size={14} />
                </button>
                <form action="/auth/signout" method="post">
                  <button
                    type="submit"
                    title={t("logout")}
                    className="p-1.5 rounded-lg text-ink-faint hover:text-red-400 hover:bg-raised transition-colors"
                  >
                    <LogOut size={14} />
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* ===== المحتوى ===== */}
      <main className="flex-1 flex flex-col min-w-0">{children}</main>
    </div>
  );
}

function NavItem({
  href,
  icon,
  label,
  badge,
  collapsed,
  active,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed: boolean;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${
        active ? "bg-raised text-ink-strong" : "text-ink-dim hover:bg-raised/60"
      } ${collapsed ? "justify-center" : ""}`}
      title={label}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && (
        <>
          <span className="flex-1">{label}</span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-raised text-ink-faint border border-line/60">
              {badge}
            </span>
          )}
        </>
      )}
    </Link>
  );
}

/** زر فتح الشريط على الجوال — يُستخدم في رؤوس الصفحات */
export function MobileMenuButton() {
  const { setMobileOpen } = useShell();
  return (
    <button
      onClick={() => setMobileOpen(true)}
      className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised transition-colors"
    >
      <Menu size={17} />
    </button>
  );
}

export { LogoMark };
