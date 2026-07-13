"use client";

/**
 * صفحة الملفات: سحب وإفلات، تقدم رفع حقيقي مع إلغاء، حالات المعالجة،
 * بحث/فرز/تصفية، ربط بمشروع، حذف، إعادة معالجة، عداد التخزين.
 * كل البيانات حقيقية من قاعدة البيانات — لا Mock.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { formatBytes, uploadWithProgress, type UploadedFileRow } from "./upload";

interface ProjectLite {
  id: string;
  name: string;
}

interface FilesViewProps {
  initialFiles: UploadedFileRow[];
  projects: ProjectLite[];
  usage: { count: number; bytes: number };
  limits: { maxFileMb: number; maxFiles: number; maxStorageMb: number };
  loadFailed?: boolean;
}

interface UploadingItem {
  key: string;
  name: string;
  progress: number;
  error?: string;
  abort: () => void;
}

export function FilesView({
  initialFiles,
  projects,
  usage,
  limits,
  loadFailed,
}: FilesViewProps) {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [files, setFiles] = useState<UploadedFileRow[]>(initialFiles);
  const [uploading, setUploading] = useState<UploadingItem[]>([]);
  const [usedBytes, setUsedBytes] = useState(usage.bytes);
  const [usedCount, setUsedCount] = useState(usage.count);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "document" | "image">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startUploads = useCallback(
    (list: FileList | File[]) => {
      setError(null);
      for (const file of Array.from(list)) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const handle = uploadWithProgress({
          file,
          onProgress: (p) =>
            setUploading((prev) =>
              prev.map((u) => (u.key === key ? { ...u, progress: p } : u)),
            ),
        });
        setUploading((prev) => [
          ...prev,
          { key, name: file.name, progress: 0, abort: handle.abort },
        ]);
        void handle.done.then((res) => {
          setUploading((prev) => prev.filter((u) => u.key !== key));
          if (res.ok && res.file) {
            setFiles((prev) => [res.file as UploadedFileRow, ...prev]);
            setUsedBytes((b) => b + (res.file?.size_bytes ?? 0));
            setUsedCount((c) => c + 1);
            router.refresh();
          } else if (res.error && res.error !== "aborted") {
            setError(res.error === "network" ? t("loadError") : res.error);
          }
        });
      }
    },
    [router, t],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter((f) => {
      if (q && !f.original_name.toLowerCase().includes(q)) return false;
      if (typeFilter === "image" && !f.mime_type.startsWith("image/")) return false;
      if (typeFilter === "document" && f.mime_type.startsWith("image/")) return false;
      if (statusFilter !== "all" && f.status !== statusFilter) return false;
      if (projectFilter === "none" && f.project_id !== null) return false;
      if (projectFilter !== "all" && projectFilter !== "none" && f.project_id !== projectFilter)
        return false;
      return true;
    });
  }, [files, search, typeFilter, statusFilter, projectFilter]);

  async function api(path: string, method: string, body?: unknown) {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? t("loadError"));
      return null;
    }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async function removeFile(f: UploadedFileRow) {
    if (!window.confirm(t("confirmDeleteFile"))) return;
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "DELETE");
    setBusyId(null);
    if (ok) {
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      setUsedBytes((b) => Math.max(0, b - f.size_bytes));
      setUsedCount((c) => Math.max(0, c - 1));
      router.refresh();
    }
  }

  async function retryProcess(f: UploadedFileRow) {
    setBusyId(f.id);
    const res = await api(`/api/files/${f.id}/process`, "POST");
    setBusyId(null);
    if (res?.file) {
      setFiles((prev) =>
        prev.map((x) => (x.id === f.id ? (res.file as UploadedFileRow) : x)),
      );
    }
  }

  async function linkProject(f: UploadedFileRow, projectId: string | null) {
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "PATCH", { projectId });
    setBusyId(null);
    if (ok) {
      setFiles((prev) =>
        prev.map((x) => (x.id === f.id ? { ...x, project_id: projectId } : x)),
      );
      router.refresh();
    }
  }

  async function download(f: UploadedFileRow) {
    const res = await api(`/api/files/${f.id}/download`, "GET");
    const url = res?.url as string | undefined;
    if (url) window.open(url, "_blank", "noopener");
  }

  const storagePct = Math.min(
    100,
    (usedBytes / (limits.maxStorageMb * 1024 * 1024)) * 100,
  );

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("files")}</h1>
        <div className="flex-1" />
        <div className="hidden sm:flex items-center gap-2 text-[11.5px] text-ink-faint">
          <span>
            {usedCount} / {limits.maxFiles}
          </span>
          <span>·</span>
          <span dir="ltr">
            {formatBytes(usedBytes, locale)} / {limits.maxStorageMb}MB
          </span>
          <div className="w-20 h-1.5 rounded-full bg-raised overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${storagePct}%`,
                background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)",
              }}
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <div className="max-w-[860px] mx-auto space-y-4">
          {/* منطقة الرفع */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
            }}
            className={`rounded-2xl border-2 border-dashed px-5 py-8 text-center transition-colors ${
              dragOver ? "border-primary bg-primary/10" : "border-line bg-surface/50"
            }`}
          >
            <Upload size={22} className="mx-auto mb-2 text-primary-glow" />
            <p className="text-[13px] text-ink-dim">
              {t("dropFilesHere")}{" "}
              <button
                onClick={() => inputRef.current?.click()}
                className="text-primary-glow hover:brightness-125 font-medium"
              >
                {t("chooseFiles")}
              </button>
            </p>
            <p className="text-[11px] text-ink-faint mt-1.5">
              {t("allowedTypesHint")} — {limits.maxFileMb}MB
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) startUploads(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {/* عمليات رفع جارية */}
          {uploading.map((u) => (
            <div
              key={u.key}
              className="rise rounded-xl border border-primary/40 bg-surface/70 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <Loader2 size={14} className="animate-spin text-primary-glow shrink-0" />
                <span className="text-[13px] text-ink truncate flex-1">{u.name}</span>
                <span className="text-[11.5px] text-ink-faint" dir="ltr">
                  {u.progress}%
                </span>
                <button
                  onClick={u.abort}
                  title={t("cancelUpload")}
                  className="p-1 rounded text-ink-faint hover:text-red-400"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-raised overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${u.progress}%`,
                    background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)",
                  }}
                />
              </div>
            </div>
          ))}

          {/* البحث والتصفية */}
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex items-center gap-2 rounded-xl bg-raised border border-line px-3 py-2 flex-1">
              <Search size={13} className="text-ink-faint shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchFiles")}
                className="bg-transparent w-full text-[13px] text-ink placeholder-ink-faint focus:outline-none"
              />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink focus:outline-none focus:border-primary"
            >
              <option value="all">{t("allTypes")}</option>
              <option value="document">{t("documents")}</option>
              <option value="image">{t("images")}</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink focus:outline-none focus:border-primary"
            >
              <option value="all">{t("allStatuses")}</option>
              <option value="ready">{t("statusReady")}</option>
              <option value="processing">{t("statusProcessing")}</option>
              <option value="failed">{t("statusFailed")}</option>
            </select>
            {projects.length > 0 && (
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="rounded-xl bg-raised border border-line px-3 py-2 text-[12.5px] text-ink focus:outline-none focus:border-primary"
              >
                <option value="all">{t("allProjects")}</option>
                <option value="none">{t("noProject")}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* أخطاء */}
          {(error || loadFailed) && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300 flex items-center justify-between gap-3">
              <span>{error ?? t("loadError")}</span>
              <button onClick={() => setError(null)} className="shrink-0 p-1 hover:text-red-200">
                <X size={13} />
              </button>
            </div>
          )}

          {/* الفراغ */}
          {filtered.length === 0 && uploading.length === 0 && (
            <div className="text-center py-14">
              <FileText size={38} className="mx-auto mb-4 text-ink-faint opacity-60" />
              <p className="text-[13.5px] text-ink-dim whitespace-pre-line leading-relaxed">
                {search || typeFilter !== "all" || statusFilter !== "all" ? "—" : t("noFiles")}
              </p>
            </div>
          )}

          {/* القائمة */}
          <div className="space-y-2">
            {filtered.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                projects={projects}
                busy={busyId === f.id}
                onDelete={() => void removeFile(f)}
                onRetry={() => void retryProcess(f)}
                onLinkProject={(pid) => void linkProject(f, pid)}
                onDownload={() => void download(f)}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function FileRow({
  file,
  projects,
  busy,
  onDelete,
  onRetry,
  onLinkProject,
  onDownload,
}: {
  file: UploadedFileRow;
  projects: ProjectLite[];
  busy: boolean;
  onDelete: () => void;
  onRetry: () => void;
  onLinkProject: (projectId: string | null) => void;
  onDownload: () => void;
}) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isImage = file.mime_type.startsWith("image/");
  const extractedChars = (file.metadata?.extracted_chars as number | undefined) ?? 0;

  const statusBadge =
    file.status === "ready"
      ? { label: t("statusReady"), cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" }
      : file.status === "processing"
        ? { label: t("statusProcessing"), cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" }
        : file.status === "failed"
          ? { label: t("statusFailed"), cls: "bg-red-500/15 text-red-400 border-red-500/30" }
          : { label: t("statusUploaded"), cls: "bg-raised text-ink-faint border-line" };

  return (
    <div className="rise rounded-xl border border-line/70 bg-surface/60 hover:border-primary/30 transition-colors">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-start"
      >
        <span className="shrink-0 text-primary-glow">
          {isImage ? <ImageIcon size={16} /> : <FileText size={16} />}
        </span>
        <span className="text-[13px] text-ink-strong truncate flex-1" dir="ltr">
          {file.original_name}
        </span>
        <span
          className={`shrink-0 text-[10.5px] px-1.5 py-0.5 rounded-md border ${statusBadge.cls}`}
        >
          {statusBadge.label}
        </span>
        <span className="hidden sm:block shrink-0 text-[11px] text-ink-faint" dir="ltr">
          {formatBytes(file.size_bytes, locale)}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-3.5 border-t border-line/50 pt-3 space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
            <span dir="ltr">{file.mime_type}</span>
            <span dir="ltr">{formatBytes(file.size_bytes, locale)}</span>
            <span>{formatRelative(file.created_at, locale)}</span>
            <span>
              {file.status === "ready" && !isImage
                ? `${extractedChars.toLocaleString(locale === "ar" ? "ar-EG" : "en-US")} ${t("extractedChars")}`
                : isImage
                  ? t("noTextExtracted")
                  : null}
            </span>
          </div>

          {file.extraction_error && (
            <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {file.extraction_error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onDownload}
              disabled={busy}
              className="text-[12px] px-2.5 py-1.5 rounded-lg text-ink bg-raised border border-line hover:border-primary/40 transition-colors disabled:opacity-50"
            >
              {t("download")}
            </button>
            {file.status === "failed" && (
              <button
                onClick={onRetry}
                disabled={busy}
                className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-lg text-ink bg-raised border border-line hover:border-primary/40 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={11} />
                {t("retryProcess")}
              </button>
            )}
            {projects.length > 0 && (
              <span className="flex items-center gap-1.5">
                <Link2 size={12} className="text-ink-faint" />
                <select
                  value={file.project_id ?? ""}
                  onChange={(e) => onLinkProject(e.target.value || null)}
                  disabled={busy}
                  className="rounded-lg bg-raised border border-line px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:border-primary disabled:opacity-50"
                >
                  <option value="">{t("noProject")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </span>
            )}
            <div className="flex-1" />
            <button
              onClick={onDelete}
              disabled={busy}
              className="flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-lg text-red-400/80 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={11} />
              {t("deleteFile")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
