import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
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

  // Rate limiting للرفع: 10 عمليات في الدقيقة
  if (!rateLimit(`upload:${user.id}`, 10, 60_000))
    return json({ error: "عمليات رفع كثيرة — انتظر قليلًا | Too many uploads" }, 429);

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
  });
  if (!parsed.success) return json({ error: "بيانات غير صحيحة | Invalid fields" }, 400);
  const { projectId, conversationId } = parsed.data;

  // النوع: الامتداد وMIME معًا — يمنع التنفيذيات والسكريبتات والمضغوطات
  const allowed = resolveAllowedType(fileEntry.name, fileEntry.type);
  if (!allowed)
    return json(
      { error: "نوع الملف غير مدعوم. المسموح: PDF, DOCX, TXT, MD, PNG, JPG, WEBP | Unsupported file type" },
      400,
    );

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
  });

  const { data: fresh } = await supabase
    .from("files")
    .select(PUBLIC_FILE_FIELDS)
    .eq("id", fileId)
    .single();

  return json({ file: fresh }, 201);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
