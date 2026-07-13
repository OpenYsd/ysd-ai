"use client";

/** ملفات المشروع داخل صفحة المشروع: رفع مباشر، فك ربط، حذف، تنزيل */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatBytes, uploadWithProgress, type UploadedFileRow } from "./upload";

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
  const inputRef = useRef<HTMLInputElement>(null);

  function startUpload(file: File) {
    setError(null);
    setProgress(0);
    const handle = uploadWithProgress({
      file,
      projectId,
      onProgress: setProgress,
    });
    setAbortFn(() => handle.abort);
    void handle.done.then((res) => {
      setProgress(null);
      setAbortFn(null);
      if (res.ok && res.file) {
        setFiles((prev) => [res.file as UploadedFileRow, ...prev]);
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
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? t("loadError"));
      return null;
    }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async function unlink(f: UploadedFileRow) {
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "PATCH", { projectId: null });
    setBusyId(null);
    if (ok) {
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      router.refresh();
    }
  }

  async function remove(f: UploadedFileRow) {
    if (!window.confirm(t("confirmDeleteFile"))) return;
    setBusyId(f.id);
    const ok = await api(`/api/files/${f.id}`, "DELETE");
    setBusyId(null);
    if (ok) {
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      router.refresh();
    }
  }

  async function download(f: UploadedFileRow) {
    const res = await api(`/api/files/${f.id}/download`, "GET");
    const url = res?.url as string | undefined;
    if (url) window.open(url, "_blank", "noopener");
  }

  return (
    <section className="rounded-2xl border border-line bg-surface/60 p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[13px] font-medium text-ink-strong">
          {t("projectFiles")} ({files.length})
        </h2>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={progress !== null}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12.5px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
        >
          <Upload size={13} />
          {t("uploadToProject")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) startUpload(f);
            e.target.value = "";
          }}
        />
      </div>

      {progress !== null && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-raised px-3 py-2">
          <Loader2 size={13} className="animate-spin text-primary-glow" />
          <div className="flex-1 h-1.5 rounded-full bg-night overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)",
              }}
            />
          </div>
          <span className="text-[11px] text-ink-faint" dir="ltr">
            {progress}%
          </span>
          {abortFn && (
            <button onClick={abortFn} className="p-1 text-ink-faint hover:text-red-400">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {files.length === 0 && progress === null ? (
        <p className="text-[12.5px] text-ink-faint py-2 text-center">—</p>
      ) : (
        <div className="space-y-0.5">
          {files.map((f) => (
            <div
              key={f.id}
              className="group flex items-center gap-2.5 rounded-lg px-3 py-2 hover:bg-raised/60 transition-colors"
            >
              <span className="text-ink-faint shrink-0">
                {f.mime_type.startsWith("image/") ? (
                  <ImageIcon size={13} />
                ) : (
                  <FileText size={13} />
                )}
              </span>
              <button
                onClick={() => void download(f)}
                className="text-[12.5px] text-ink truncate flex-1 text-start hover:text-primary-glow transition-colors"
                dir="ltr"
                title={t("download")}
              >
                {f.original_name}
              </button>
              <span className="text-[10.5px] text-ink-faint shrink-0" dir="ltr">
                {formatBytes(f.size_bytes, locale)}
              </span>
              <span
                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-md border ${
                  f.status === "ready"
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                    : f.status === "failed"
                      ? "bg-red-500/15 text-red-400 border-red-500/30"
                      : "bg-raised text-ink-faint border-line"
                }`}
              >
                {f.status === "ready"
                  ? t("statusReady")
                  : f.status === "failed"
                    ? t("statusFailed")
                    : t("statusProcessing")}
              </span>
              <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => void unlink(f)}
                  disabled={busyId === f.id}
                  title={t("unlink")}
                  className="p-1 rounded text-ink-faint hover:text-ink disabled:opacity-50"
                >
                  <Unlink size={12} />
                </button>
                <button
                  onClick={() => void remove(f)}
                  disabled={busyId === f.id}
                  title={t("deleteFile")}
                  className="p-1 rounded text-ink-faint hover:text-red-400 disabled:opacity-50"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
