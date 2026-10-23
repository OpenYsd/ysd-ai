"use client";

/**
 * قائمة المشاريع: بحث (يطابق العربية بلا تشكيل ولا اختلاف الألف)، فرز، إنشاء —
 * بيانات حقيقية من قاعدة البيانات، صفوفٌ في سطحٍ واحد لا بطاقة لكل مشروع.
 */

import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Folder, MessageSquare, Plus, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { normalizeForSearch } from "@/lib/platform/search";
import { MobileMenuButton } from "@/components/shell/app-shell";

export interface ProjectListItem {
  id: string;
  name: string;
  description: string | null;
  lastActivityAt: string;
  conversationsCount: number;
  filesCount: number;
}

interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
}

export function ProjectsView({
  projects,
  models,
  loadFailed,
}: {
  projects: ProjectListItem[];
  models: ModelOption[];
  loadFailed?: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelId, setModelId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useDeferredValue(search);
  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    const list = projects.filter(
      (p) =>
        !q ||
        normalizeForSearch(p.name).includes(q) ||
        normalizeForSearch(p.description ?? "").includes(q),
    );
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, locale === "ar" ? "ar" : "en")
        : b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }, [projects, query, sort, locale]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          customInstructions: instructions.trim() || undefined,
          defaultModelId: modelId || undefined,
        }),
      });
      const j = (await res.json().catch(() => null)) as
        | { project?: { id: string }; error?: string }
        | null;
      if (!res.ok || !j?.project) throw new Error(j?.error);
      router.push(`/projects/${j.project.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message || t("loadError"));
      setCreating(false);
    }
  }

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("projects")}</h1>
        <div className="flex-1" />
        {/* بلا مشاريع: زرّ الإنشاء في حالة الفراغ وحده — لا زرّان لفعلٍ واحد */}
        {(projects.length > 0 || showCreate) && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            aria-expanded={showCreate}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white bg-primary hover:bg-primary-deep transition-colors"
          >
            {showCreate ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {t("newProject")}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[860px] mx-auto space-y-4">
          {/* نموذج الإنشاء */}
          {showCreate && (
            <form
              onSubmit={createProject}
              className="rise rounded-2xl border border-primary/40 bg-surface/70 p-5 space-y-3"
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder={t("projectName")}
                className="w-full rounded-xl bg-raised border border-line px-3.5 py-2.5 text-[13.5px] text-ink-strong placeholder-ink-faint focus:outline-none focus:border-primary"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                placeholder={t("projectDescription")}
                className="w-full rounded-xl bg-raised border border-line px-3.5 py-2.5 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:border-primary"
              />
              <div>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder={t("customInstructions")}
                  className="w-full rounded-xl bg-raised border border-line px-3.5 py-2.5 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:border-primary resize-y"
                />
                <p className="text-[11px] text-ink-faint mt-1">{t("customInstructionsHint")}</p>
              </div>
              {models.length > 0 && (
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="rounded-xl bg-raised border border-line px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-primary"
                >
                  <option value="">
                    {t("defaultModel")}: {t("none")}
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {locale === "ar" ? m.nameAr : m.nameEn}
                    </option>
                  ))}
                </select>
              )}
              {error && <p className="text-[12.5px] text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3.5 py-2 rounded-xl text-[13px] text-ink-dim hover:bg-raised transition-colors"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || creating}
                  className="px-4 py-2 rounded-xl text-[13px] font-medium text-white disabled:opacity-50 transition-all hover:brightness-110"
                  style={{ background: "rgb(var(--c-primary))" }}
                >
                  {creating ? t("creating") : t("save")}
                </button>
              </div>
            </form>
          )}

          {/* البحث والفرز — يظهران حين توجد مشاريع يُبحث فيها */}
          {projects.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg bg-raised/70 border border-line/70 px-3 py-2 focus-within:border-primary">
                <Search size={14} aria-hidden="true" className="text-ink-faint shrink-0" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("searchProjects")}
                  aria-label={t("searchProjects")}
                  className="bg-transparent w-full min-w-0 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
                />
              </label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "recent" | "name")}
                aria-label={t("sortBy")}
                className="rounded-lg bg-raised/70 border border-line/70 px-2.5 py-1.5 text-[12.5px] text-ink focus:outline-none focus:border-primary"
              >
                <option value="recent">{t("sortRecent")}</option>
                <option value="name">{t("sortName")}</option>
              </select>
            </div>
          )}

          {/* حالات الخطأ والفراغ */}
          {loadFailed && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
              <span>{t("loadError")}</span>
              <button type="button" onClick={() => router.refresh()} className="shrink-0 underline underline-offset-2">
                {t("retry")}
              </button>
            </div>
          )}
          {!loadFailed && filtered.length === 0 && (
            <div className="text-center py-14">
              <p className="text-[14px] text-ink-dim">{projects.length === 0 ? t("noProjectsShort") : t("projectsNoMatch")}</p>
              {projects.length === 0 && !showCreate && (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-raised transition-colors"
                >
                  <Plus size={14} aria-hidden="true" />
                  {t("newProject")}
                </button>
              )}
            </div>
          )}

          {/* القائمة: سطحٌ واحد بصفوف */}
          {filtered.length > 0 && (
            <ul className="rounded-2xl border border-line/60 bg-surface/40 divide-y divide-line/50">
              {filtered.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="flex items-start gap-3 px-3 sm:px-4 py-3 hover:bg-raised/40 transition-colors"
                  >
                    <Folder size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-dim" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-ink-strong">
                        <bdi>{p.name}</bdi>
                      </span>
                      {p.description && (
                        <span className="block truncate text-[12px] text-ink-dim">
                          <bdi>{p.description}</bdi>
                        </span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-faint">
                        <span className="inline-flex items-center gap-1">
                          <MessageSquare size={11} aria-hidden="true" />
                          {p.conversationsCount} {t("conversationsCount")}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <FileText size={11} aria-hidden="true" />
                          {p.filesCount} {t("filesCount")}
                        </span>
                        <span>{formatRelative(p.lastActivityAt, locale)}</span>
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
