"use client";

/** قائمة المشاريع: بحث، فرز، إنشاء، بيانات حقيقية من قاعدة البيانات */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, FolderKanban, MessageSquare, Plus, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = projects.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
    return [...list].sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, locale === "ar" ? "ar" : "en")
        : b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }, [projects, search, sort, locale]);

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
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-medium text-white transition-all hover:brightness-110"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          {showCreate ? <X size={14} /> : <Plus size={14} />}
          {t("newProject")}
        </button>
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
                  style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
                >
                  {creating ? t("creating") : t("save")}
                </button>
              </div>
            </form>
          )}

          {/* البحث والفرز */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 flex-1">
              <Search size={13} className="text-ink-faint shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchProjects")}
                className="bg-transparent w-full text-[13px] text-ink placeholder-ink-faint focus:outline-none"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "recent" | "name")}
              className="rounded-xl bg-raised border border-line px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-primary"
            >
              <option value="recent">{t("sortRecent")}</option>
              <option value="name">{t("sortName")}</option>
            </select>
          </div>

          {/* حالات الخطأ والفراغ */}
          {loadFailed && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
              {t("loadError")}
            </div>
          )}
          {!loadFailed && filtered.length === 0 && (
            <div className="text-center py-16">
              <FolderKanban size={40} className="mx-auto mb-4 text-ink-faint opacity-60" />
              <p className="text-[13.5px] text-ink-dim whitespace-pre-line leading-relaxed">
                {search ? "—" : t("noProjects")}
              </p>
            </div>
          )}

          {/* البطاقات */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="rise rounded-2xl border border-line/70 bg-surface/60 p-4 hover:border-primary/40 hover:bg-raised/60 transition-all block"
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 text-primary-glow shrink-0">
                    <FolderKanban size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-ink-strong truncate">
                      {p.name}
                    </div>
                    {p.description && (
                      <div className="text-[12px] text-ink-dim mt-0.5 line-clamp-2 leading-relaxed">
                        {p.description}
                      </div>
                    )}
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-2.5 text-[11.5px] text-ink-faint">
                      <span className="flex items-center gap-1">
                        <MessageSquare size={11} />
                        {p.conversationsCount} {t("conversationsCount")}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileText size={11} />
                        {p.filesCount} {t("filesCount")}
                      </span>
                      <span>
                        {t("lastActivity")}: {formatRelative(p.lastActivityAt, locale)}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
