import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { contentHash } from "@/lib/rag/chunking";
import { enqueueRagJob, getLatestJobForFile } from "@/lib/rag/jobs";
import { drainOwnJobs, LEASE_SECONDS } from "@/lib/rag/worker";
import { PUBLIC_FILE_FIELDS } from "@/lib/files/service";

export const runtime = "nodejs";
export const maxDuration = 300;

const idSchema = z.string().uuid();

/**
 * تجهيز/إعادة تجهيز ملف للذكاء الاصطناعي.
 * يُدرِج وظيفة في طابور rag_jobs (مصدر الحقيقة) ثم يصرّفها request-driven.
 * ملاحظة معماريّة: هذا ليس worker خلفيًا دائمًا — التنفيذ يقوده الطلب المصادَق
 * عبر جلسته (RLS نافذ). Worker مستقل عبر المستخدمين يتطلب service role (موثّق، غير مُفعّل).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return json({ error: "معرّف غير صحيح | Invalid id" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  if (!rateLimit(`rag:${user.id}`, 10, 60_000))
    return json({ error: "محاولات تجهيز كثيرة — انتظر قليلًا | Too many attempts" }, 429);

  const { data: row } = await supabase
    .from("files")
    .select("id, status, mime_type, extracted_text, rag_content_hash")
    .eq("id", id)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!row) return json({ error: "الملف غير موجود | File not found" }, 404);

  if (row.mime_type.startsWith("image/"))
    return json({ error: "الصور غير مدعومة في RAG بعد | Images unsupported" }, 400);
  // حالات نُصّ مستخرج (يسمح بالبدء أو الاستئناف) — chunking/embedding مقبولة للاستئناف
  const TEXT_READY = ["ready", "ready_for_rag", "rag_failed", "chunking", "embedding"];
  if (!TEXT_READY.includes(row.status))
    return json({ error: "استخرج نص الملف أولًا | Extract text first" }, 400);
  if (!row.extracted_text || !row.extracted_text.trim())
    return json({ error: "لا يوجد نص مستخرج | No extracted text" }, 400);

  // منتصف معالجة: امنع فقط عند وجود عامل نشط (heartbeat حديث)؛ اسمح بالاستئناف عند التوقف
  if (["chunking", "embedding"].includes(row.status)) {
    const active = await getLatestJobForFile(supabase, id, user.id);
    const fresh =
      active?.status === "running" &&
      active.heartbeat_at != null &&
      Date.now() - new Date(active.heartbeat_at).getTime() < LEASE_SECONDS * 1000;
    if (fresh)
      return json({ error: "الملف قيد التجهيز حاليًا | Already processing", job: active }, 409);
  }

  const docHash = contentHash(row.extracted_text);

  // idempotent: جاهز بالفعل لنفس المحتوى؟
  if (row.status === "ready_for_rag" && row.rag_content_hash === docHash) {
    const { count } = await supabase
      .from("file_chunks")
      .select("id", { count: "exact", head: true })
      .eq("file_id", id);
    if ((count ?? 0) > 0) {
      const { data: fresh } = await supabase.from("files").select(PUBLIC_FILE_FIELDS).eq("id", id).single();
      return json({ file: fresh, skipped: true, totalChunks: count }, 200);
    }
  }

  // 1) إدراج الوظيفة (مصدر الحقيقة) — idempotent عبر الفهرس الفريد الجزئي
  const enq = await enqueueRagJob(supabase, {
    userId: user.id,
    fileId: id,
    contentHash: docHash,
  });
  if ("error" in enq) return json({ error: enq.error }, 500);

  // 2) تصريف request-driven (SKIP LOCKED يمنع تشغيلًا مزدوجًا)
  const workerId = `req:${crypto.randomUUID().slice(0, 8)}`;
  await drainOwnJobs(supabase, { workerId, maxJobs: 5 });

  // 3) أعد حالة الملف والوظيفة (مصدر الحقيقة: قاعدة البيانات)
  const [{ data: fresh }, job] = await Promise.all([
    supabase.from("files").select(PUBLIC_FILE_FIELDS).eq("id", id).single(),
    getLatestJobForFile(supabase, id, user.id),
  ]);
  const ok = fresh?.status === "ready_for_rag";
  return json({ file: fresh, job, skipped: false }, ok ? 200 : 202);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
