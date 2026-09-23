import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  BUCKET_UPLOAD,
  consumeRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit-distributed";
import { uploadFieldsSchema } from "@/lib/validation/files";
import {
  buildStoragePath,
  resolveAllowedType,
  sanitizeFileName,
  storageSafeName,
} from "@/lib/files/config";
import {
  FILES_BUCKET,
  getFileLimits,
  getFileUsage,
  processFile,
  PUBLIC_FILE_FIELDS,
} from "@/lib/files/service";
import { contentHash } from "@/lib/rag/chunking";
import { enqueueRagJob } from "@/lib/rag/jobs";
import { drainOwnJobs } from "@/lib/rag/worker";
import { getActiveSpace } from "@/lib/rag/embedding-space";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * رفع ملف: multipart/form-data (file + projectId? + conversationId?)
 * تحقق النوع (امتداد + MIME معًا)، الحجم، حصص الباقة، وملكية الروابط —
 * كله على الخادم. ثم تخزين خاص واستخراج نص فوري.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح | Unauthorized" }, 401);

  /**
   * حدّ الرفع: ١٠ عمليات في الدقيقة — **موزّع في القاعدة** (المرحلة 6C).
   *
   * كان العدّاد في ذاكرة العملية: نسختان تعنيان عشرين، وإعادةُ تشغيلٍ تعني
   * صفرًا. والقيمة نفسها لم تتغيّر.
   */
  const uploadRate = await consumeRateLimit(user.id, BUCKET_UPLOAD, 10, 60);
  if (!uploadRate.allowed)
    return json(
      { error: "عمليات رفع كثيرة — انتظر قليلًا | Too many uploads" },
      429,
      { "Retry-After": String(uploadRate.retryAfterSec), ...rateLimitHeaders(uploadRate) },
    );

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error(`[files] formData parse failed: ${(err as Error).message?.slice(0, 120)}`);
    return json({ error: "طلب غير صحيح | Malformed request" }, 400);
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File) || fileEntry.size === 0)
    return json({ error: "لم يُرفق ملف | No file attached" }, 400);

  const toId = (v: FormDataEntryValue | null) =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const parsed = uploadFieldsSchema.safeParse({
    projectId: toId(form.get("projectId")),
    conversationId: toId(form.get("conversationId")),
    clientUploadId: toId(form.get("clientUploadId")),
  });
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid fields" }, 400);
  const { projectId, conversationId, clientUploadId } = parsed.data;

  // النوع: الامتداد وMIME معًا — يمنع التنفيذيات والسكريبتات والمضغوطات
  const allowed = resolveAllowedType(fileEntry.name, fileEntry.type);
  if (!allowed)
    return json(
      { error: "نوع الملف غير مدعوم. المسموح: PDF, DOCX, TXT, MD, PNG, JPG, WEBP | Unsupported file type" },
      400,
    );

  /**
   * ★ إعادةُ رفعِ ملفٍّ حُفظ لا تُنشئ ملفًّا ثانيًا.
   *
   * الصفُّ يُدرج قبل التخزين والاستخراج، فقد يُحفظ الملفُّ كاملًا ثم يصل
   * العميلَ 502 من الوسيط (رُصد حيًّا). فالعميل يُرسل معرّفًا ثابتًا للملف
   * المختار، ومن يعيد الرفعَ بالمعرّف نفسه يُعاد إليه الملفُّ القائم — قبل
   * فحص الحصّة، فلا يُرفض لأنّ ملفَّه نفسَه عُدَّ عليه.
   */
  if (clientUploadId) {
    const { data: existing } = await supabase
      .from("files")
      .select(PUBLIC_FILE_FIELDS)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .eq("metadata->>client_upload_id", clientUploadId)
      .limit(1)
      .maybeSingle();
    if (existing) return json({ file: existing, reused: true }, 200);
  }

  // الحدود من الإعداد المركزي
  const [limits, usage] = await Promise.all([
    getFileLimits(supabase, user.id),
    getFileUsage(supabase, user.id),
  ]);
  const maxBytes = limits.maxFileMb * 1024 * 1024;
  if (fileEntry.size > maxBytes) {
    // الحد الفعلي = min(حد الباقة, سقف مزود التخزين)
    const reason = limits.providerLimited
      ? `الحد الأقصى الحالي للملف ${limits.maxFileMb} ميجابايت بسبب قيود مزود التخزين. | Current file limit is ${limits.maxFileMb}MB due to storage provider constraints`
      : `حجم الملف يتجاوز حد باقتك (${limits.maxFileMb}MB) | File exceeds plan limit`;
    return json({ error: reason }, 413);
  }
  if (usage.count + 1 > limits.maxFiles)
    return json({ error: `بلغت الحد الأقصى لعدد الملفات (${limits.maxFiles}) | File count limit reached` }, 403);
  if (usage.bytes + fileEntry.size > limits.maxStorageMb * 1024 * 1024)
    return json({ error: `بلغت حد مساحة التخزين (${limits.maxStorageMb}MB) | Storage limit reached` }, 403);

  // ملكية المشروع/المحادثة — منع الربط ببيانات الغير
  if (projectId) {
    const { data: proj } = await supabase
      .from("projects").select("id").eq("id", projectId)
      .eq("user_id", user.id).is("deleted_at", null).maybeSingle();
    if (!proj) return json({ error: "المشروع غير موجود | Project not found" }, 404);
  }
  if (conversationId) {
    const { data: conv } = await supabase
      .from("conversations").select("id").eq("id", conversationId)
      .eq("user_id", user.id).is("deleted_at", null).maybeSingle();
    if (!conv) return json({ error: "المحادثة غير موجودة | Conversation not found" }, 404);
  }

  const fileId = crypto.randomUUID();
  // الاسم الأصلي (يدعم العربية) للعرض — ومفتاح ASCII آمن للتخزين
  const safeName = sanitizeFileName(fileEntry.name);
  const storagePath = buildStoragePath(
    user.id,
    projectId ?? null,
    fileId,
    storageSafeName(fileEntry.name),
  );

  // صف قاعدة البيانات أولًا (status: uploaded)
  const { error: insertError } = await supabase.from("files").insert({
    id: fileId,
    user_id: user.id,
    project_id: projectId ?? null,
    conversation_id: conversationId ?? null,
    storage_path: storagePath,
    file_name: safeName,
    original_name: safeName,
    mime_type: fileEntry.type.split(";")[0]?.trim().toLowerCase(),
    size_bytes: fileEntry.size,
    status: "uploaded",
    metadata: clientUploadId ? { client_upload_id: clientUploadId } : {},
  });
  if (insertError) {
    console.error(`[files] insert failed: code=${insertError.code}`);
    return json({ error: "تعذّر تسجيل الملف | Failed to register file" }, 500);
  }

  // الرفع إلى التخزين الخاص — سياسات Storage تفرض أن المسار يبدأ بمعرّف المستخدم
  const buffer = Buffer.from(await fileEntry.arrayBuffer());
  const { error: storageError } = await supabase.storage
    .from(FILES_BUCKET)
    .upload(storagePath, buffer, { contentType: allowed.mimes[0], upsert: false });

  if (storageError) {
    console.error(`[files] storage upload failed: ${storageError.message.slice(0, 80)}`);
    await supabase.from("files").delete().eq("id", fileId).eq("user_id", user.id);
    return json({ error: "فشل رفع الملف إلى التخزين | Storage upload failed" }, 500);
  }

  // المعالجة الفورية (استخراج نص أو ready للصور) — بلا ادعاءات
  await processFile(supabase, {
    id: fileId,
    storage_path: storagePath,
    original_name: safeName,
    mime_type: fileEntry.type,
    metadata: clientUploadId ? { client_upload_id: clientUploadId } : {},
  });

  const { data: fresh } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", fileId)
    .single();

  /**
   * ★ التجهيز يُدرَج هنا — لا يُنتظر أن يطلبه المتصفّح.
   *
   *   كان `ready` (نصٌّ مستخرَج) آخرَ ما يفعله الخادم، ثمّ ينتظر العميلَ أن
   *   يطلب `POST /api/files/:id/rag`. فإن أُغلق اللسان، أو انتقل المستخدم،
   *   أو انقطعت الشبكة، أو سقط سكربتٌ — بقي الملفُّ على `ready` إلى الأبد:
   *   نصُّه مستخرَجٌ، ولا مقاطعَ له، ولا يراه الاسترجاع. وهو أكثرُ ما يُنتج
   *   «رفعٌ ينجح أحيانًا ولا ينجح أحيانًا».
   *
   *   قيس حيًّا: عشرةُ ملفات في الإنتاج عالقةٌ على `ready` لم تُفهرس قط،
   *   وأعاد سكربتُ الضغط إنتاجَ الحالة نفسها من أول دورة.
   *
   * ★ إدراجٌ فقط، بلا تصريف.
   *
   *   التصريف قد يطول دقيقة، وحبسُ ردّ الرفع عليه يجعل الرفعَ يبدو معلّقًا.
   *   والإدراجُ وحده يكفي للحتميّة: الوظيفةُ تصير كائنًا ظاهرًا (`queued`)
   *   تلتقطه آلاتُ التصريف والاستئناف القائمة، بدل حالةٍ صامتةٍ لا أثر لها.
   *
   * ★ وفشلُ الإدراج لا يُسقط الرفع: الملفُّ محفوظٌ ونصُّه مستخرَج، ويبقى
   *   طلبُ التجهيز الصريح متاحًا. يُسجَّل ولا يُرمى.
   */
  const isDocument = !fresh?.mime_type?.startsWith("image/");
  if (isDocument && fresh?.status === "ready") {
    try {
      const { data: row } = await supabase
        .from("files")
        .select("extracted_text")
        .eq("id", fileId)
        .single();
      const text = (row?.extracted_text ?? "").trim();
      if (text) {
        const space = getActiveSpace();
        const enqueued = await enqueueRagJob(supabase, {
          userId: user.id,
          fileId,
          contentHash: contentHash(text),
          jobType: space.jobType,
          keySuffix: space.modelTag ?? undefined,
        });
        console.info(
          `[files-pipeline] upload_enqueued_rag file_id=${fileId} conversation_id=${conversationId ?? "none"} ` +
            `space=${space.id} enqueued=${"error" in enqueued ? `failed:${enqueued.error}` : enqueued.created}`,
        );
        /**
         * ★ تصريفٌ لا يُنتظر — الردُّ يخرج الآن، والعملُ يكمل بعده.
         *
         *   الخدمةُ عمليّةُ Node دائمة (لا دالّةٌ عابرة)، فما لا يُنتظر يكمل
         *   فعلًا. والبوّابةُ تحدّه بواحدٍ في آنٍ واحد، فلا ترفع رفعةٌ متعدّدة
         *   الذاكرةَ فوق الحدّ. والمشغولةُ تعود فورًا والوظيفةُ باقيةٌ في
         *   الطابور يلتقطها أوّلُ طلبٍ تالٍ.
         */
        void drainOwnJobs(supabase, { workerId: `upload:${fileId.slice(0, 8)}`, maxJobs: 3 }).catch((err) =>
          console.error(`[files-pipeline] upload_drain_failed file_id=${fileId} err=${(err as Error).message?.slice(0, 120)}`),
        );
      }
    } catch (err) {
      console.error(`[files-pipeline] upload_enqueue_failed file_id=${fileId} err=${(err as Error).message?.slice(0, 120)}`);
    }
  }

  return json({ file: fresh }, 201);
}

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
