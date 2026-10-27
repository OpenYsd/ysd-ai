"use client";

/**
 * الهيكل الموحّد للمنصّة:
 *   - شريط أيقونات ضيّق للوحدات المتاحة فقط (lib/platform/modules.ts) — لكل أيقونة اسمٌ مسموع، ولا زرّ لوحدةٍ لم تُبنَ؛
 *   - لوحة سياق شفّافة قليلًا وقابلة للطي، يتبع محتواها الوحدة:
 *       المحادثة والمشاريع ← محادثة جديدة، ثم المحادثات والمشاريع؛
 *       الإعدادات ← بحثها وأقسامها؛ المكتبة ← بلا لوحة (الصفحة بعرضها)؛
 *   - قائمة الحساب من الصورة الرمزية أسفل الشريط: الحساب والاستهلاك والإدارة والخروج؛
 *   - بحث سريع (Ctrl/⌘ + K أو أيقونة البحث) في الأقسام والمحادثات والمشاريع.
 * الاتجاه بخصائص منطقية (start/end) فقط، فيصحّ في RTL وLTR معًا.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Folder,
  FolderKanban,
  Gauge,
  Library,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Puzzle,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { useI18n } from "@/lib/i18n";
import { activeModuleId, railModules, type PlatformModuleId } from "@/lib/platform/modules";
import { SettingsNav, SettingsSearchInput, SettingsSearchProvider } from "@/components/settings/settings-search";
import { ShellProvider, useShell } from "./shell-context";
import { QuickSearch } from "./quick-search";

export interface ConversationItem {
  id: string;
  title: string;
  updated_at: string;
}

export interface ProjectItem {
  id: string;
  name: string;
}

interface AppShellProps {
  userName: string;
  tier: string;
  conversations: ConversationItem[];
  projects?: ProjectItem[];
  isAdmin?: boolean;
  children: React.ReactNode;
}

/** أيقونة كل وحدة متاحة — الوحدات المخطَّطة لا تُعرض فلا أيقونة لها هنا */
const MODULE_ICONS: Partial<Record<PlatformModuleId, LucideIcon>> = {
  chat: MessageSquare,
  projects: FolderKanban,
  library: Library,
  extensions: Puzzle,
  settings: Settings,
};

/** محتوى اللوحة لكل وحدة — null: الصفحة بعرضها كاملًا */
type PanelKind = "conversations" | "settings" | null;

function panelFor(id: PlatformModuleId | null): PanelKind {
  if (id === "settings") return "settings";
  // المكتبة والإضافات: فهارس بعرض الصفحة — لا لوحة محادثات تزاحمها
  if (id === "library" || id === "extensions") return null;
  return "conversations";
}

export function AppShell(props: AppShellProps) {
  return (
    <ShellProvider>
      <SettingsSearchProvider>
        <ShellInner {...props} />
      </SettingsSearchProvider>
    </ShellProvider>
  );
}

function ShellInner({ userName, tier, conversations, projects = [], isAdmin, children }: AppShellProps) {
  const { t, dir } = useI18n();
  const { mobileOpen, setMobileOpen } = useShell();
  const router = useRouter();
  const pathname = usePathname();

  const [panelOpen, setPanelOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [groups, setGroups] = useState({ conversations: true, projects: true });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const activeId = activeModuleId(pathname);
  const panel = panelFor(activeId);
  const closeMobile = () => setMobileOpen(false);

  /** Ctrl/⌘ + K يفتح البحث السريع من أي صفحة */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  /**
   * تحميل مسبق عند المرور/التركيز فقط (v0.7.0 RC7): الربط بنيّة المستخدم يعطي
   * الفورية بطلب واحد بدل عشرات حمولات RSC عند دخول القائمة إطار العرض.
   */
  const prefetched = useRef<Set<string>>(new Set());
  const prefetchConversation = useCallback(
    (id: string) => {
      if (prefetched.current.has(id)) return;
      prefetched.current.add(id);
      router.prefetch(`/chat/${id}`);
    },
    [router],
  );

  const ClosePanelIcon = dir === "rtl" ? PanelRightClose : PanelLeftClose;
  const OpenPanelIcon = dir === "rtl" ? PanelRightOpen : PanelLeftOpen;

  return (
    <div className="h-dvh w-full flex overflow-hidden">
      {/* غطاء الجوال */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-30 md:hidden" onClick={closeMobile} aria-hidden="true" />
      )}

      {/* ===== الشريط واللوحة: درج على الجوال، ثابتان على الشاشات الواسعة ===== */}
      <div
        className={`z-40 flex h-full fixed inset-y-0 start-0 md:static transition-transform duration-200
          ${mobileOpen ? "translate-x-0" : dir === "rtl" ? "translate-x-full md:translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <nav
          aria-label={t("mainNavigation")}
          className="w-[52px] shrink-0 flex flex-col items-center gap-1.5 py-3 bg-night"
        >
          {panel && (
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              aria-label={panelOpen ? t("collapseSidebar") : t("expandSidebar")}
              title={panelOpen ? t("collapseSidebar") : t("expandSidebar")}
              aria-expanded={panelOpen}
              aria-controls="shell-panel"
              className="hidden md:flex w-9 h-9 mb-1 items-center justify-center rounded-lg text-ink-faint hover:bg-raised hover:text-ink transition-colors"
            >
              {panelOpen ? <ClosePanelIcon size={17} aria-hidden="true" /> : <OpenPanelIcon size={17} aria-hidden="true" />}
            </button>
          )}
          {railModules("primary").map((m) => (
            <RailLink
              key={m.id}
              href={m.href}
              icon={MODULE_ICONS[m.id] ?? MessageSquare}
              label={t(m.labelKey)}
              active={activeId === m.id}
              onNavigate={closeMobile}
            />
          ))}
          <div className="flex-1" />
          {railModules("secondary").map((m) => (
            <RailLink
              key={m.id}
              href={m.href}
              icon={MODULE_ICONS[m.id] ?? Settings}
              label={t(m.labelKey)}
              active={activeId === m.id}
              onNavigate={closeMobile}
            />
          ))}
          <UserMenu userName={userName} tierLabel={tierLabel} isAdmin={isAdmin} onNavigate={closeMobile} />
        </nav>

        {/* ===== لوحة السياق ===== */}
        {panel && (
          <aside
            id="shell-panel"
            aria-label={panel === "settings" ? t("settings") : t("conversations")}
            className={`${panelOpen ? "md:flex" : "md:hidden"} flex w-[264px] flex-col border-x border-line/50 bg-surface/80 backdrop-blur-xl`}
          >
            <div className="h-14 shrink-0 px-3 flex items-center gap-1">
              <h2 className="flex-1 min-w-0 truncate px-1.5 text-[15px] font-semibold text-ink-strong">
                {panel === "settings" ? t("settings") : t("appName")}
              </h2>
              {panel === "conversations" && (
                <button
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  aria-label={t("quickSearch")}
                  title={`${t("quickSearch")} (Ctrl+K)`}
                  aria-keyshortcuts="Control+K Meta+K"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised hover:text-ink transition-colors"
                >
                  <Search size={16} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={closeMobile}
                aria-label={t("closeSidebar")}
                className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            {panel === "settings" ? (
              <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
                <div className="px-1">
                  <SettingsSearchInput />
                </div>
                <SettingsNav onNavigate={closeMobile} />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-2 pb-3">
                <Link
                  href="/chat"
                  onClick={closeMobile}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-ink hover:bg-raised/70 transition-colors"
                >
                  <SquarePen size={15} aria-hidden="true" className="text-ink-dim shrink-0" />
                  {t("newChat")}
                </Link>

                <PanelGroup
                  id="shell-conversations"
                  title={t("conversations")}
                  open={groups.conversations}
                  onToggle={() => setGroups((g) => ({ ...g, conversations: !g.conversations }))}
                >
                  {conversations.length === 0 && (
                    <div className="px-2.5 py-2 text-[12.5px] text-ink-faint leading-relaxed whitespace-pre-line">
                      {t("noConversations")}
                    </div>
                  )}
                  {conversations.map((c) => {
                    const active = pathname === `/chat/${c.id}`;
                    if (editingId === c.id) {
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
                            aria-label={t("conversationTitleLabel")}
                            className="bg-transparent w-full text-[13px] text-ink-strong focus:outline-none py-1"
                          />
                          <button type="submit" aria-label={t("saveTitle")} className="p-1 text-primary-glow hover:brightness-125">
                            <Check size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            aria-label={t("cancelRename")}
                            className="p-1 text-ink-faint hover:text-ink"
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </form>
                      );
                    }
                    return (
                      <div
                        key={c.id}
                        className={`group flex items-center rounded-lg transition-colors ${
                          active ? "bg-raised text-ink-strong" : "text-ink hover:bg-raised/60"
                        }`}
                      >
                        <Link
                          href={`/chat/${c.id}`}
                          prefetch={false}
                          onMouseEnter={() => prefetchConversation(c.id)}
                          onFocus={() => prefetchConversation(c.id)}
                          onTouchStart={() => prefetchConversation(c.id)}
                          onClick={closeMobile}
                          aria-current={active ? "page" : undefined}
                          className="flex-1 min-w-0 px-2.5 py-1.5 text-[13.5px] truncate"
                          title={c.title}
                        >
                          {c.title}
                        </Link>
                        <div className="hidden group-hover:flex group-focus-within:flex items-center pe-1 gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(c.id);
                              setEditValue(c.title);
                            }}
                            aria-label={t("rename")}
                            className="p-1 rounded text-ink-faint hover:text-ink"
                          >
                            <Pencil size={12.5} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteConversation(c.id)}
                            aria-label={t("delete")}
                            className="p-1 rounded text-ink-faint hover:text-red-400"
                          >
                            <Trash2 size={12.5} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </PanelGroup>

                <PanelGroup
                  id="shell-projects"
                  title={t("projects")}
                  open={groups.projects}
                  onToggle={() => setGroups((g) => ({ ...g, projects: !g.projects }))}
                >
                  {projects.length === 0 && (
                    <div className="px-2.5 py-2 text-[12.5px] text-ink-faint">{t("noProjectsShort")}</div>
                  )}
                  {projects.map((p) => {
                    const active = pathname === `/projects/${p.id}`;
                    return (
                      <Link
                        key={p.id}
                        href={`/projects/${p.id}`}
                        onClick={closeMobile}
                        aria-current={active ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors ${
                          active ? "bg-raised text-ink-strong" : "text-ink hover:bg-raised/60"
                        }`}
                        title={p.name}
                      >
                        <Folder size={14} aria-hidden="true" className="text-ink-dim shrink-0" />
                        <span className="truncate">{p.name}</span>
                      </Link>
                    );
                  })}
                </PanelGroup>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* ===== المحتوى ===== */}
      <main className="flex-1 flex flex-col min-w-0">{children}</main>

      <QuickSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        conversations={conversations}
        projects={projects}
      />
    </div>
  );
}

function RailLink({
  href,
  icon: Icon,
  label,
  active,
  onNavigate,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
        active ? "bg-raised text-ink-strong" : "text-ink-faint hover:bg-raised/70 hover:text-ink"
      }`}
    >
      <Icon size={18} aria-hidden="true" />
    </Link>
  );
}

/**
 * قائمة الحساب: زرٌّ يكشف لوحةً صغيرة (نمط الإفصاح لا role="menu" — التنقّل فيها بـTab
 * كأي روابط). تُغلق بـEsc أو بالنقر خارجها أو بالانتقال.
 */
function UserMenu({
  userName,
  tierLabel,
  isAdmin,
  onNavigate,
}: {
  userName: string;
  tierLabel: string;
  isAdmin?: boolean;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = () => {
    setOpen(false);
    onNavigate();
  };

  const items: { href: string; icon: LucideIcon; label: string }[] = [
    { href: "/account", icon: UserRound, label: t("account") },
    { href: "/usage", icon: Gauge, label: t("usageTitle") },
    ...(isAdmin ? [{ href: "/admin", icon: ShieldCheck, label: t("adminPanel") }] : []),
  ];

  return (
    <div ref={rootRef} className="relative mt-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("userMenu")}
        aria-expanded={open}
        aria-controls="shell-user-menu"
        className="w-8 h-8 rounded-full bg-raised border border-line flex items-center justify-center text-[12px] font-semibold text-ink-strong hover:border-ink-faint transition-colors"
      >
        {userName.slice(0, 1) || "؟"}
      </button>
      {open && (
        <div
          id="shell-user-menu"
          className="absolute bottom-0 start-full ms-2 z-50 w-60 rounded-xl border border-line bg-surface/95 backdrop-blur-xl shadow-2xl p-1.5"
        >
          <div className="px-2.5 py-2 mb-1 border-b border-line/60">
            <div className="text-[13px] text-ink-strong truncate">{userName}</div>
            <div className="text-[11px] text-ink-faint">{tierLabel}</div>
          </div>
          {items.map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              onClick={go}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-ink hover:bg-raised transition-colors"
            >
              <Icon size={15} aria-hidden="true" className="text-ink-dim shrink-0" />
              {label}
            </Link>
          ))}
          <div className="my-1 border-t border-line/60" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] text-ink hover:bg-raised hover:text-red-400 transition-colors"
            >
              <LogOut size={15} aria-hidden="true" className="shrink-0" />
              {t("logout")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function PanelGroup({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="group w-full flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-ink-faint hover:text-ink-dim"
      >
        <span>{title}</span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition ${open ? "" : "-rotate-90 rtl:rotate-90"}`}
        />
      </button>
      <div id={id} hidden={!open} className="mt-0.5 space-y-px">
        {children}
      </div>
    </section>
  );
}

/** زر فتح الشريط على الجوال — يُستخدم في رؤوس الصفحات */
export function MobileMenuButton() {
  const { mobileOpen, setMobileOpen } = useShell();
  const { t } = useI18n();
  return (
    <button
      onClick={() => setMobileOpen(true)}
      aria-label={t("openSidebar")}
      aria-expanded={mobileOpen}
      className="md:hidden w-8 h-8 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised transition-colors"
    >
      <Menu size={17} />
    </button>
  );
}

export { LogoMark };
