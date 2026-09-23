/**
 * خدمات نظام الملفات المشتركة بين المسارات:
 * الحدود حسب الباقة، الاستهلاك الفعلي، ومعالجة الاستخراج.
 * كل شيء عبر عميل جلسة المستخدم — RLS نافذ دائمًا، بلا service role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractText, MAX_EXTRACTED_CHARS } from "./extract";
import { effectiveFileLimitMb, STORAGE_PROVIDER_MAX_FILE_MB } from "./config";
import { getActiveSpace } from "../rag/embedding-space";
import { findFilesMissingActiveSpace } from "../rag/space-readiness";

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
  /** البيانات الوصفيّة القائمة (ومنها `client_upload_id`) — تُدمج ولا تُستبدل */
  metadata?: Record<string, unknown> | null;
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
      metadata: { ...(row.metadata ?? {}), ...(result.meta ?? {}), extracted_chars: text.length },
      updated_at: now(),
    })
    .eq("id", row.id);
  return { status: "ready" };
}

/**
 * الحقول الآمنة للإرجاع للواجهة — بلا storage_path
 *
 * ★ ولا `rag_v2_model`: هذه الحقول تُقرأ في الفضاءين، ومسارُ e5 يعمل على
 *   قاعدةٍ بلا الترحيل 0048. و`needs_active_embedding` يُشتقّ من المقاطع
 *   نفسِها (`projectFileForClient`)، لا من هذا الوسم.
 */
export const PUBLIC_FILE_FIELDS =
  "id, original_name, mime_type, size_bytes, status, project_id, conversation_id, extraction_error, metadata, created_at, updated_at, rag_total_chunks, rag_done_chunks, rag_error";

/**
 * ★ `ready_for_rag` لا تعني «قابلٌ للاسترجاع الآن».
 *
 *   الحالةُ في القاعدة تقول: فُهرس الملفُّ في فضاءٍ ما. وحين يتبدّل الفضاءُ
 *   النشِط (e5 ⇄ F2LLM) يبقى ملفٌّ مفهرسًا في الفضاء القديم وحده: حالتُه
 *   `ready_for_rag`، والاسترجاعُ الفعليُّ لا يراه — إذ لا تُخلط ٣٨٤ بُعدًا
 *   بـ٣٢٠ في استعلامٍ واحد.
 *
 *   فلو أخذت الواجهةُ الحالةَ على ظاهرها لأعلنت «جاهز» وفتحت الإرسال، ثمّ
 *   خرج الاسترجاعُ فارغًا ونفى النموذجُ ملفًّا يراه المستخدمُ أمامه: وهو
 *   بعينه «الجاهزُ الكاذب» الذي تمنعه بوّابةُ الإرسال.
 *
 *   فيُشتقُّ هنا — على الخادم وحدَه — علمٌ صريح: هل ينقص هذا الملفَّ تضمينُ
 *   الفضاء النشِط؟ الواجهةُ تعرضه «قيد التجهيز»، والخادمُ يُدرج الوظيفةَ
 *   الصحيحة تلقائيًّا (`ensureActiveSpaceJobs`)، والتضمينُ القديم لا يُمسّ
 *   (عمودان منفصلان)، فإن عاد الفضاءُ الأوّل عاد الملفُّ جاهزًا بلا عمل.
 */
export type ClientFile<T> = Omit<T, "rag_v2_model"> & { needs_active_embedding: boolean };

/**
 * ★ الفجوةُ تُقاس بالمقاطع لا بالوسم وحده — فالاتّجاهان ليسا متماثلين.
 *
 *   `rag_v2_model` يكشف «مفهرسٌ في e5 والفضاءُ اليومَ F2LLM» وحده. والاتّجاهُ
 *   الآخر — مفهرسٌ في نافذة F2LLM والفضاءُ اليومَ e5 — لا وسمَ له، ومقاطعُه
 *   بلا متجهِ e5. ولذلك تُستشار المقاطعُ نفسُها (استعلامٌ واحدٌ للدفعة كلِّها).
 */
function projectOne<T extends Record<string, unknown>>(
  row: T,
  missing: Set<string>,
): ClientFile<T> {
  const { rag_v2_model: _v2Model, ...rest } = row as Record<string, unknown>;
  void _v2Model; // يُقرأ من القاعدة ولا يخرج إلى الواجهة: أسماءُ النماذج داخليّة
  return {
    ...rest,
    needs_active_embedding:
      row.status === "ready_for_rag" && missing.has(row.id as string),
  } as unknown as ClientFile<T>;
}

/** صفٌّ واحد — ما تعيده مسارات `/api/files/:id` و`/upload` و`/rag` */
export async function projectFileForClient<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  row: T | null,
): Promise<ClientFile<T> | null> {
  if (!row) return null;
  return (await projectFilesForClient(supabase, [row]))[0] ?? null;
}

/** دفعةٌ — استعلامُ فجوةٍ واحدٌ لها جميعًا، لا واحدٌ لكلّ صفّ */
export async function projectFilesForClient<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  rows: T[] | null,
): Promise<ClientFile<T>[]> {
  const list = rows ?? [];
  if (list.length === 0) return [];
  const space = getActiveSpace();
  const candidates = list
    .filter((r) => r.status === "ready_for_rag")
    .map((r) => r.id as string);
  const missing = await findFilesMissingActiveSpace(supabase, candidates, space);
  return list.map((r) => projectOne(r, missing));
}
