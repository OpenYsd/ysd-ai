/**
 * فهرسُ الجمل لفضاء F2LLM (الترحيل 0050): متجهُ كلّ جملةٍ يُحسب مرّةً عند الفهرسة، فيرتّب السؤالُ كلَّ مقاطع
 * ملفّات المحادثة بأفضل جملة باستعلامٍ واحد — بلا تضمينٍ وقتَ السؤال.
 *
 * ★ لماذا (scripts/f2llm/calibration/longdoc-eval.ts، 39 سؤالًا × 3 نطاقات، عربيّ وإنجليزيّ):
 *   المسارُ الحاليّ (أعلى 16 بمتجه المقطع، ثمّ إعادةُ ترتيبٍ بالجمل) 107/117 — كلُّ إخفاقاته في محادثاتٍ متعدّدة
 *   الملفّات حيث يقع مقطعُ الجواب في المرتبة 21–69 فلا يبلغ الـ16. وفهرسُ الجمل 117/117، بلا تضمينٍ وقتيّ
 *   (كان ~155 جملةً في السؤال البارد ≈ 1.8–2 ث على Railway).
 *
 * ★ محدودٌ وآمن:
 *   - يعمل بعد أن يصير الملفُّ جاهزًا: فشلُه لا يمسّ جاهزيّة الملفّ، والسؤالُ يسقط إلى المسار الحاليّ.
 *   - جملةً جملة عبر طابور المزوّد نفسِه — لا ذاكرةَ إضافيّة، وأسئلةُ المستخدمين تتخلّل.
 *   - قابلٌ للاستئناف: مقطعٌ حُفظت جملُه (صفُّه رقم 0 موجود) لا يُعاد؛ وإدراجُ جمل المقطع عبارةٌ واحدة.
 *   - يتحمّل غيابَ الترحيل: أيُّ خطأ من جدولٍ/عمودٍ غير موجود ⇒ `unavailable`، ولا شيء يتغيّر.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingProvider } from "./embeddings";
import { enqueueRagJob } from "./jobs";
import { splitSentences, SECONDARY_MAX_SENTENCES_PER_CHUNK } from "./sentence-rerank";

/** مقاطعُ عبارة الإدراج الواحدة — وعندها نبضةُ الوظيفة وفحصُ الإلغاء */
export const SENTENCE_INDEX_HEARTBEAT_CHUNKS = 8;

export interface SentenceIndexResult {
  status: "done" | "skipped" | "unavailable";
  chunks: number;
  embedded: number;
}

/** جملُ المقطع كما يفهرسها هذا الملفّ ويستعملها البحث — مصدرٌ واحد */
export const chunkSentences = (content: string): string[] => splitSentences(content).slice(0, SECONDARY_MAX_SENTENCES_PER_CHUNK);

export async function indexFileSentences(
  supabase: SupabaseClient,
  params: {
    fileId: string;
    userId: string;
    modelTag: string;
    provider: Pick<EmbeddingProvider, "embedPassages">;
    /** يرمي CancelledError إن فُقد قفلُ الوظيفة — ويجدّد النبضة */
    keepAlive: () => Promise<void>;
  },
): Promise<SentenceIndexResult> {
  const { fileId, userId, modelTag, provider, keepAlive } = params;
  const { data: file, error: fileErr } = await supabase.from("files").select("rag_v2_sentences_model").eq("id", fileId).maybeSingle();
  if (fileErr) return { status: "unavailable", chunks: 0, embedded: 0 };
  if ((file as { rag_v2_sentences_model?: string | null } | null)?.rag_v2_sentences_model === modelTag) {
    return { status: "skipped", chunks: 0, embedded: 0 };
  }

  const { data: chunkRows, error: chunkErr } = await supabase
    .from("file_chunks")
    .select("id, content")
    .eq("file_id", fileId)
    .eq("embedding_v2_model", modelTag)
    .order("chunk_index", { ascending: true })
    .limit(5000);
  if (chunkErr) return { status: "unavailable", chunks: 0, embedded: 0 };
  const chunks = (chunkRows ?? []) as Array<{ id: string; content: string }>;

  const doneIds = async (): Promise<Set<string> | null> => {
    const { data, error } = await supabase
      .from("file_chunk_sentences")
      .select("chunk_id")
      .eq("file_id", fileId)
      .eq("model", modelTag)
      .eq("sentence_index", 0)
      .limit(5000);
    return error ? null : new Set(((data ?? []) as Array<{ chunk_id: string }>).map((r) => r.chunk_id));
  };
  const done = await doneIds();
  if (!done) return { status: "unavailable", chunks: chunks.length, embedded: 0 };

  /**
   * ★ جملُ عدّة مقاطع في عبارة إدراجٍ واحدة. قيس على staging: 280 جملةً (31 مقطعًا) = ~3 ث تضمين و~8 ث رحلاتٍ
   *   إلى القاعدة (إدراجٌ لكلّ مقطع ≈ 260 مل). والعبارةُ تشمل مقاطعَ كاملةً وحدها، فالاستئنافُ كما هو: ما لم
   *   يُحفظ يُعاد، وما حُفظ (صفُّه رقم 0) لا يُمسّ.
   */
  let embedded = 0;
  let batch: Array<Record<string, unknown>> = [];
  let batchChunks = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const { error } = await supabase.from("file_chunk_sentences").insert(batch);
    if (error) throw new Error(`sentence insert failed: ${error.code ?? ""}`);
    batch = [];
    batchChunks = 0;
    await keepAlive();
  };
  for (const c of chunks) {
    if (done.has(c.id)) continue;
    const sentences = chunkSentences(c.content);
    if (sentences.length === 0) continue;
    const vectors = await provider.embedPassages(sentences);
    if (vectors.length !== sentences.length) throw new Error("sentence embedding mismatch");
    for (let i = 0; i < vectors.length; i++) {
      batch.push({ chunk_id: c.id, file_id: fileId, user_id: userId, sentence_index: i, model: modelTag, embedding: JSON.stringify(vectors[i]) });
    }
    embedded += sentences.length;
    if (++batchChunks >= SENTENCE_INDEX_HEARTBEAT_CHUNKS) await flush();
  }
  await flush();

  // تحقّقٌ نهائيّ: كلُّ مقطعٍ له جمله — وحده يرفع العلامة التي تجعل الملفَّ مرئيًّا لبحث الجمل
  const after = await doneIds();
  const complete = after !== null && chunks.every((c) => after.has(c.id) || chunkSentences(c.content).length === 0);
  if (!complete) throw new Error("sentence index verify failed");
  const { error: markErr } = await supabase.from("files").update({ rag_v2_sentences_model: modelTag }).eq("id", fileId);
  if (markErr) throw new Error("sentence index mark failed");
  return { status: "done", chunks: chunks.length, embedded };
}

/** أيُّ ملفّات النطاق فهرسُ جملها مكتملٌ بهذا النموذج؟ `available=false` = الترحيل غير مطبَّق (أو تعذّر السؤال) */
export async function sentenceIndexCoverage(
  supabase: SupabaseClient,
  fileIds: string[],
  modelTag: string,
): Promise<{ available: boolean; missing: string[] }> {
  const { data, error } = await supabase.from("files").select("id, rag_v2_sentences_model").in("id", fileIds);
  if (error || !data) return { available: false, missing: [] };
  const covered = new Set(
    (data as Array<{ id: string; rag_v2_sentences_model: string | null }>).filter((f) => f.rag_v2_sentences_model === modelTag).map((f) => f.id),
  );
  return { available: true, missing: fileIds.filter((id) => !covered.has(id)) };
}

/** أقصى ملفّاتٍ يُدرج لها استكمالٌ في الدفعة الواحدة */
export const SENTENCE_BACKFILL_MAX_FILES = 5;

/** وظيفةُ استكمالٍ لفهرس الجمل وحده (لا وظيفةُ فهرسةٍ عاديّة) — تُعرف من مفتاحها */
export const isSentenceBackfillJob = (job: { idempotency_key: string }): boolean => job.idempotency_key.includes(":sentences:");

export interface SentenceBackfillEnqueue {
  /** ملفّاتٌ أُنشئت لها وظيفةٌ الآن */
  created: string[];
  /** ملفّاتٌ لها وظيفةٌ نشطةٌ قائمة (queued/running/retrying) — عملٌ ينتظر التصريف ولو لم يُنشأ شيء */
  pending: string[];
  /** ملفّاتٌ لا يمكن أن تتقدّم اليوم (وظيفةُ اليوم انتهت بلا فهرس، أو فشلت، أو لا بصمةَ محتوى) — لا تُعاد في هذه الحلقة */
  exhausted: string[];
}

/**
 * ملفٌّ جاهزٌ من قبل 0050 بلا فهرس جمل: تُدرج له وظيفةُ الفضاء نفسُها بمفتاحٍ مختلف — فتبني فهرسَ الجمل وحده
 * (lib/rag/worker.ts: لا تقطيعَ ولا تضمينَ مقاطع ولا لمسَ لحالة الملفّ). المفتاحُ يحمل اليوم: وظيفةٌ واحدةٌ على
 * الأكثر لكلّ ملفٍّ في اليوم، والفهرسُ الفريد `uniq_active_rag_job` يمنع وظيفتين نشطتين لملفٍّ واحد.
 */
export async function ensureSentenceIndexJobs(
  supabase: SupabaseClient,
  params: { userId: string; fileIds: string[]; jobType: string; modelTag: string; day?: string },
): Promise<SentenceBackfillEnqueue> {
  const ids = params.fileIds.slice(0, SENTENCE_BACKFILL_MAX_FILES);
  const result: SentenceBackfillEnqueue = { created: [], pending: [], exhausted: [] };
  if (ids.length === 0) return result;
  const { data, error } = await supabase.from("files").select("id, rag_content_hash").in("id", ids).eq("user_id", params.userId);
  if (error) return result; // قراءةٌ تعذّرت: لا يُحكم على ملفٍّ بالاستنفاد — الجولةُ التالية تعيد المحاولة
  const rows = (data ?? []) as Array<{ id: string; rag_content_hash: string | null }>;
  const day = params.day ?? new Date().toISOString().slice(0, 10);
  const keySuffix = `${params.modelTag}:sentences:${day}`;
  const keyOf = (f: { id: string; rag_content_hash: string | null }) => `${f.id}:${f.rag_content_hash}:${params.jobType}:${keySuffix}`;
  /**
   * وظيفةُ اليوم لكلّ ملفّ تُقرأ بحالتها أيًّا كانت. الفهرسُ الفريد للمفتاح لا يشمل الفاشلةَ والملغاة، فبدون هذه
   * القراءة تُنشأ لملفٍّ يفشل دائمًا وظيفةٌ جديدة (بأربع محاولات) مع كلّ سؤال.
   */
  const keys = rows.filter((f) => f.rag_content_hash).map(keyOf);
  const { data: todays, error: jobsErr } = keys.length
    ? await supabase.from("rag_jobs").select("idempotency_key, status").in("idempotency_key", keys)
    : { data: [], error: null };
  if (jobsErr) return result;
  const today = (todays ?? []) as Array<{ idempotency_key: string; status: string }>;
  const isActive = (st: string) => ["queued", "running", "retrying"].includes(st);
  for (const id of ids) {
    const f = rows.find((r) => r.id === id);
    if (!f || !f.rag_content_hash) {
      result.exhausted.push(id);
      continue;
    }
    const mine = today.filter((j) => j.idempotency_key === keyOf(f));
    if (mine.some((j) => isActive(j.status))) {
      result.pending.push(id);
      continue;
    }
    if (mine.length > 0) {
      result.exhausted.push(id); // وظيفةُ اليوم انتهت (اكتملت بلا فهرس، أو فشلت، أو أُلغيت) — لا أخرى اليوم
      continue;
    }
    const res = await enqueueRagJob(supabase, { userId: params.userId, fileId: f.id, contentHash: f.rag_content_hash, jobType: params.jobType, keySuffix });
    if ("error" in res) result.exhausted.push(id);
    else if (res.created) result.created.push(id);
    else if (isActive(res.job.status)) result.pending.push(id); // وظيفةُ فهرسةٍ عاديّة نشطة للملفّ — تبني الفهرسَ في آخرها
    else result.exhausted.push(id);
  }
  return result;
}
