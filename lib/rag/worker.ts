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
import { getActiveSpace, type EmbeddingSpace } from "./embedding-space";
import { getRagLimits } from "./pipeline";
import { getRagRuntimeConfig } from "./runtime-config";
import { tryAcquireDrainSlot } from "./drain-gate";
import { settleIfCompleteInSpace } from "./space-readiness";
import { indexFileSentences } from "./sentence-index";
import {
  claimRagJob,
  completeRagJob,
  enqueueRagJob,
  failRagJob,
  heartbeatRagJob,
  stillOwnsJob,
  type RagJob,
} from "./jobs";

const MAX_EXTRACTED_FOR_CHUNKS = 500_000;

/** حد التزامن داخل العملية الواحدة (تسلسلي — يحمي RAM) */
export const WORKER_CONCURRENCY = 1;

/** مدة القفل — بعدها يُعتبر العامل متوقفًا وتُستعاد الوظيفة */
export const LEASE_SECONDS = 120;

interface FileRow {
  id: string;
  user_id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  extracted_text: string | null;
  status: string;
}

class PermanentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
class CancelledError extends Error {}

/**
 * ملفٌّ تركته وظيفةٌ ماتت في منتصفه (`chunking`/`embedding`) يُعطى وظيفةَ الفضاء
 * الفعّال — وإلّا فلا شيء: الجاهزُ لا يُمسّ، والناقصُ يكشفه النطاق ويُجهَّز من هناك.
 * لا ترمي: الإلغاءُ تمّ، وفشلُ الإدراج يُسجَّل ويبقى استئنافُ الواجهة متاحًا.
 */
async function requeueIfMidIndexing(supabase: SupabaseClient, job: RagJob, space: EmbeddingSpace): Promise<void> {
  try {
    const { data: f } = await supabase
      .from("files")
      .select("status, extracted_text")
      .eq("id", job.file_id)
      .eq("user_id", job.user_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!f || (f.status !== "chunking" && f.status !== "embedding")) return;
    // كاملٌ في الفضاء الفعّال أصلًا: تُعاد حالتُه ولا تُدرج وظيفةٌ (مفتاحُها مكتملٌ فلن تُنشأ)
    if (await settleIfCompleteInSpace(supabase, job.file_id, job.user_id, space)) {
      console.info(`[rag-worker] job=${job.id.slice(0, 8)} file=${job.file_id.slice(0, 8)} settled_in_space=${space.id}`);
      return;
    }
    const text = String(f.extracted_text ?? "").trim();
    if (!text) return;
    await enqueueRagJob(supabase, {
      userId: job.user_id,
      fileId: job.file_id,
      contentHash: contentHash(text),
      jobType: space.jobType,
      keySuffix: space.modelTag ?? undefined,
    });
    console.info(`[rag-worker] job=${job.id.slice(0, 8)} file=${job.file_id.slice(0, 8)} requeued_in_space=${space.id}`);
  } catch (err) {
    console.error(`[rag-worker] requeue_failed file=${job.file_id.slice(0, 8)} err=${(err as Error).message?.slice(0, 120)}`);
  }
}

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
    .select("id, user_id, storage_path, original_name, mime_type, extracted_text, status")
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

  /**
   * فضاء التضمين يُحسم مرّة واحدة لكل وظيفة من عَلَم العملية — لا من نوع الوظيفة:
   * فالعملية التي لا تحمّل إلا نموذجًا واحدًا لا تكتب إلا متجهاته، ولا يُخلط عمودان أبدًا.
   */
  const space = getActiveSpace();
  const isV2 = space.id === "f2llm";
  /**
   * ★ الوظيفةُ تُنفَّذ في فضائها وحده — في الاتّجاهين.
   *
   *   كان الحارسُ في اتّجاهٍ واحد (وظيفة F2LLM في عمليّة e5). والعكسُ — وظيفةُ e5
   *   بقيت في الطابور لحظةَ قلب الفضاء إلى F2LLM — كانت تُنفَّذ بمتجهات F2LLM
   *   وتُعلَّم `completed`. فيُسجَّل مفتاحُ idempotency لِـe5 مكتملًا بلا متجهٍ
   *   واحدٍ من e5، وحين يعود e5 يرفض `enqueueRagJob` إنشاءَ وظيفةٍ جديدة («مكتملة
   *   لنفس المحتوى») — فيبقى الملفُّ معلَّقًا في e5 إلى الأبد.
   *
   * ★ والملغاةُ لا تترك ملفًّا في منتصف الطريق: إن كان على `chunking`/`embedding`
   *   (عمليّةٌ ماتت أثناءه) فلا شيءَ آخرُ يحرّكه — النطاقُ يراه «قيد الفهرسة»،
   *   والطابورُ خالٍ. فتُدرج له وظيفةُ الفضاء الفعّال مكانها. وما عدا ذلك لا يُمسّ:
   *   الجاهزُ جاهز، والناقصُ يكشفه `needs_active_embedding` ويُجهَّز من هناك.
   */
  if (job.job_type !== space.jobType) {
    const code = isV2 ? "space_mismatch" : "f2llm_disabled";
    await failRagJob(
      supabase,
      job,
      workerId,
      "cancelled",
      code,
      isV2 ? "وظيفةُ فضاءٍ آخر — تُستبدل بوظيفة الفضاء الفعّال." : "فضاء F2LLM غير مفعّل في هذه العملية.",
    );
    perfLog(job, job.file_id, "cancelled", { code });
    await requeueIfMidIndexing(supabase, job, space);
    return { ok: false, status: "cancelled" };
  }
  /** إضافة v2 لملفٍّ جاهزٍ أصلًا في e5: لا تُقلب حالتُه ولا يُكسر جاهزيتُه القديمة إن فشلت */
  let backfill = false;

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
    backfill = isV2 && chunksCurrent && file.status === "ready_for_rag";

    if (!chunksCurrent) {
      let chunks = await buildChunks(supabase, file);
      if (chunks.length === 0)
        throw new PermanentError("no_chunks", "لم ينتج التقسيم أي مقاطع.");

      // الحد الفعلي = min(حد الباقة, حد وضع التشغيل/الذاكرة المنخفضة)
      const cfg = getRagRuntimeConfig();
      const limits = await getRagLimits(supabase, file.user_id);
      const chunkCap = Math.min(limits.maxChunksPerFile, cfg.maxChunksPerFile);
      if (chunks.length > chunkCap) chunks = chunks.slice(0, chunkCap);

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
        .update({
          rag_content_hash: docHash,
          rag_total_chunks: chunks.length,
          updated_at: now(),
          // مقاطعُ جديدة: لا يبقى وسمُ «مكتمل في v2» لمحتوى سابق
          ...(isV2 ? { rag_v2_model: null } : {}),
        })
        .eq("id", file.id);
      if (isV2) {
        // مقاطعُ جديدة ⇒ جملُ القديمة زالت معها (cascade)، فلا تبقى علامةُ «فهرسُ الجمل مكتمل».
        // منفصلٌ ومتسامح: قبل تطبيق 0050 لا عمودَ له، والخطأ يُتجاهل فلا يمسّ الفهرسة.
        await supabase.from("files").update({ rag_v2_sentences_model: null }).eq("id", file.id);
      }
      perfLog(job, file.id, "chunked", { chunks: chunks.length, ms: Date.now() - t0 });
    } else {
      perfLog(job, file.id, "chunk_resume", { existing: existingCount ?? 0 });
    }

    // ===== 2) embedding (المقاطع بلا embedding فقط — قابل للاستكمال) =====
    if (!backfill) {
      await supabase.from("files").update({ status: "embedding", updated_at: now() }).eq("id", file.id);
    }
    if (isV2) {
      // متجهٌ بوسمِ نموذجٍ آخر لا يُبقى: يُصفَّر فيُعاد تضمينه (المتجه والوسم يسافران معًا)
      await supabase
        .from("file_chunks")
        .update({ embedding_v2: null, embedding_v2_model: null })
        .eq("file_id", file.id)
        .neq("embedding_v2_model", space.modelTag as string);
    }
    const countEmbedded = async (): Promise<number> => {
      const base = supabase
        .from("file_chunks")
        .select("id", { count: "exact", head: true })
        .eq("file_id", file.id);
      const q = isV2 ? base.eq("embedding_v2_model", space.modelTag as string) : base.not("embedding", "is", null);
      return (await q).count ?? 0;
    };
    const { count: total } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", file.id);
    const totalChunks = total ?? 0;

    const provider = getEmbeddingProvider();
    const embedBatch = getRagRuntimeConfig().embedDbBatch;
    let embedded = totalChunks;
    let lastDone = -1;
    for (;;) {
      const { data: pending } = await supabase
        .from("file_chunks")
        .select("id, content")
        .eq("file_id", file.id)
        .is(space.vectorColumn, null)
        .order("chunk_index", { ascending: true })
        .limit(embedBatch);
      if (!pending || pending.length === 0) break;

      await checkAlive();
      await assertFileAlive(supabase, file.id, file.user_id); // قبل حفظ كل دفعة embedding
      const vectors = await provider.embedPassages(pending.map((p) => p.content as string));
      if (vectors.length !== pending.length)
        throw new Error("embedding batch mismatch"); // transient

      for (let i = 0; i < pending.length; i++) {
        const { error } = await supabase
          .from("file_chunks")
          .update(
            isV2
              ? { embedding_v2: JSON.stringify(vectors[i]), embedding_v2_model: space.modelTag }
              : { embedding: JSON.stringify(vectors[i]) },
          )
          .eq("id", pending[i]!.id);
        if (error) throw new Error("embedding persist failed"); // transient
      }

      const doneCount = await countEmbedded();
      // كل دفعةٍ حُفظت يجب أن ترفع العدّ. إن لم يرتفع (تحديثٌ لم يمسّ صفًّا — كتصفيةِ سياسة RLS — بلا خطأ)
      // فالحلقة كانت ستعيد تضمين الدفعة نفسها بلا نهاية؛ نقطعها بخطأٍ عابر فتُعاد الوظيفة بتراجع ثم تفشل.
      if (doneCount <= lastDone) throw new Error("embedding made no progress"); // transient
      lastDone = doneCount;
      embedded = doneCount;
      // النبضة تكشف الإلغاء/فقدان القفل
      const alive = await heartbeatRagJob(supabase, job.id, workerId, {
        current: embedded,
        total: totalChunks,
      });
      if (!alive) throw new CancelledError();
    }

    // ===== 3) تحقق نهائي =====
    const withEmb = await countEmbedded();
    if (withEmb !== totalChunks || totalChunks === 0)
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
        // الملف مكتمل التضمين في هذا الفضاء — وحده يجعل مقاطعه مرئيّة لدالة بحث v2
        ...(isV2 ? { rag_v2_model: space.modelTag } : {}),
      })
      .eq("id", file.id);

    /**
     * ===== 4) فهرسُ الجمل (F2LLM، الترحيل 0050) — بعد الجاهزيّة، ومعزول =====
     *   الملفُّ مرئيٌّ الآن بمسار المقاطع. وفهرسُ الجمل تحسينٌ فوقه: فشلُه يُسجَّل ولا يمسّ حالةَ الملفّ
     *   (المسارُ العامّ للأخطاء أدناه كان سيقلبه إلى embedding/rag_failed)، وفقدانُ القفل ينهي بلا لمس.
     */
    if (isV2) {
      const tSent = Date.now();
      try {
        const r = await indexFileSentences(supabase, {
          fileId: file.id,
          userId: file.user_id,
          modelTag: space.modelTag as string,
          provider,
          keepAlive: async () => {
            const alive = await heartbeatRagJob(supabase, job.id, workerId, { current: totalChunks, total: totalChunks });
            if (!alive) throw new CancelledError();
          },
        });
        perfLog(job, file.id, "sentences", { status: r.status, sentences: r.embedded, ms: Date.now() - tSent, rss_end: rssMb() });
      } catch (err) {
        if (err instanceof CancelledError) {
          perfLog(job, file.id, "cancelled", { stage: "sentences" });
          return { ok: false, status: "cancelled" };
        }
        perfLog(job, file.id, "sentences_failed", { ms: Date.now() - tSent, err: (err as Error).message?.slice(0, 60).replace(/\s+/g, "_") });
      }
    }
    await completeRagJob(supabase, job.id, workerId, totalChunks);
    perfLog(job, file.id, "completed", {
      chunks: totalChunks,
      ms: Date.now() - t0,
      rss_start: rssStart,
      rss_end: rssMb(),
      ...(isV2 ? { space: "f2llm", backfill: backfill ? 1 : 0 } : {}),
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
    // فشلُ إضافةِ v2 لا يُفسد ملفًّا جاهزًا في e5: حالتُه تبقى، وتفشل الوظيفة وحدها
    if (!backfill) {
      await supabase
        .from("files")
        .update({
          status: willRetry ? "embedding" : "rag_failed",
          rag_error: permanent ? safeMsg : "تعذّر التجهيز مؤقتًا — سيُعاد.",
          updated_at: now(),
        })
        .eq("id", job.file_id);
    }
    return { ok: false, status: willRetry ? "retrying" : "failed" };
  }
}

/**
 * تصريف وظائف المستخدم الحالي (request-driven): يلتقط ويشغّل بشكل تسلسلي
 * حتى نفاد الوظائف المتاحة أو انتهاء ميزانية الوقت. الحالة كلها في قاعدة البيانات.
 * التقاط SKIP LOCKED يمنع تشغيل نفس الوظيفة مرتين حتى مع طلبات متزامنة.
 *
 * ★ وتصريفٌ واحدٌ في العمليّة في آنٍ واحد (`drain-gate`).
 *
 *   إن كانت البوّابةُ مشغولة عاد فورًا بـ`busy` دون أن يلتقط شيئًا: وظيفةُ
 *   المستدعي أُدرجت قبلُ وتبقى في الطابور، ولا تُلتقط وظيفةٌ ثم تُترك.
 */
type DrainOpts = { workerId: string; maxJobs?: number; deadlineMs?: number };

/**
 * ★ طلبُ تصريفٍ وجد البوّابةَ مشغولةً يُؤجَّل — لا يُسقط.
 *
 *   كان يعود «مشغول» ويُنسى، والوظيفةُ في الطابور تنتظر طلبًا لاحقًا من
 *   صاحبها. قيس على staging: وظيفةُ F2LLM أُدرجت 16:54:15 ولم تُنفَّذ إلّا
 *   16:58:29 (مع أوّل سؤالٍ تالٍ) — وتنفيذُها نفسُه سبعُ ثوانٍ. فالتجهيزُ لم
 *   يكن ملكَ الخادم فعلًا: كان يتوقّف حيث يتوقّف المستخدم.
 *
 *   فالمؤجَّلُ يُعاد حين تتحرّر البوّابة، واحدًا بعد واحد — فحدُّ الذاكرة
 *   (تصريفٌ واحدٌ في العمليّة) باقٍ كما هو. والعميلُ المؤجَّل يحمل جلسةَ
 *   صاحبه، فلا يرى تصريفُه إلا وظائفَه (RLS). وقائمةُ الانتظار محدودة.
 */
const deferredDrains: Array<{ supabase: SupabaseClient; opts: DrainOpts }> = [];
export const MAX_DEFERRED_DRAINS = 8;

/** عددُ طلبات التصريف المؤجَّلة — للقياس والاختبار */
export function deferredDrainCount(): number {
  return deferredDrains.length;
}

export async function drainOwnJobs(
  supabase: SupabaseClient,
  opts: DrainOpts = {
    workerId: "req",
  },
): Promise<{ processed: number; lastStatus: string | null; busy: boolean }> {
  const release = tryAcquireDrainSlot();
  if (!release) {
    if (!deferredDrains.some((d) => d.supabase === supabase)) {
      if (deferredDrains.length >= MAX_DEFERRED_DRAINS) deferredDrains.shift();
      deferredDrains.push({ supabase, opts });
    }
    return { processed: 0, lastStatus: null, busy: true };
  }
  try {
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
    return { processed, lastStatus, busy: false };
  } finally {
    release();
    const next = deferredDrains.shift();
    if (next) {
      void drainOwnJobs(next.supabase, next.opts).catch((err) =>
        console.error(`[rag-worker] deferred_drain_failed worker=${next.opts.workerId} err=${(err as Error).message?.slice(0, 120)}`),
      );
    }
  }
}
