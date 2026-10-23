"use client";

/**
 * ملفات المشروع داخل صفحة المشروع:
 *   - رفع مباشر إلى المشروع؛
 *   - «إضافة من المكتبة»: ربط ملفٍ موجود بالمشروع عبر PATCH القائم (`files.project_id`)
 *     بلا رفعٍ ثانٍ ولا نسخة — الملكية يتحقق منها الخادم على الطرفين؛
 *   - «إزالة من المشروع» تفكّ الربط وحده والملف يبقى في المكتبة، و«حذف الملف» شيءٌ آخر
 *     يطلب تأكيدًا؛
 *   - فتح/تنزيل برابطٍ موقّت.
 * الملف ينتمي إلى مشروعٍ واحد في المخطّط الحالي، فإضافته هنا تنقله من مشروعه السابق
 * — ويُقال ذلك صراحةً قبل الاختيار.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FolderInput, Loader2, Plus, Search, Trash2, Unlink, Upload, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { filterFiles, sortFiles } from "@/lib/files/library";
import { formatBytes, uploadWithProgress, type UploadedFileRow } from "./upload";
import { FileName, FileTypeIcon, openSignedFile } from "./file-ui";

export function ProjectFiles({
  projectId,
  initialFiles,
}: {
  projectId: string;
  initialFiles: UploadedFileRow[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [files, setFiles] = useState(initialFiles);
  const [progress, setProgress] = useState<number | null>(null);
  const [abortFn, setAbortFn] = useState<(() => void) | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  function startUpload(file: File) {
    setError(null);
    setProgress(0);
    const handle = uploadWithProgress({ file, projectId, onProgress: setProgress });
    setAbortFn(() => handle.abort);
    void handle.done.then((res) => {
      setProgress(null);
      setAbortFn(null);
      if (res.ok && res.file) {
        const row = res.file;
        setFiles((prev) => [row, ...prev.filter((x) => x.id !== row.id)]);
        setNotice(t("fileUploaded"));
        router.refresh();
      } else if (res.error && res.error !== "aborted") {
        setError(res.error === "network" ? t("loadError") : res.error);
      }
    });
  }

  async function api(path: string, method: string, body?: unknown) {
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

  /** يفكّ الربط فقط — لا DELETE ولا مساس بالتخزين */
  async function removeFromProject(f: UploadedFileRow) {
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "PATCH", { projectId: null });
    setBusyId(null);
    if (!ok) return;
    setFiles((prev) => prev.filter((x) => x.id !== f.id));
    setError(null);
    setNotice(t("fileUnlinked"));
    router.refresh();
  }

  async function remove(f: UploadedFileRow) {
    if (!window.confirm(t("confirmDeleteFile"))) return;
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "DELETE");
    setBusyId(null);
    if (!ok) return;
    setFiles((prev) => prev.filter((x) => x.id !== f.id));
    setError(null);
    setNotice(t("fileDeleted"));
    router.refresh();
  }

  async function addExisting(f: UploadedFileRow) {
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "PATCH", { projectId });
    setBusyId(null);
    if (!ok) return;
    setFiles((prev) => [{ ...f, project_id: projectId }, ...prev.filter((x) => x.id !== f.id)]);
    setError(null);
    setNotice(t("fileLinked"));
    router.refresh();
  }

  async function open(f: UploadedFileRow) {
    setBusyId(f.id);
    const ok = await openSignedFile(f.id);
    setBusyId(null);
    if (!ok) setError(t("loadError"));
  }

  const iconBtn = "p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-raised transition-colors disabled:opacity-50";

  return (
    <section aria-labelledby="project-files-title" className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 id="project-files-title" className="text-[14px] font-semibold text-ink-strong">
          {t("projectFiles")} <span className="text-ink-faint font-normal">({files.length})</span>
        </h2>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          aria-expanded={picking}
          aria-controls="project-library-picker"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors"
        >
          <FolderInput size={14} aria-hidden="true" />
          {t("addFromLibrary")}
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={progress !== null}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised transition-colors disabled:opacity-50"
        >
          <Upload size={14} aria-hidden="true" />
          {t("uploadToProject")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) startUpload(f);
            e.target.value = "";
          }}
        />
      </div>

      {picking && (
        <LibraryPicker
          projectId={projectId}
          excludeIds={files.map((f) => f.id)}
          busyId={busyId}
          onPick={(f) => void addExisting(f)}
          onClose={() => setPicking(false)}
        />
      )}

      {progress !== null && (
        <div className="flex items-center gap-3 rounded-lg border border-line/60 bg-surface/50 px-3 py-2">
          <Loader2 size={13} aria-hidden="true" className="animate-spin text-primary-glow" />
          <div className="flex-1 h-1 rounded-full bg-raised overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-primary-glow/80 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-[11px] text-ink-faint tabular-nums" dir="ltr">
            {progress}%
          </span>
          {abortFn && (
            <button type="button" onClick={abortFn} aria-label={t("cancelUpload")} className="p-1 text-ink-faint hover:text-red-400">
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <p role="status" aria-live="polite" className={notice ? "flex items-center gap-2 text-[12.5px] text-emerald-400" : "sr-only"}>
        {notice && <Check size={13} aria-hidden="true" />}
        {notice}
      </p>
      {error && (
        <p role="alert" className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {files.length === 0 && progress === null ? (
        <p className="text-[12.5px] text-ink-faint py-1">{t("libraryEmpty")}</p>
      ) : (
        <ul className="rounded-xl border border-line/60 bg-surface/40 divide-y divide-line/50">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2.5 px-3 py-2">
              <FileTypeIcon mime={f.mime_type} name={f.original_name} size={14} />
              <button
                type="button"
                onClick={() => void open(f)}
                disabled={busyId === f.id}
                className="min-w-0 flex-1 truncate text-start text-[13px] text-ink hover:text-primary-glow transition-colors"
                aria-label={`${t("openFile")}: ${f.original_name}`}
              >
                <FileName name={f.original_name} />
              </button>
              <span className="hidden sm:inline text-[11px] text-ink-faint shrink-0" dir="ltr">
                {formatBytes(f.size_bytes, locale)}
              </span>
              <button
                type="button"
                onClick={() => void removeFromProject(f)}
                disabled={busyId === f.id}
                aria-label={`${t("removeFromProject")}: ${f.original_name}`}
                title={t("removeFromProject")}
                className={iconBtn}
              >
                <Unlink size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void remove(f)}
                disabled={busyId === f.id}
                aria-label={`${t("deleteFile")}: ${f.original_name}`}
                title={t("deleteFile")}
                className={`${iconBtn} hover:text-red-400`}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * اختيار ملفٍ موجود من مكتبة المستخدم. القائمة من GET /api/files (مقيّدة بالمستخدم
 * على الخادم وبـRLS)، وتُستثنى ملفات هذا المشروع. لا شيء يُرفع ولا يُنسخ.
 */
function LibraryPicker({
  projectId,
  excludeIds,
  busyId,
  onPick,
  onClose,
}: {
  projectId: string;
  excludeIds: string[];
  busyId: string | null;
  onPick: (f: UploadedFileRow) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [all, setAll] = useState<UploadedFileRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch("/api/files")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { files?: UploadedFileRow[] } | null) => {
        if (!alive) return;
        if (j?.files) setAll(j.files);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo(() => {
    if (!all) return [];
    const excluded = new Set(excludeIds);
    const rest = all.filter((f) => !excluded.has(f.id) && f.project_id !== projectId);
    return sortFiles(filterFiles(rest, { query, kind: "all" }), "newest", locale);
  }, [all, excludeIds, projectId, query, locale]);

  return (
    <div id="project-library-picker" className="rounded-xl border border-line/70 bg-surface/70 backdrop-blur-xl p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex-1 min-w-0 flex items-center gap-2 rounded-lg bg-raised/70 border border-line/70 px-2.5 py-1.5 focus-within:border-primary">
          <Search size={13} aria-hidden="true" className="text-ink-faint shrink-0" />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("searchFiles")}
            aria-label={t("searchFiles")}
            className="bg-transparent w-full min-w-0 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </label>
        <button type="button" onClick={onClose} aria-label={t("close")} className="p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-raised">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {failed ? (
        <p role="alert" className="px-1 text-[12.5px] text-red-300">
          {t("loadError")}
        </p>
      ) : all === null ? (
        <p role="status" className="px-1 text-[12.5px] text-ink-faint">
          <Loader2 size={12} aria-hidden="true" className="inline animate-spin" /> {t("loading")}
        </p>
      ) : candidates.length === 0 ? (
        <p className="px-1 text-[12.5px] text-ink-faint">{query ? t("libraryNoMatch") : t("addFromLibraryEmpty")}</p>
      ) : (
        <ul className="max-h-64 overflow-y-auto">
          {candidates.slice(0, 100).map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onPick(f)}
                disabled={busyId === f.id}
                className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-start hover:bg-raised transition-colors disabled:opacity-50"
              >
                <FileTypeIcon mime={f.mime_type} name={f.original_name} size={14} />
                <span className="min-w-0 flex-1">
                  <FileName name={f.original_name} className="block truncate text-[13px] text-ink" />
                  {f.project_id && <span className="block text-[11px] text-amber-400/90">{t("inOtherProject")}</span>}
                </span>
                {busyId === f.id ? (
                  <Loader2 size={13} aria-hidden="true" className="animate-spin text-ink-faint" />
                ) : (
                  <Plus size={14} aria-hidden="true" className="text-ink-faint" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
