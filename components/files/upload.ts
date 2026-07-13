"use client";

/** رفع ملف عبر XHR — تقدم حقيقي + إمكانية الإلغاء (fetch لا يدعم تقدم الرفع) */

export interface UploadedFileRow {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  project_id: string | null;
  conversation_id: string | null;
  extraction_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UploadHandle {
  abort: () => void;
  done: Promise<{ ok: boolean; file?: UploadedFileRow; error?: string }>;
}

export function uploadWithProgress(opts: {
  file: File;
  projectId?: string | null;
  conversationId?: string | null;
  onProgress?: (percent: number) => void;
}): UploadHandle {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append("file", opts.file);
  if (opts.projectId) form.append("projectId", opts.projectId);
  if (opts.conversationId) form.append("conversationId", opts.conversationId);

  const done = new Promise<{ ok: boolean; file?: UploadedFileRow; error?: string }>(
    (resolve) => {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && opts.onProgress) {
          opts.onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText) as {
            file?: UploadedFileRow;
            error?: string;
          };
          if (xhr.status === 201 && body.file) resolve({ ok: true, file: body.file });
          else resolve({ ok: false, error: body.error ?? `HTTP ${xhr.status}` });
        } catch {
          resolve({ ok: false, error: `HTTP ${xhr.status}` });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: "network" });
      xhr.onabort = () => resolve({ ok: false, error: "aborted" });
      xhr.open("POST", "/api/files/upload");
      xhr.send(form);
    },
  );

  return { abort: () => xhr.abort(), done };
}

export function formatBytes(bytes: number, locale: "ar" | "en"): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = v.toLocaleString(locale === "ar" ? "ar-EG" : "en-US", {
    maximumFractionDigits: 1,
  });
  return `${num} ${units[i]}`;
}
