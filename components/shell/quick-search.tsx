"use client";

/**
 * البحث السريع (Ctrl/⌘ + K): الأقسام المتاحة والمحادثات والمشاريع.
 * نمط combobox: التركيز يبقى في الحقل، والأسهم تنقل الاختيار، وEnter يفتح، وEsc يغلق.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderKanban, LayoutGrid, MessageSquare, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { availableModules } from "@/lib/platform/modules";
import { searchItems, type QuickSearchItem } from "@/lib/platform/search";

export function QuickSearch({
  open,
  onClose,
  conversations,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  conversations: readonly { id: string; title: string }[];
  projects: readonly { id: string; name: string }[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  const items = useMemo<QuickSearchItem[]>(
    () => [
      ...availableModules().map((m) => ({ kind: "page" as const, id: m.id, label: t(m.labelKey), href: m.href })),
      ...conversations.map((c) => ({ kind: "conversation" as const, id: c.id, label: c.title, href: `/chat/${c.id}` })),
      ...projects.map((p) => ({ kind: "project" as const, id: p.id, label: p.name, href: `/projects/${p.id}` })),
    ],
    [conversations, projects, t],
  );
  const results = useMemo(() => searchItems(items, query), [items, query]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    return () => returnFocus.current?.focus?.();
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const go = (item: QuickSearchItem) => {
    onClose();
    router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      const item = results[active];
      if (item) {
        e.preventDefault();
        go(item);
      }
    }
  };

  const kindLabel = (k: QuickSearchItem["kind"]) =>
    k === "page" ? t("quickSearchPages") : k === "conversation" ? t("moduleChat") : t("moduleProjects");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("quickSearch")}
        className="relative w-full max-w-lg rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <Search size={15} className="text-ink-faint shrink-0" aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-label={t("quickSearch")}
            placeholder={t("quickSearchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="text-[10.5px] text-ink-faint border border-line rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label={t("quickSearch")} className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li role="presentation" className="px-3 py-6 text-center text-[13px] text-ink-faint">
              {t("quickSearchEmpty")}
            </li>
          ) : (
            results.map((r, i) => {
              const Icon = r.kind === "page" ? LayoutGrid : r.kind === "conversation" ? MessageSquare : FolderKanban;
              return (
                <li
                  key={`${r.kind}-${r.id}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-search-kind={r.kind}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] cursor-pointer ${
                    i === active ? "bg-raised text-ink-strong" : "text-ink-dim"
                  }`}
                >
                  <Icon size={14} className="shrink-0 text-ink-faint" aria-hidden="true" />
                  <span className="flex-1 truncate">{r.label}</span>
                  <span className="text-[10.5px] text-ink-faint">{kindLabel(r.kind)}</span>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
