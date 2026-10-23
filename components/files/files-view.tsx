"use client";

/**
 * المكتبة: ملفات المستخدم الحقيقية من قاعدة البيانات — لا Mock.
 *
 *   - رفع (زرّ واحد أو سحب وإفلات) بتقدّم حقيقي وإلغاء؛
 *   - بحث بالاسم يطابق العربية والإنجليزية، وتصفية بالنوع والحالة والمشروع، وفرز
 *     بالتاريخ والاسم والحجم — كلها على القائمة المحمّلة (محدودة بـ300 من الخادم)،
 *     فلا طلب مع كل حرف، ولا يُرى إلا ما أعاده الخادم لصاحبه؛
 *   - معاينة الصور، وفتح PDF في لسانٍ جديد، وتنزيل ما سواهما — بروابط موقّتة؛
 *   - إعادة تسمية، ربط بمشروع، استخدام في محادثة، تجهيز للذكاء الاصطناعي، حذف؛
 *   - إعلانٌ مسموع لكل نجاح وفشل.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Loader2, MessageSquarePlus, Pencil, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { MobileMenuButton } from "@/components/shell/app-shell";
import {
  fileExtension,
  fileKind,
  filterFiles,
  previewMode,
  sortFiles,
  splitFileName,
  validateRename,
  type FileKindFilter,
  type FileSort,
} from "@/lib/files/library";
import { formatBytes, uploadWithProgress, type UploadedFileRow } from "./upload";
import { FileName, FileTypeIcon, ImagePreview, openSignedFile } from "./file-ui";

interface ProjectLite {
  id: string;
  name: string;
}

interface FilesViewProps {
  initialFiles: UploadedFileRow[];
  projects: ProjectLite[];
  usage: { count: number; bytes: number };
  limits: {
    maxFileMb: number;
    maxFiles: number;
    maxStorageMb: number;
    providerLimited?: boolean;
  };
  loadFailed?: boolean;
}

interface UploadingItem {
  key: string;
  name: string;
  progress: number;
  abort: () => void;
}

type StatusFilter = "all" | "ready" | "processing" | "failed";

/** الحالات الفعلية في القاعدة مجمّعةً كما يفهمها المستخدم */
const STATUS_GROUPS: Record<Exclude<StatusFilter, "all">, readonly string[]> = {
  ready: ["ready", "ready_for_rag"],
  processing: ["uploading", "uploaded", "processing", "chunking", "embedding"],
  failed: ["failed", "rag_failed"],
};

const KINDS: readonly FileKindFilter[] = ["all", "pdf", "word", "text", "image"];
const PAGE_SIZE = 50;

export function FilesView({ initialFiles, projects, usage, limits, loadFailed }: FilesViewProps) {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [files, setFiles] = useState<UploadedFileRow[]>(initialFiles);
  const [uploading, setUploading] = useState<UploadingItem[]>([]);
  const [usedBytes, setUsedBytes] = useState(usage.bytes);
  const [usedCount, setUsedCount] = useState(usage.count);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<FileKindFilter>("all");
  const [sort, setSort] = useState<FileSort>("newest");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // البحث محلّي: التأجيل يُبقي الكتابة سلسة ولا يرسل شيئًا إلى الخادم
  const query = useDeferredValue(search);

  /** ملفٌ يشير إلى مشروعٍ غير موجود في قائمة المستخدم يُعامَل «بلا مشروع» */
  const projectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const projectOf = useCallback(
    (f: UploadedFileRow) => (f.project_id && projectIds.has(f.project_id) ? f.project_id : null),
    [projectIds],
  );

  const visible = useMemo(() => {
    const byStatus =
      statusFilter === "all" ? files : files.filter((f) => STATUS_GROUPS[statusFilter].includes(f.status));
    const byProject =
      projectFilter === "all"
        ? byStatus
        : byStatus.filter((f) => (projectFilter === "none" ? projectOf(f) === null : projectOf(f) === projectFilter));
    return sortFiles(filterFiles(byProject, { query, kind }), sort, locale);
  }, [files, query, kind, sort, statusFilter, projectFilter, projectOf, locale]);

  useEffect(() => setLimit(PAGE_SIZE), [query, kind, sort, statusFilter, projectFilter]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const announce = (msg: string) => {
    setError(null);
    setNotice(msg);
  };

  const startUploads = useCallback(
    (list: FileList | File[]) => {
      setError(null);
      for (const file of Array.from(list)) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const handle = uploadWithProgress({
          file,
          onProgress: (p) => setUploading((prev) => prev.map((u) => (u.key === key ? { ...u, progress: p } : u))),
        });
        setUploading((prev) => [...prev, { key, name: file.name, progress: 0, abort: handle.abort }]);
        void handle.done.then((res) => {
          setUploading((prev) => prev.filter((u) => u.key !== key));
          if (res.ok && res.file) {
            const row = res.file;
            setFiles((prev) => [row, ...prev.filter((x) => x.id !== row.id)]);
            if (!res.reused) {
              setUsedBytes((b) => b + (row.size_bytes ?? 0));
              setUsedCount((c) => c + 1);
            }
            setNotice(t("fileUploaded"));
            router.refresh();
          } else if (res.error && res.error !== "aborted") {
            setError(res.error === "network" ? t("loadError") : res.error);
          }
        });
      }
    },
    [router, t],
  );

  /** طلبٌ إلى API الملفات — الخطأ يُعرض ولا تُمسّ البيانات المعروضة */
  async function api(path: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      const j = (await res?.json().catch(() => null)) as { error?: string } | null;
      setNotice(null);
      setError(j?.error ?? t("loadError"));
      return null;
    }
    return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  }

  async function removeFile(f: UploadedFileRow) {
    if (!window.confirm(t("confirmDeleteFile"))) return;
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "DELETE");
    setBusyId(null);
    if (!ok) return;
    setFiles((prev) => prev.filter((x) => x.id !== f.id));
    setUsedBytes((b) => Math.max(0, b - f.size_bytes));
    setUsedCount((c) => Math.max(0, c - 1));
    setExpandedId(null);
    announce(t("fileDeleted"));
    router.refresh();
  }

  async function renameFile(f: UploadedFileRow, name: string): Promise<boolean> {
    setBusyId(f.id);
    const res = await api(`/api/files/${f.id}`, "PATCH", { name });
    setBusyId(null);
    if (!res) return false;
    const saved = typeof res.name === "string" ? res.name : name;
    setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, original_name: saved } : x)));
    announce(t("renameSaved"));
    return true;
  }

  async function linkProject(f: UploadedFileRow, projectId: string | null) {
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "PATCH", { projectId });
    setBusyId(null);
    if (!ok) return;
    setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, project_id: projectId } : x)));
    announce(projectId ? t("fileLinked") : t("fileUnlinked"));
    router.refresh();
  }

  /**
   * استخدام ملف في محادثة جديدة: إنشاء محادثة (في مشروع الملف إن وُجد) ثم ربط الملف
   * بها عبر PATCH القائم — بلا رفعٍ ثانٍ. يُعرض فقط لملفٍ غير مرتبط بمحادثة، لأن الملف
   * يرتبط بمحادثةٍ واحدة في المخطّط، وربطه بأخرى ينزعه من الأولى بصمت.
   * إن فشل الربط تُحذف المحادثة الفارغة التي أُنشئت للتوّ.
   */
  async function startChatWithFile(f: UploadedFileRow) {
    setBusyId(f.id);
    setError(null);
    const project = projectOf(f);
    const created = await api("/api/conversations", "POST", {
      title: f.original_name.slice(0, 120),
      ...(project ? { projectId: project } : {}),
    });
    const conversationId = (created?.conversation as { id?: string } | undefined)?.id;
    if (!conversationId) {
      setBusyId(null);
      return;
    }
    const linked = await api(`/api/files/${f.id}`, "PATCH", { conversationId });
    if (!linked) {
      await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" }).catch(() => null);
      setBusyId(null);
      return;
    }
    setBusyId(null);
    router.push(`/chat/${conversationId}`);
    router.refresh();
  }

  async function openFile(f: UploadedFileRow) {
    setBusyId(f.id);
    const ok = await openSignedFile(f.id);
    setBusyId(null);
    if (!ok) setError(t("loadError"));
  }

  async function retryProcess(f: UploadedFileRow) {
    setBusyId(f.id);
    const res = await api(`/api/files/${f.id}/process`, "POST");
    setBusyId(null);
    if (res?.file) setFiles((prev) => prev.map((x) => (x.id === f.id ? (res.file as UploadedFileRow) : x)));
  }

  /** إلغاء تجهيز جارٍ */
  async function cancelRag(f: UploadedFileRow) {
    setBusyId(f.id);
    const res = await api(`/api/files/${f.id}/rag/cancel`, "POST");
    setBusyId(null);
    if (res) {
      const fresh = await fetch(`/api/files/${f.id}`).catch(() => null);
      if (fresh?.ok) {
        const j = (await fresh.json()) as { file?: UploadedFileRow };
        if (j.file) setFiles((prev) => prev.map((x) => (x.id === f.id ? j.file! : x)));
      }
    }
  }

  /** تجهيز الملف للذكاء الاصطناعي — مع استطلاع التقدم الحقيقي */
  async function prepareRag(f: UploadedFileRow) {
    setBusyId(f.id);
    const prepare = fetch(`/api/files/${f.id}/rag`, { method: "POST" });
    const poll = (async () => {
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const res = await fetch(`/api/files/${f.id}`).catch(() => null);
        if (!res?.ok) return;
        const j = (await res.json()) as { file?: UploadedFileRow };
        if (!j.file) return;
        setFiles((prev) => prev.map((x) => (x.id === f.id ? j.file! : x)));
        if (!["chunking", "embedding"].includes(j.file.status)) return;
      }
    })();
    const res = await prepare.catch(() => null);
    const body = (await res?.json().catch(() => null)) as { file?: UploadedFileRow; error?: string } | null;
    await poll;
    setBusyId(null);
    if (body?.file) setFiles((prev) => prev.map((x) => (x.id === f.id ? body.file! : x)));
    if (!res?.ok) setError(body?.error ?? t("loadError"));
  }

  const storagePct = Math.min(100, (usedBytes / (limits.maxStorageMb * 1024 * 1024)) * 100);
  const filtering =
    query.trim() !== "" || kind !== "all" || statusFilter !== "all" || projectFilter !== "all";
  const kindLabel: Record<FileKindFilter, string> = {
    all: t("kindAll"),
    pdf: t("kindPdf"),
    word: t("kindWord"),
    text: t("kindText"),
    image: t("images"),
  };
  const selectCls =
    "rounded-lg bg-raised/70 border border-line/70 px-2.5 py-1.5 text-[12.5px] text-ink focus:outline-none focus:border-primary";

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <h1 className="text-[15px] font-semibold text-ink-strong">{t("moduleLibrary")}</h1>
        <div className="flex-1" />
        <div className="hidden sm:flex items-center gap-2 text-[11.5px] text-ink-faint" aria-label={t("storageUsage")}>
          <span dir="ltr">
            {usedCount} / {limits.maxFiles}
          </span>
          <span aria-hidden="true">·</span>
          <span dir="ltr">
            {formatBytes(usedBytes, locale)} / {limits.maxStorageMb}MB
          </span>
          <div className="w-16 h-1 rounded-full bg-raised overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-primary-glow/80" style={{ width: `${storagePct}%` }} />
          </div>
        </div>
        {/* مكتبة فارغة: زرّ الاختيار في حالة الفراغ وحده — لا زرّان لفعلٍ واحد */}
        {(files.length > 0 || uploading.length > 0 || loadFailed) && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-white bg-primary hover:bg-primary-deep transition-colors"
          >
            <Upload size={14} aria-hidden="true" />
            {t("uploadFiles")}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files?.length) startUploads(e.target.files);
            e.target.value = "";
          }}
        />
      </header>

      <div
        className="relative flex-1 overflow-y-auto px-4 md:px-6 py-5"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
        }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-primary-glow/70 bg-night/70 backdrop-blur-sm">
            <Upload size={22} aria-hidden="true" className="text-primary-glow" />
            <span className="text-[13px] text-ink-strong">{t("uploadFiles")}</span>
            <span className="text-[11.5px] text-ink-faint" dir="ltr">
              {t("allowedTypesHint")} — {limits.maxFileMb}MB
            </span>
          </div>
        )}

        <div className="max-w-[860px] mx-auto space-y-3">
          {/* البحث والترتيب */}
          <div className="flex items-center gap-2">
            <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg bg-raised/70 border border-line/70 px-3 py-2 focus-within:border-primary">
              <Search size={14} aria-hidden="true" className="text-ink-faint shrink-0" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchFiles")}
                aria-label={t("searchFiles")}
                className="bg-transparent w-full min-w-0 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as FileSort)}
              aria-label={t("sortBy")}
              className={selectCls}
            >
              <option value="newest">{t("sortNewest")}</option>
              <option value="oldest">{t("sortOldest")}</option>
              <option value="name">{t("sortName")}</option>
              <option value="size">{t("sortSize")}</option>
            </select>
          </div>

          {/* النوع، ثم الحالة والمشروع */}
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t("fileType")} className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  aria-pressed={kind === k}
                  className={`rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                    kind === k ? "bg-raised text-ink-strong" : "text-ink-dim hover:text-ink hover:bg-raised/60"
                  }`}
                >
                  {kindLabel[k]}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label={t("fileStatus")}
              className={selectCls}
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
                aria-label={t("filterByProject")}
                className={`${selectCls} max-w-[11rem]`}
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

          {/* الإعلانات: نجاحٌ مهذّب، وخطأٌ عاجل */}
          <p role="status" aria-live="polite" className={notice ? "flex items-center gap-2 text-[12.5px] text-emerald-400" : "sr-only"}>
            {notice && <Check size={13} aria-hidden="true" />}
            {notice}
          </p>
          {(error || loadFailed) && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300"
            >
              <span className="min-w-0">{error ?? t("loadError")}</span>
              {error ? (
                <button
                  type="button"
                  onClick={() => setError(null)}
                  aria-label={t("dismissError")}
                  className="shrink-0 p-1 hover:text-red-200"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : (
                <button type="button" onClick={() => router.refresh()} className="shrink-0 underline underline-offset-2">
                  {t("retry")}
                </button>
              )}
            </div>
          )}

          {/* عمليات رفع جارية */}
          {uploading.length > 0 && (
            <ul className="space-y-1.5">
              {uploading.map((u) => (
                <li key={u.key} className="rounded-lg border border-line/60 bg-surface/50 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <Loader2 size={14} aria-hidden="true" className="animate-spin text-primary-glow shrink-0" />
                    <FileName name={u.name} className="text-[13px] text-ink truncate flex-1" />
                    <span className="text-[11.5px] text-ink-faint tabular-nums" dir="ltr">
                      {u.progress}%
                    </span>
                    <button
                      type="button"
                      onClick={u.abort}
                      aria-label={`${t("cancelUpload")}: ${u.name}`}
                      className="p-1 rounded text-ink-faint hover:text-red-400"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-1.5 h-1 rounded-full bg-raised overflow-hidden" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary-glow/80 transition-all" style={{ width: `${u.progress}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* الفراغ */}
          {!loadFailed && visible.length === 0 && uploading.length === 0 && (
            <div className="py-14 text-center">
              {files.length === 0 ? (
                <>
                  <p className="text-[14px] text-ink-dim">{t("libraryEmpty")}</p>
                  <p className="mt-1 text-[11.5px] text-ink-faint" dir="ltr">
                    {t("allowedTypesHint")} — {limits.maxFileMb}MB
                  </p>
                  {limits.providerLimited && <p className="mt-1 text-[11px] text-amber-400/90">{t("providerLimitNote")}</p>}
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-raised transition-colors"
                  >
                    <Upload size={14} aria-hidden="true" />
                    {t("chooseFiles")}
                  </button>
                </>
              ) : (
                <p className="text-[13.5px] text-ink-dim">{filtering ? t("libraryNoMatch") : t("libraryEmpty")}</p>
              )}
            </div>
          )}

          {/* القائمة: سطحٌ واحد بصفوفٍ مفصولة، لا بطاقة لكل ملف */}
          {visible.length > 0 && (
            <ul className="rounded-2xl border border-line/60 bg-surface/40 divide-y divide-line/50">
              {visible.slice(0, limit).map((f) => (
                <FileRow
                  key={f.id}
                  file={f}
                  projectId={projectOf(f)}
                  projects={projects}
                  expanded={expandedId === f.id}
                  busy={busyId === f.id}
                  onToggle={() => setExpandedId((cur) => (cur === f.id ? null : f.id))}
                  onDelete={() => void removeFile(f)}
                  onRename={(name) => renameFile(f, name)}
                  onRetry={() => void retryProcess(f)}
                  onPrepareRag={() => void prepareRag(f)}
                  onCancelRag={() => void cancelRag(f)}
                  onLinkProject={(pid) => void linkProject(f, pid)}
                  onOpen={() => void openFile(f)}
                  onUseInChat={() => void startChatWithFile(f)}
                />
              ))}
            </ul>
          )}
          {visible.length > limit && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE_SIZE)}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-dim hover:text-ink hover:bg-raised transition-colors"
              >
                {t("showMore")} ({visible.length - limit})
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function FileRow({
  file,
  projectId,
  projects,
  expanded,
  busy,
  onToggle,
  onDelete,
  onRename,
  onRetry,
  onPrepareRag,
  onCancelRag,
  onLinkProject,
  onOpen,
  onUseInChat,
}: {
  file: UploadedFileRow;
  projectId: string | null;
  projects: ProjectLite[];
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRetry: () => void;
  onPrepareRag: () => void;
  onCancelRag: () => void;
  onLinkProject: (projectId: string | null) => void;
  onOpen: () => void;
  onUseInChat: () => void;
}) {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [stem, setStem] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const kind = fileKind(file.mime_type, file.original_name);
  const isImage = kind === "image";
  const mode = previewMode(file.mime_type);
  const ext = fileExtension(file.original_name).toUpperCase();
  const detailsId = `file-details-${file.id}`;

  const ragProcessing = file.status === "chunking" || file.status === "embedding";
  const ragPct =
    ragProcessing && file.rag_total_chunks
      ? Math.round(((file.rag_done_chunks ?? 0) / file.rag_total_chunks) * 100)
      : null;

  const statusBadge =
    file.status === "ready_for_rag"
      ? { label: t("ragReady"), cls: "text-emerald-400" }
      : file.status === "rag_failed"
        ? { label: t("ragFailed"), cls: "text-red-400" }
        : ragProcessing
          ? { label: `${t("ragPreparing")}${ragPct !== null ? ` ${ragPct}%` : "…"}`, cls: "text-amber-400" }
          : file.status === "ready"
            ? { label: isImage ? t("statusReady") : t("textExtracted"), cls: "text-ink-dim" }
            : file.status === "processing"
              ? { label: t("statusProcessing"), cls: "text-amber-400" }
              : file.status === "failed"
                ? { label: t("statusFailed"), cls: "text-red-400" }
                : { label: t("statusUploaded"), cls: "text-ink-faint" };

  function startRename() {
    setStem(splitFileName(file.original_name).stem);
    setRenameError(null);
    setRenaming(true);
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!stem.trim()) {
      setRenameError(t("renameEmpty"));
      return;
    }
    const requested = `${stem.trim()}${splitFileName(file.original_name).ext}`;
    const check = validateRename(file.original_name, requested);
    if (!check.ok) {
      if (check.reason === "unchanged") setRenaming(false);
      else setRenameError(check.reason === "extension" ? t("renameExtension") : t("renameEmpty"));
      return;
    }
    if (await onRename(check.name)) setRenaming(false);
  }

  const actionCls =
    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors disabled:opacity-50";

  return (
    <li>
      <div className="flex items-center gap-3 px-3 sm:px-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="flex-1 min-w-0 flex items-center gap-3 py-2.5 text-start"
        >
          <FileTypeIcon mime={file.mime_type} name={file.original_name} />
          <span className="min-w-0 flex-1">
            <FileName name={file.original_name} className="block truncate text-[13.5px] text-ink-strong" />
            <span className="block truncate text-[11.5px] text-ink-faint">
              {ext && <span dir="ltr">{ext}</span>}
              {ext && " · "}
              <span dir="ltr">{formatBytes(file.size_bytes, locale)}</span>
              {" · "}
              {formatRelative(file.created_at, locale)}
              {/* على الشاشات الضيقة: الحالة في سطر التفاصيل كي لا تزاحم الاسم */}
              <span className={`sm:hidden ${statusBadge.cls}`}> · {statusBadge.label}</span>
            </span>
          </span>
        </button>
        <span className={`hidden sm:block shrink-0 text-[11px] ${statusBadge.cls}`}>{statusBadge.label}</span>
      </div>

      {expanded && (
        <div id={detailsId} className="px-3 sm:px-4 pb-3.5 pt-1 space-y-3">
          {mode === "image" && <ImagePreview fileId={file.id} name={file.original_name} />}

          {file.extraction_error && (
            <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {file.extraction_error}
            </p>
          )}
          {file.rag_error && file.status === "rag_failed" && (
            <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {file.rag_error}
            </p>
          )}

          {renaming ? (
            <form onSubmit={(e) => void submitRename(e)} className="flex flex-wrap items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center rounded-lg border border-primary/50 bg-raised px-2.5">
                <input
                  autoFocus
                  value={stem}
                  onChange={(e) => {
                    setStem(e.target.value);
                    setRenameError(null);
                  }}
                  onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
                  aria-label={t("fileName")}
                  aria-invalid={renameError ? true : undefined}
                  maxLength={120}
                  dir="auto"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-ink-strong focus:outline-none"
                />
                <span className="shrink-0 text-[12.5px] text-ink-faint" dir="ltr">
                  {splitFileName(file.original_name).ext}
                </span>
              </span>
              <button type="submit" disabled={busy} className={actionCls}>
                <Check size={13} aria-hidden="true" />
                {t("save")}
              </button>
              <button type="button" onClick={() => setRenaming(false)} className={actionCls}>
                {t("cancel")}
              </button>
              {renameError && (
                <p role="alert" className="basis-full text-[12px] text-red-400">
                  {renameError}
                </p>
              )}
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={onOpen} disabled={busy} className={actionCls}>
                {mode === "download" ? t("download") : t("openFile")}
              </button>
              <button type="button" onClick={startRename} disabled={busy} className={actionCls}>
                <Pencil size={12.5} aria-hidden="true" />
                {t("rename")}
              </button>
              {!isImage &&
                (file.conversation_id ? (
                  <Link href={`/chat/${file.conversation_id}`} className={actionCls}>
                    <MessageSquarePlus size={13} aria-hidden="true" />
                    {t("openConversation")}
                  </Link>
                ) : (
                  !["failed", "deleted"].includes(file.status) && (
                    <button type="button" onClick={onUseInChat} disabled={busy} className={actionCls}>
                      <MessageSquarePlus size={13} aria-hidden="true" />
                      {t("useInChat")}
                    </button>
                  )
                ))}
              {file.status === "failed" && (
                <button type="button" onClick={onRetry} disabled={busy} className={actionCls}>
                  <RefreshCw size={12} aria-hidden="true" />
                  {t("retryProcess")}
                </button>
              )}
              {!isImage && ["ready", "rag_failed", "ready_for_rag"].includes(file.status) && (
                <button type="button" onClick={onPrepareRag} disabled={busy} className={actionCls}>
                  {busy ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <RefreshCw size={12} aria-hidden="true" />}
                  {file.status === "ready" ? t("ragPrepare") : t("ragRetry")}
                </button>
              )}
              {ragProcessing && (
                <button type="button" onClick={onCancelRag} disabled={busy} className={actionCls}>
                  {t("cancel")}
                </button>
              )}
              {projects.length > 0 && (
                <select
                  value={projectId ?? ""}
                  onChange={(e) => onLinkProject(e.target.value || null)}
                  disabled={busy}
                  aria-label={t("fileProject")}
                  className="max-w-[11rem] rounded-lg bg-raised/70 border border-line/70 px-2 py-1.5 text-[12.5px] text-ink focus:outline-none focus:border-primary disabled:opacity-50"
                >
                  <option value="">{t("noProject")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-red-400/90 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                <Trash2 size={12.5} aria-hidden="true" />
                {t("deleteFile")}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
