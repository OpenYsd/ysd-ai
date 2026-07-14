/**
 * منطق تنفيذ وظيفة RAG — قابل للاستكمال بعد توقف الخادم.
 * مفصول عن Route Handler ليعمل تحت request-driven الآن، وworker مستقل مستقبلًا.
 * الحالة كلها في قاعدة البيانات؛ الذاكرة للأداء فقط.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { FILES_BUCKET } from "@/lib/files/service";
import { extractText } from "@/lib/files/extract";
import { chunkText, contentHash, type Chunk } from "./chunking";
import { getEmbeddingProvider } from "./embeddings";
import { getRagLimits } from "./pipeline";
import {
  claimRagJob,
  completeRagJob,
  failRagJob,
  heartbeatRagJob,
  stillOwnsJob,
  type RagJob,
} from "./jobs";

const EMBED_DB_BATCH = 8;
const MAX_EXTRACTED_FOR_CHUNKS = 500_000;

/** حد التزامن داخل العملية الواحدة (تسلسلي — يحمي RAM) */
export const WORKER_CONCURRENCY = 1;

interface FileRow {
  id: string;
  user_id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  extracted_text: string | null;
}

class PermanentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
class CancelledError extends Error {}

/** سجل أداء منظّم — لا نصوص ملفات ولا مقاطع ولا مسارات كاملة */
function perfLog(
  job: RagJob,
  fileId: string,
  phase: string,
  extra: Record<string, string | number> = {},
) {
  const userHash = job.user_id.slice(0, 8);
  const parts = [
    `cid=${job.correlation_id}`,
    `job=${job.id.slice(0, 8)}`,
    `file=${fileId.slice(0, 8)}`,
    `user=${userHash}`,
    `phase=${phase}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ];
  console.log(`[rag-worker] ${parts.join(" ")}`);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function loadFile(
  supabase: SupabaseClient,
  fileId: string,
  userId: string,
): Promise<FileRow | null> {
  const { data } = await supabase
    .from("files")
    .select("id, user_id, storage_path, original_name, mime_type, extracted_text")
    .eq("id", fileId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as FileRow) ?? null;
}

/** إعادة تحقق أن الملف لم يُحذف — تُستدعى قبل كل مرحلة حفظ (منع سباق الحذف) */
async function assertFileAlive(
  supabase: SupabaseClient,
  fileId: string,
  userId: string,
): Promise<void> {
  const { data } = await supabase
    .from("files")
    .select("id")
    .eq("id", fileId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new CancelledError();
}

async function buildChunks(
  supabase: SupabaseClient,
  file: FileRow,
): Promise<Chunk[]> {
  if (file.mime_type === "application/pdf") {
    const { data: blob, error } = await supabase.storage
      .from(FILES_BUCKET)
      .download(file.storage_path);
    if (error || !blob) throw new Error("download failed"); // transient
    const extracted = await extractText(
      file.mime_type,
      file.original_name,
      Buffer.from(await blob.arrayBuffer()),
    );
    if (!extracted.ok) throw new PermanentError("extract_failed", extracted.error);
    return extracted.pages
      ? chunkText(extracted.pages.map((text, i) => ({ pageNumber: i + 1, text })))
      : chunkText(extracted.text);
  }
  const text = (file.extracted_text ?? "").slice(0, MAX_EXTRACTED_FOR_CHUNKS);
  return chunkText(text);
}

/**
 * تنفيذ الوظيفة بشكل قابل للاستكمال:
 *  1) chunking (يُتخطّى إن كانت المقاطع موجودة لنفس content_hash)
 *  2) embedding (يُعالَج المقاطع بلا embedding فقط — لا تكرار عند الاستكمال)
 *  3) تحقق نهائي ثم ready_for_rag
 */
export async function runRagJob(
  supabase: SupabaseClient,
  job: RagJob,
  workerId: string,
): Promise<{ ok: boolean; status: string }> {
  const rssStart = rssMb();
  const t0 = Date.now();
  const now = () => new Date().toISOString();

  const checkAlive = async () => {
    if (!(await stillOwnsJob(supabase, job.id, workerId))) throw new CancelledError();
  };

  try {
    const file = await loadFile(supabase, job.file_id, job.user_id);
    if (!file) throw new CancelledError(); // حُذف أثناء المعالجة
    if (file.mime_type.startsWith("image/"))
      throw new PermanentError("unsupported", "الصور غير مدعومة في RAG بعد.");
    if (!file.extracted_text || !file.extracted_text.trim())
      throw new PermanentError("no_text", "لا يوجد نص مستخرج للملف.");

    const docHash = contentHash(file.extracted_text);

    // ===== 1) chunking (قابل للتخطي عبر hash) =====
    const { data: fileState } = await supabase
      .from("files")
      .select("rag_content_hash")
      .eq("id", file.id)
      .maybeSingle();
    const { count: existingCount } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id);

    const chunksCurrent =
      fileState?.rag_content_hash === docHash && (existingCount ?? 0) > 0;

    if (!chunksCurrent) {
      let chunks = await buildChunks(supabase, file);
      if (chunks.length === 0)
        throw new PermanentError("no_chunks", "لم ينتج التقسيم أي مقاطع.");

      const limits = await getRagLimits(supabase, file.user_id);
      if (chunks.length > limits.maxChunksPerFile)
        chunks = chunks.slice(0, limits.maxChunksPerFile);

      const { count: otherTotal } = await supabase
        .from("file_chunks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", file.user_id)
        .neq("file_id", file.id);
      if ((otherTotal ?? 0) + chunks.length > limits.maxTotalChunks)
        throw new PermanentError(
          "chunk_limit",
          `بلغت حد إجمالي المقاطع (${limits.maxTotalChunks}). احذف ملفات قديمة.`,
        );

      await checkAlive();
      await assertFileAlive(supabase, file.id, file.user_id); // قبل حفظ المقاطع
      await supabase.from("files").update({ status: "chunking", updated_at: now() }).eq("id", file.id);
      // استبدال آمن: احذف القديمة ثم أدرج المقاطع بلا embedding
      await supabase.from("file_chunks").delete().eq("file_id", file.id);
      for (let i = 0; i < chunks.length; i += 32) {
        const rows = chunks.slice(i, i + 32).map((c) => ({
          file_id: file.id,
          user_id: file.user_id,
          chunk_index: c.index,
          content: c.content,
          character_count: c.characterCount,
          page_number: c.pageNumber,
          content_hash: c.hash,
          embedding: null,
          metadata: { file_name: file.original_name, file_id: file.id },
        }));
        const { error } = await supabase.from("file_chunks").insert(rows);
        if (error) throw new Error("chunk insert failed"); // transient
      }
      // ثبّت hash المحتوى — علامة أن المقاطع تخص هذا المحتوى (تمكّن الاستكمال)
      await supabase
        .from("files")
        .update({ rag_content_hash: docHash, rag_total_chunks: chunks.length, updated_at: now() })
        .eq("id", file.id);
      perfLog(job, file.id, "chunked", { chunks: chunks.length, ms: Date.now() - t0 });
    } else {
      perfLog(job, file.id, "chunk_resume", { existing: existingCount ?? 0 });
    }

    // ===== 2) embedding (المقاطع بلا embedding فقط — قابل للاستكمال) =====
    await supabase.from("files").update({ status: "embedding", updated_at: now() }).eq("id", file.id);
    const { count: total } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id);
    const totalChunks = total ?? 0;

    const provider = getEmbeddingProvider();
    let embedded = totalChunks;
    for (;;) {
      const { data: pending } = await supabase
        .from("file_chunks")
        .select("id, content")
        .eq("file_id", file.id)
        .is("embedding", null)
        .order("chunk_index", { ascending: true })
        .limit(EMBED_DB_BATCH);
      if (!pending || pending.length === 0) break;

      await checkAlive();
      await assertFileAlive(supabase, file.id, file.user_id); // قبل حفظ كل دفعة embedding
      const vectors = await provider.embedPassages(pending.map((p) => p.content as string));
      if (vectors.length !== pending.length)
        throw new Error("embedding batch mismatch"); // transient

      for (let i = 0; i < pending.length; i++) {
        const { error } = await supabase
          .from("file_chunks")
          .update({ embedding: JSON.stringify(vectors[i]) })
          .eq("id", pending[i]!.id);
        if (error) throw new Error("embedding persist failed"); // transient
      }

      const doneCount =
        (await supabase
          .from("file_chunks")
          .select("id", { count: "exact", head: true })
          .eq("file_id", file.id)
          .not("embedding", "is", null)).count ?? 0;
      embedded = doneCount;
      // النبضة تكشف الإلغاء/فقدان القفل
      const alive = await heartbeatRagJob(supabase, job.id, workerId, {
        current: embedded,
        total: totalChunks,
      });
      if (!alive) throw new CancelledError();
    }

    // ===== 3) تحقق نهائي =====
    const { count: withEmb } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id)
      .not("embedding", "is", null);
    if ((withEmb ?? 0) !== totalChunks || totalChunks === 0)
      throw new Error("final verify failed"); // transient — سيُعاد

    await assertFileAlive(supabase, file.id, file.user_id); // قبل الإعلان النهائي
    await supabase
      .from("files")
      .update({
        status: "ready_for_rag",
        rag_total_chunks: totalChunks,
        rag_done_chunks: totalChunks,
        rag_content_hash: docHash,
        rag_error: null,
        updated_at: now(),
      })
      .eq("id", file.id);
    await completeRagJob(supabase, job.id, workerId, totalChunks);
    perfLog(job, file.id, "completed", {
      chunks: totalChunks,
      ms: Date.now() - t0,
      rss_start: rssStart,
      rss_end: rssMb(),
    });
    return { ok: true, status: "completed" };
  } catch (err) {
    if (err instanceof CancelledError) {
      perfLog(job, job.file_id, "cancelled");
      // القفل فُقد (إلغاء/حذف/إعادة التقاط) — لا نلمس الحالة النهائية
      return { ok: false, status: "cancelled" };
    }
    const permanent = err instanceof PermanentError;
    const code = permanent ? (err as PermanentError).code : "transient_error";
    const safeMsg = permanent
      ? (err as PermanentError).message
      : "تعذّر تجهيز الملف مؤقتًا — ستتم إعادة المحاولة.";
    perfLog(job, job.file_id, "error", { code, rss_end: rssMb() });

    await failRagJob(
      supabase,
      job,
      workerId,
      permanent ? "permanent" : "transient",
      code,
      safeMsg,
    );
    // مزامنة حالة الملف للعرض
    const willRetry = !permanent && job.attempts < job.max_attempts;
    await supabase
      .from("files")
      .update({
        status: willRetry ? "embedding" : "rag_failed",
        rag_error: permanent ? safeMsg : "تعذّر التجهيز مؤقتًا — سيُعاد.",
        updated_at: now(),
      })
      .eq("id", job.file_id);
    return { ok: false, status: willRetry ? "retrying" : "failed" };
  }
}

/**
 * تصريف وظائف المستخدم الحالي (request-driven): يلتقط ويشغّل بشكل تسلسلي
 * حتى نفاد الوظائف المتاحة أو انتهاء ميزانية الوقت. الحالة كلها في قاعدة البيانات.
 * التقاط SKIP LOCKED يمنع تشغيل نفس الوظيفة مرتين حتى مع طلبات متزامنة.
 */
export async function drainOwnJobs(
  supabase: SupabaseClient,
  opts: { workerId: string; maxJobs?: number; deadlineMs?: number } = {
    workerId: "req",
  },
): Promise<{ processed: number; lastStatus: string | null }> {
  const maxJobs = opts.maxJobs ?? 10;
  const deadline = Date.now() + (opts.deadlineMs ?? 250_000);
  let processed = 0;
  let lastStatus: string | null = null;

  while (processed < maxJobs && Date.now() < deadline) {
    const job = await claimRagJob(supabase, opts.workerId);
    if (!job) break;
    const res = await runRagJob(supabase, job, opts.workerId);
    lastStatus = res.status;
    processed++;
  }
  return { processed, lastStatus };
}
