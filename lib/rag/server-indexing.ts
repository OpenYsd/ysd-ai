/**
 * التجهيزُ بعد الاستخراج مسؤوليّةُ الخادم — لا ينتظر المتصفّح.
 *
 * ★ لماذا دالّةٌ واحدة لمسارَين.
 *
 *   كان `ready` (نصٌّ مستخرَج) آخرَ ما يفعله الخادم، ثمّ ينتظر العميلَ أن
 *   يطلب `POST /api/files/:id/rag`. فإن أُغلق اللسان أو انقطعت الشبكة بقي
 *   الملفُّ على `ready` إلى الأبد — قيس حيًّا: عشرةُ ملفّاتٍ في الإنتاج.
 *   والرفعُ صار يُدرج الوظيفةَ بنفسه؛ وإعادةُ الاستخراج (`/process`) تصل إلى
 *   الحال نفسِه فتحتاج الشيءَ نفسَه. دالّةٌ واحدة كي لا يفترق المساران.
 *
 * ★ إدراجٌ ثمّ تصريفٌ لا يُنتظر: الخدمةُ عمليّةُ Node دائمة، فما لا يُنتظر
 *   يكمل. وبوّابةُ التصريف (`drain-gate`) تحدّه بواحدٍ في العمليّة، فإن كانت
 *   مشغولةً بقيت الوظيفةُ في الطابور لأوّل طلبٍ تالٍ.
 *
 * ★ لا ترمي أبدًا: الملفُّ محفوظٌ ونصُّه مستخرَج، وفشلُ الإدراج يُسجَّل ولا
 *   يُسقط الطلبَ الذي استدعاها.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { contentHash } from "./chunking";
import { getActiveSpace } from "./embedding-space";
import { enqueueRagJob } from "./jobs";
import { drainOwnJobs } from "./worker";

export async function scheduleIndexingAfterExtraction(
  supabase: SupabaseClient,
  params: { userId: string; fileId: string; origin: "upload" | "process"; conversationId?: string | null },
): Promise<{ enqueued: boolean }> {
  const { userId, fileId, origin } = params;
  try {
    const { data: row } = await supabase
      .from("files")
      .select("status, mime_type, extracted_text")
      .eq("id", fileId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row || row.status !== "ready" || String(row.mime_type ?? "").startsWith("image/")) {
      return { enqueued: false };
    }
    const text = String(row.extracted_text ?? "").trim();
    if (!text) return { enqueued: false };

    const space = getActiveSpace();
    const res = await enqueueRagJob(supabase, {
      userId,
      fileId,
      contentHash: contentHash(text),
      jobType: space.jobType,
      keySuffix: space.modelTag ?? undefined,
    });
    console.info(
      `[files-pipeline] ${origin}_enqueued_rag file_id=${fileId} conversation_id=${params.conversationId ?? "none"} ` +
        `space=${space.id} enqueued=${"error" in res ? `failed:${res.error}` : res.created}`,
    );
    if ("error" in res) return { enqueued: false };

    void drainOwnJobs(supabase, { workerId: `${origin}:${fileId.slice(0, 8)}`, maxJobs: 3 }).catch((err) =>
      console.error(
        `[files-pipeline] ${origin}_drain_failed file_id=${fileId} err=${(err as Error).message?.slice(0, 120)}`,
      ),
    );
    return { enqueued: true };
  } catch (err) {
    console.error(
      `[files-pipeline] ${origin}_enqueue_failed file_id=${fileId} err=${(err as Error).message?.slice(0, 120)}`,
    );
    return { enqueued: false };
  }
}
