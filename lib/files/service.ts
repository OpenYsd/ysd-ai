/**
 * خدمات نظام الملفات المشتركة بين المسارات:
 * الحدود حسب الباقة، الاستهلاك الفعلي، ومعالجة الاستخراج.
 * كل شيء عبر عميل جلسة المستخدم — RLS نافذ دائمًا، بلا service role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractText, MAX_EXTRACTED_CHARS } from "./extract";
import { effectiveFileLimitMb, STORAGE_PROVIDER_MAX_FILE_MB } from "./config";

export const FILES_BUCKET = "files";

export interface FileLimits {
  tier: string;
  /** الحد الفعلي = min(حد الباقة, سقف مزود التخزين) */
  maxFileMb: number;
  /** حد الباقة التجاري (قد يكون أعلى من سقف المزود) */
  planMaxFileMb: number;
  /** هل سقف المزود هو المقيّد؟ (لعرض رسالة واضحة للمستخدم) */
  providerLimited: boolean;
  maxFiles: number;
  maxStorageMb: number;
}

/** حدود الملفات من الإعداد المركزي (usage_limits) مع افتراضات آمنة */
export async function getFileLimits(
  supabase: SupabaseClient,
  userId: string,
): Promise<FileLimits> {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("tier")
    .eq("user_id", userId)
    .maybeSingle();
  const tier = (sub?.tier as string | undefined) ?? "free";

  const { data: limits } = await supabase
    .from("usage_limits")
    .select("max_file_mb, max_files, max_storage_mb")
    .eq("tier", tier)
    .maybeSingle();

  const planMaxFileMb = (limits?.max_file_mb as number | undefined) ?? 10;
  return {
    tier,
    maxFileMb: effectiveFileLimitMb(planMaxFileMb),
    planMaxFileMb,
    providerLimited: planMaxFileMb > STORAGE_PROVIDER_MAX_FILE_MB,
    maxFiles: (limits?.max_files as number | undefined) ?? 50,
    maxStorageMb: (limits?.max_storage_mb as number | undefined) ?? 200,
  };
}

export interface FileUsage {
  count: number;
  bytes: number;
}

/** الاستهلاك الفعلي: عدد الملفات غير المحذوفة ومجموع أحجامها */
export async function getFileUsage(
  supabase: SupabaseClient,
  userId: string,
): Promise<FileUsage> {
  const { data } = await supabase
    .from("files")
    .select("size_bytes")
    .eq("user_id", userId)
    .is("deleted_at", null);
  const rows = data ?? [];
  return {
    count: rows.length,
    bytes: rows.reduce((acc, r) => acc + ((r.size_bytes as number) ?? 0), 0),
  };
}

interface ProcessableRow {
  id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
}

/** هل هذا النوع صورة؟ (لا استخراج نص في هذه المرحلة) */
export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/**
 * معالجة ملف: تنزيل من التخزين → استخراج النص → تحديث الحالة.
 * لا ادعاء نجاح عند فشل الاستخراج أو نص فارغ — status = failed مع السبب.
 */
export async function processFile(
  supabase: SupabaseClient,
  row: ProcessableRow,
): Promise<{ status: "ready" | "failed"; error?: string }> {
  const now = () => new Date().toISOString();

  if (isImageMime(row.mime_type)) {
    // الصور: تخزين وعرض فقط في هذه المرحلة — بلا OCR
    await supabase
      .from("files")
      .update({ status: "ready", extraction_error: null, updated_at: now() })
      .eq("id", row.id);
    return { status: "ready" };
  }

  await supabase
    .from("files")
    .update({ status: "processing", updated_at: now() })
    .eq("id", row.id);

  const { data: blob, error: dlError } = await supabase.storage
    .from(FILES_BUCKET)
    .download(row.storage_path);

  if (dlError || !blob) {
    const msg = "تعذّر قراءة الملف من التخزين لإجراء المعالجة.";
    await supabase
      .from("files")
      .update({ status: "failed", extraction_error: msg, updated_at: now() })
      .eq("id", row.id);
    return { status: "failed", error: msg };
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  const result = await extractText(row.mime_type, row.original_name, buffer);

  if (!result.ok) {
    await supabase
      .from("files")
      .update({ status: "failed", extraction_error: result.error, updated_at: now() })
      .eq("id", row.id);
    return { status: "failed", error: result.error };
  }

  const text = result.text.slice(0, MAX_EXTRACTED_CHARS);
  await supabase
    .from("files")
    .update({
      status: "ready",
      extracted_text: text,
      extraction_error: null,
      metadata: { ...(result.meta ?? {}), extracted_chars: text.length },
      updated_at: now(),
    })
    .eq("id", row.id);
  return { status: "ready" };
}

/** الحقول الآمنة للإرجاع للواجهة — بلا storage_path */
export const PUBLIC_FILE_FIELDS =
  "id, original_name, mime_type, size_bytes, status, project_id, conversation_id, extraction_error, metadata, created_at, updated_at";
