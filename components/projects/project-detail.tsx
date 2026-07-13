"use client";

/**
 * تفاصيل المشروع: تعديل الاسم/الوصف/التعليمات/النموذج،
 * محادثات المشروع، إنشاء محادثة داخله، ربط/فك ربط محادثات، حذف ناعم.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Link2,
  MessageSquare,
  Plus,
  Trash2,
  Unlink,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { ProjectFiles } from "@/components/files/project-files";
import type { UploadedFileRow } from "@/components/files/upload";

interface ConversationLite {
  id: string;
  title: string;
  updated_at?: string;
}

interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
}

interface ProjectDetailProps {
  project: {
    id: string;
    name: string;
    description: string | null;
    customInstructions: string | null;
    defaultModelId: string | null;
    lastActivityAt: string;
  };
  linkedConversations: ConversationLite[];
  unlinkedConversations: ConversationLite[];
  models: ModelOption[];
  files: UploadedFileRow[];
}

export function ProjectDetail({
  project,
  linkedConversations,
  unlinkedConversations,
  models,
  files,
}: ProjectDetailProps) {
  const { t, locale, dir } = useI18n();
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.customInstructions ?? "");
  const [modelId, setModelId] = useState(project.defaultModelId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkPick, setLinkPick] = useState("");

  async function call(path: string, method: string, body?: unknown): Promise<boolean> {
    setError(null);
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? t("loadError"));
      return false;
    }
    return true;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    const ok = await call(`/api/projects/${project.id}`, "PATCH", {
      name: name.trim(),
      description: description.trim(),
      customInstructions: instructions.trim(),
      defaultModelId: modelId || null,
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    }
  }

  async function removeProject() {
    if (!window.confirm(t("confirmDeleteProject"))) return;
    setBusy(true);
    const ok = await call(`/api/projects/${project.id}`, "DELETE");
    setBusy(false);
    if (ok) {
      router.push("/projects");
      router.refresh();
    }
  }

  async function newChatInProject() {
    setBusy(true);
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    setBusy(false);
    const j = (await res.json().catch(() => null)) as
      | { conversation?: { id: string }; error?: string }
      | null;
    if (!res.ok || !j?.conversation) {
      setError(j?.error ?? t("loadError"));
      return;
    }
    router.push(`/chat/${j.conversation.id}`);
    router.refresh();
  }

  async function linkConversation() {
    if (!linkPick) return;
    setBusy(true);
    const ok = await call(`/api/conversations/${linkPick}`, "PATCH", {
      projectId: project.id,
    });
    setBusy(false);
    setLinkPick("");
    if (ok) router.refresh();
  }

  async function unlinkConversation(id: string) {
    setBusy(true);
    const ok = await call(`/api/conversations/${id}`, "PATCH", { projectId: null });
    setBusy(false);
    if (ok) router.refresh();
  }

  const BackIcon = ArrowRight;

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <Link
          href="/projects"
          title={t("backToProjects")}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-dim hover:bg-raised transition-colors"
        >
          <BackIcon size={16} style={{ transform: dir === "ltr" ? "scaleX(-1)" : undefined }} />
        </Link>
        <h1 className="text-[15px] font-semibold text-ink-strong truncate">{project.name}</h1>
        {saved && <span className="text-[12px] text-emerald-400">{t("saved")}</span>}
        <div className="flex-1" />
        <span className="hidden sm:block text-[12px] text-ink-faint">
          {t("lastActivity")}: {formatRelative(project.lastActivityAt, locale)}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[720px] mx-auto space-y-5">
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
              {error}
            </div>
          )}

          {/* إعدادات المشروع */}
          <form onSubmit={save} className="rounded-2xl border border-line bg-surface/60 p-5 space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder={t("projectName")}
              className="w-full rounded-xl bg-raised border border-line px-3.5 py-2.5 text-[14px] font-medium text-ink-strong placeholder-ink-faint focus:outline-none focus:border-primary"
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
                rows={4}
                placeholder={t("customInstructions")}
                className="w-full rounded-xl bg-raised border border-line px-3.5 py-2.5 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:border-primary resize-y"
              />
              <p className="text-[11px] text-ink-faint mt-1">{t("customInstructionsHint")}</p>
            </div>
            {models.length > 0 && (
              <div>
                <label className="block text-[12px] text-ink-dim mb-1.5">{t("defaultModel")}</label>
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="rounded-xl bg-raised border border-line px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-primary"
                >
                  <option value="">{t("none")}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {locale === "ar" ? m.nameAr : m.nameEn}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => void removeProject()}
                disabled={busy}
                className="flex items-center gap-1.5 text-[12.5px] px-3 py-2 rounded-xl text-red-400/80 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                <Trash2 size={13} />
                {t("deleteProject")}
              </button>
              <button
                type="submit"
                disabled={!name.trim() || saving}
                className="px-4 py-2 rounded-xl text-[13px] font-medium text-white disabled:opacity-50 transition-all hover:brightness-110"
                style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
              >
                {t("save")}
              </button>
            </div>
          </form>

          {/* محادثات المشروع */}
          <section className="rounded-2xl border border-line bg-surface/60 p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-[13px] font-medium text-ink-strong">
                {t("conversations")} ({linkedConversations.length})
              </h2>
              <button
                onClick={() => void newChatInProject()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
              >
                <Plus size={13} />
                {t("chatInProject")}
              </button>
            </div>

            {/* ربط محادثة موجودة */}
            {unlinkedConversations.length > 0 && (
              <div className="flex gap-2">
                <select
                  value={linkPick}
                  onChange={(e) => setLinkPick(e.target.value)}
                  className="flex-1 min-w-0 rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink focus:outline-none focus:border-primary"
                >
                  <option value="">{t("linkConversation")}</option>
                  {unlinkedConversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void linkConversation()}
                  disabled={!linkPick || busy}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12.5px] text-ink bg-raised border border-line hover:border-primary/40 transition-colors disabled:opacity-50"
                >
                  <Link2 size={13} />
                  {t("save")}
                </button>
              </div>
            )}

            {linkedConversations.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint py-3 text-center">
                {t("noProjectConversations")}
              </p>
            ) : (
              <div className="space-y-0.5">
                {linkedConversations.map((c) => (
                  <div
                    key={c.id}
                    className="group flex items-center rounded-lg hover:bg-raised/60 transition-colors"
                  >
                    <Link
                      href={`/chat/${c.id}`}
                      className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5"
                    >
                      <MessageSquare size={13} className="text-ink-faint shrink-0" />
                      <span className="text-[13px] text-ink truncate">{c.title}</span>
                      {c.updated_at && (
                        <span className="text-[11px] text-ink-faint shrink-0 ms-auto">
                          {formatRelative(c.updated_at, locale)}
                        </span>
                      )}
                    </Link>
                    <button
                      onClick={() => void unlinkConversation(c.id)}
                      disabled={busy}
                      title={t("unlink")}
                      className="opacity-0 group-hover:opacity-100 p-1.5 me-1.5 rounded text-ink-faint hover:text-red-400 transition-all disabled:opacity-50"
                    >
                      <Unlink size={12.5} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ملفات المشروع */}
          <ProjectFiles projectId={project.id} initialFiles={files} />
        </div>
      </div>
    </>
  );
}
