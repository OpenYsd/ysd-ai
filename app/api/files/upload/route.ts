import { createHash } from "node:crypto";
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
  projectFileForClient,
} from "@/lib/files/service";
import { scheduleIndexingAfterExtraction } from "@/lib/rag/server-indexing";

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
  /**
   * ★ إعادةُ الاستعمال مشروطةٌ بتطابق المحادثة — لا بالمعرّف وحده.
   *
   *   كان يكفي `client_upload_id` ليُعاد الصفُّ القائم أيًّا كانت محادثتُه.
   *   فمن بدأ رفعًا في محادثة (أ) ثم انتقل إلى (ب) قبل وصول الردّ، تُعيد له
   *   المصالحةُ ملفًّا مربوطًا بـ(أ) بينما واجهتُه تعرضه في (ب): ربطٌ خاطئ
   *   صامت، ومنه تسريبُ استرجاعٍ بين محادثتين.
   *
   *   القاعدة الحتميّة هنا:
   *     • المحادثةُ نفسُها        ⇒ يُعاد الصفُّ القائم (مصالحةٌ صحيحة).
   *     • الصفُّ بلا محادثة        ⇒ يُتبنّى ويُربط بهذه المحادثة صراحةً.
   *     • محادثةٌ أخرى            ⇒ **لا يُعاد**: يمضي الطلبُ إلى صفٍّ جديد
   *       مربوطٍ بمحادثته. فلا يُنقل ملفٌّ من محادثةٍ إلى أخرى تحت ستار
   *       «إعادة استعمال»، ولا تفقد (أ) مرفقَها.
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
    if (existing) {
      const target = conversationId ?? null;
      const current = (existing as { conversation_id: string | null }).conversation_id ?? null;
      if (current === target)
        return json({ file: await projectFileForClient(supabase, existing), reused: true }, 200);
      if (current === null && target !== null) {
        const { data: owned } = await supabase
          .from("conversations").select("id").eq("id", target)
          .eq("user_id", user.id).is("deleted_at", null).maybeSingle();
        if (owned) {
          const { data: relinked } = await supabase
            .from("files")
            .update({ conversation_id: target })
            .eq("id", (existing as { id: string }).id)
            .eq("user_id", user.id)
            .select(PUBLIC_FILE_FIELDS)
            .single();
          console.info(
            `[files-pipeline] upload_relinked file_id=${(existing as { id: string }).id} conversation_id=${target}`,
          );
          return json(
            { file: await projectFileForClient(supabase, relinked ?? existing), reused: true, relinked: true },
            200,
          );
        }
      }
      console.info(
        `[files-pipeline] upload_reuse_declined_conversation_mismatch existing_conversation=${current ?? "none"} requested_conversation=${target ?? "none"}`,
      );
    }
  }

  // الحدود من الإعداد المركزي
  const [limits, usage] = await Promise.all([
    getFileLimits(supabase, user.id),
    getFileUsage(supabase, user.id),
  ]);
  const maxBytes = limits.maxFileMb * 1024 * 1024;
  // ★ حدُّ الحجم **قبل** قراءة البايتات: لا يُحمَّل في الذاكرة ما سيُرفض.
  if (fileEntry.size > maxBytes) {
    // الحد الفعلي = min(حد الباقة, سقف مزود التخزين)
    const reason = limits.providerLimited
      ? `الحد الأقصى الحالي للملف ${limits.maxFileMb} ميجابايت بسبب قيود مزود التخزين. | Current file limit is ${limits.maxFileMb}MB due to storage provider constraints`
      : `حجم الملف يتجاوز حد باقتك (${limits.maxFileMb}MB) | File exceeds plan limit`;
    return json({ error: reason }, 413);
  }

  /**
   * ★ بصمةُ المحتوى: إعادةُ اختيار الملفِّ نفسِه لا تُنشئ صفًّا ثانيًا.
   *
   *   `client_upload_id` يمنع تكرارَ **الطلب** المعاد، لا تكرارَ **الاختيار**:
   *   من ظنّ الرفعَ فاشلًا فاختار الملفَّ نفسَه من جديد يحمل معرّفًا جديدًا،
   *   فيُنشأ صفٌّ ثانٍ. رُصد حيًّا: ثلاثةُ صفوفٍ لملفٍّ واحد في الإنتاج.
   *
   *   والمفتاحُ بصمةُ البايتات لا الاسم: اسمٌ واحدٌ بمحتوًى مختلف ملفّان
   *   مختلفان (فلا يُبتلع أحدهما)، ومحتوًى واحدٌ باسمٍ مختلف هو الملفُّ نفسه.
   *   والنطاقُ محادثةٌ واحدة: الملفُّ نفسُه في محادثةٍ أخرى مرفقٌ آخرُ لها
   *   ربطُها الخاصّ — فلا تتسرّب مرفقاتٌ بين المحادثات.
   */
  const buffer = Buffer.from(await fileEntry.arrayBuffer());
  const contentSha = createHash("sha256").update(buffer).digest("hex");
  const twin = await findContentTwin(supabase, user.id, contentSha, fileEntry.size, conversationId ?? null);
  if (twin) {
    console.info(
      `[files-pipeline] upload_deduped_by_content file_id=${(twin as { id: string }).id} conversation_id=${conversationId ?? "none"}`,
    );
    return json(
      { file: await projectFileForClient(supabase, twin), reused: true, dedupedBy: "content" },
      200,
    );
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
  const fileMetadata: Record<string, string> = { content_sha256: contentSha };
  if (clientUploadId) fileMetadata.client_upload_id = clientUploadId;
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
    metadata: fileMetadata,
  });
  if (insertError) {
    /**
     * ★ 23505 هنا ليست خطأً: هي الفهرسُ الفريد يحسم سباقًا.
     *
     *   الفحصُ أعلاه يقرأ ثمّ يكتب، وبين القراءة والكتابة نافذةٌ يسع فيها
     *   طلبٌ متزامنٌ بالبايتات نفسِها أن يسبق. الفحصُ وحده يترك التكرار
     *   ممكنًا؛ والفهرسُ الجزئيُّ الفريد يجعله مستحيلًا. فمن خسر السباقَ
     *   يقرأ صفَّ الرابح ويعيده — والنتيجةُ صفٌّ واحدٌ لا صفّان.
     */
    if (insertError.code === "23505") {
      const winner = await findContentTwin(
        supabase, user.id, contentSha, fileEntry.size, conversationId ?? null,
      );
      if (winner) {
        console.info(
          `[files-pipeline] upload_deduped_by_index file_id=${(winner as { id: string }).id} conversation_id=${conversationId ?? "none"}`,
        );
        return json(
          { file: await projectFileForClient(supabase, winner), reused: true, dedupedBy: "content" },
          200,
        );
      }
    }
    console.error(`[files] insert failed: code=${insertError.code}`);
    return json({ error: "تعذّر تسجيل الملف | Failed to register file" }, 500);
  }

  // الرفع إلى التخزين الخاص — سياسات Storage تفرض أن المسار يبدأ بمعرّف المستخدم
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
    metadata: fileMetadata,
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
  // ★ التجهيزُ يُدرَج هنا — لا يُنتظر أن يطلبه المتصفّح (انظر server-indexing)
  await scheduleIndexingAfterExtraction(supabase, {
    userId: user.id,
    fileId,
    origin: "upload",
    conversationId: conversationId ?? null,
  });

  return json({ file: await projectFileForClient(supabase, fresh), reused: false }, 201);
}

/**
 * توأمُ المحتوى داخل النطاق نفسِه — أو لا شيء.
 *
 * ★ المطابقةُ بالبايتات (sha256) **والحجم** معًا، لا بالاسم: فملفّان باسمٍ
 *   واحدٍ ومحتوًى مختلف يبقيان ملفّين، ولا يبتلع أحدُهما الآخر.
 * ★ والنطاقُ المحادثةُ نفسُها: الملفُّ نفسُه في محادثةٍ أخرى مرفقٌ مستقلٌّ لها
 *   ربطُه الخاصّ، فلا يعبر مرفقٌ من محادثةٍ إلى أخرى.
 */
async function findContentTwin(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  contentSha: string,
  sizeBytes: number,
  conversationId: string | null,
) {
  let q = supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .eq("metadata->>content_sha256", contentSha)
    .eq("size_bytes", sizeBytes);
  q = conversationId ? q.eq("conversation_id", conversationId) : q.is("conversation_id", null);
  // واحدٌ على الأكثر: الفهرسُ الجزئيُّ الفريد يمنع وجودَ ثانٍ بالبصمة نفسها
  const { data } = await q.limit(1).maybeSingle();
  return data;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
