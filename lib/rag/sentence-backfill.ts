/**
 * استكمالُ فهرس الجمل لملفّاتٍ جاهزةٍ من قبل الترحيل 0050 — يكتمل بلا رفعٍ جديد.
 *
 * ★ العطل: المسارُ كان يدرج حتى 5 وظائف استكمال ويصرّف 3، ولا يصرّف إلا حين تُنشأ وظيفةٌ جديدة. فمحادثةٌ فيها
 *   4–5 ملفّاتٍ قديمة طويلة تبقى لها وظيفتان «queued» إلى أن يرفع صاحبُها ملفًّا — وهي على المسار القديم (مستنسَخٌ
 *   على staging: 3 من 5 مفهرسة، ووظيفتان معلّقتان بعد سؤالين).
 *
 * ★ الإصلاح: حلقةٌ واحدةٌ لكلّ مستخدم، تعمل خارجَ مسار الردّ (لا تؤخّر الجواب)، وتكرّر:
 *     التغطية ← إدراجُ دفعةٍ (≤ 5 وظائف) ← التصريف ← …  حتى لا يبقى ناقصٌ قابلٌ للتقدّم.
 *   وتُصرَّف الوظائفُ القائمة ولو لم تُنشأ وظيفةٌ جديدة (المتروكُ من قبل، أو بعد إعادة تشغيل).
 *
 * ★ الحدود كما هي أو أضيق:
 *   - عاملٌ واحد: التصريفُ عبر `drainOwnJobs` وبوّابتِه (تصريفٌ واحدٌ في العمليّة). البوّابةُ مشغولة ⇒ ننتظر، لا نزاحم.
 *   - لا وظائفَ مكرّرة: فهرسٌ فريد لكلّ (ملفّ، نوع) نشط، ومفتاحُ اليوم لكلّ ملفّ.
 *   - لا تزامنَ غيرَ محدود: حلقةٌ واحدةٌ لكلّ مستخدم (النداءُ الثاني ينضمّ بملفّاته)، وسقفٌ لعدد الحلقات في العمليّة،
 *     ودفعةٌ ≤ 5 وظائف، ومهلةٌ كلّيّة، وسقفٌ لجولات الانتظار.
 *   - يُستأنف بعد النوم/إعادة التشغيل: الحالةُ كلُّها في `rag_jobs`. وظيفةٌ «running» لعمليّةٍ ماتت تُستعاد بعد عقد
 *     الإيجار؛ والحلقةُ تنتظرها ثمّ تكملها. والسؤالُ التالي يبدأ الحلقةَ من جديد إن لم تكن قائمة.
 *   - لا إعادةَ كتابةٍ لبيانات المستخدم: وظيفةُ الاستكمال لا تمسّ المقاطعَ ولا حالةَ الملفّ (lib/rag/worker.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveSpace } from "./embedding-space";
import { ensureSentenceIndexJobs, sentenceIndexCoverage, SENTENCE_BACKFILL_MAX_FILES } from "./sentence-index";
import { drainOwnJobs } from "./worker";

/** وظائفُ الدفعة الواحدة — وحدُّ ما ينتظر في الطابور من هذه الحلقة في أيّ لحظة */
export const SENTENCE_BACKFILL_BATCH = SENTENCE_BACKFILL_MAX_FILES;
/** المهلةُ الكلّيّة للحلقة */
export const SENTENCE_BACKFILL_DEADLINE_MS = 5 * 60_000;
/** الانتظارُ بين جولتين بلا تقدّم (بوّابةٌ مشغولة، أو وظيفةٌ لم ينتهِ عقدُ إيجارها، أو تراجعُ إعادة المحاولة) */
export const SENTENCE_BACKFILL_WAIT_MS = 10_000;
/** جولاتُ الانتظار المتتالية: 15 × 10 ث = 150 ث > عقد الإيجار (120 ث) */
export const SENTENCE_BACKFILL_MAX_IDLE_ROUNDS = 15;
/** أقصى حلقاتٍ قائمةٍ في العمليّة (مستخدمون مختلفون) */
export const MAX_ACTIVE_BACKFILLS = 4;

export interface BackfillResult {
  /**
   * done: لا ناقص · partial: بقي ما لا يتقدّم الآن (فشلٌ اليوم، أو انتهت المهلة/جولاتُ الانتظار) ·
   * joined: حلقةٌ قائمةٌ للمستخدم نفسِه أخذت الملفّات · skipped: سقفُ الحلقات · unavailable: لا فضاءَ F2LLM أو لا ترحيل
   */
  status: "done" | "partial" | "joined" | "skipped" | "unavailable";
  rounds: number;
  enqueued: number;
  processed: number;
  missing: number;
  ms: number;
}

/** الحلقاتُ القائمة: المستخدم ← الملفّاتُ المطلوبة (تُضاف إليها ملفّاتُ نداءٍ لاحق) */
const active = new Map<string, Set<string>>();
export const activeBackfillCount = (): number => active.size;

export async function backfillSentenceIndex(
  supabase: SupabaseClient,
  params: {
    userId: string;
    fileIds: string[];
    workerId: string;
    deadlineMs?: number;
    /** للاختبار: انتظارٌ يُقدّم ساعةَ القاعدة الوهميّة */
    sleep?: (ms: number) => Promise<void>;
    /** للاختبار: يُستدعى بعد إدراج كلّ دفعة */
    onRound?: () => void;
  },
): Promise<BackfillResult> {
  const t0 = Date.now();
  const res: BackfillResult = { status: "partial", rounds: 0, enqueued: 0, processed: 0, missing: params.fileIds.length, ms: 0 };
  const done = (status: BackfillResult["status"]): BackfillResult => ({ ...res, status, ms: Date.now() - t0 });
  const space = getActiveSpace();
  if (space.id !== "f2llm" || !space.modelTag || params.fileIds.length === 0) return done("unavailable");

  const joined = active.get(params.userId);
  if (joined) {
    for (const id of params.fileIds) joined.add(id);
    return done("joined");
  }
  if (active.size >= MAX_ACTIVE_BACKFILLS) return done("skipped");
  const wanted = new Set(params.fileIds);
  active.set(params.userId, wanted);

  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = t0 + (params.deadlineMs ?? SENTENCE_BACKFILL_DEADLINE_MS);
  /** ملفّاتٌ لا تتقدّم اليوم — لا تُعاد، فلا تحجب دفعةَ غيرها ولا تدوّر الحلقة */
  const exhausted = new Set<string>();
  let idle = 0;
  try {
    while (Date.now() < deadline) {
      res.rounds++;
      let progressed = false;
      try {
        const cov = await sentenceIndexCoverage(supabase, [...wanted], space.modelTag);
        if (!cov.available) return done("unavailable");
        res.missing = cov.missing.length;
        if (cov.missing.length === 0) return done("done");
        const candidates = cov.missing.filter((id) => !exhausted.has(id));
        if (candidates.length === 0) return done("partial");

        const enq = await ensureSentenceIndexJobs(supabase, { userId: params.userId, fileIds: candidates, jobType: space.jobType, modelTag: space.modelTag });
        for (const id of enq.exhausted) exhausted.add(id);
        res.enqueued += enq.created.length;
        params.onRound?.();
        if (enq.created.length > 0 || enq.pending.length > 0) {
          const r = await drainOwnJobs(supabase, { workerId: params.workerId, maxJobs: SENTENCE_BACKFILL_BATCH, deadlineMs: Math.max(1, deadline - Date.now()) });
          res.processed += r.processed;
          progressed = !r.busy && r.processed > 0;
        } else {
          // لا وظيفةَ قائمةً ولا جديدة: استُنفدت هذه الدفعة (الجولةُ التالية تأخذ غيرها) — أو تعذّرت قراءة (ننتظر)
          progressed = enq.exhausted.length > 0;
        }
      } catch (err) {
        // عطلٌ عابر في جولة (شبكة/قاعدة) لا يُسقط الحلقة: تُحسب جولةَ انتظار
        console.error(`[rag] sentence backfill round failed: ${(err as Error).message?.slice(0, 80)}`);
      }
      if (progressed) {
        idle = 0;
        continue;
      }
      // بوّابةٌ مشغولة، أو وظيفةٌ لم ينتهِ عقدُ إيجارها، أو تراجعُ إعادة المحاولة، أو عطلٌ عابر
      if (++idle > SENTENCE_BACKFILL_MAX_IDLE_ROUNDS) return done("partial");
      await sleep(SENTENCE_BACKFILL_WAIT_MS);
    }
    return done("partial");
  } finally {
    active.delete(params.userId);
  }
}
