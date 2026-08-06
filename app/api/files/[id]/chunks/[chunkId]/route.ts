import { NextRequest } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * فتح مقطع المصدر (v0.9.0، الإيداع السابع).
 *
 * ── الطريق الوحيد هو الدالة ──
 *
 * لا استعلام مباشر على `file_chunks` ولا `service_role`. `get_owned_file_chunk`
 * تفحص الملكية بنفسها وتحصر النافذة داخل الملف، فتمريرها هو ما يجعل هذا
 * المسار عاجزًا عن تسريب مقطعٍ لغير صاحبه ولو أخطأ في التحقق.
 *
 * ── لا تفريق في الأخطاء ──
 *
 * ملفٌ غير موجود، ومقطعٌ غير موجود، ومقطعٌ لمستخدم آخر، ومقطعٌ من ملف آخر:
 * **404 واحدة برسالة واحدة**. والتفريق بينها مِسبار: تكرار النداء بمعرّفات
 * عشوائية يكشف أيّها موجود لدى غيرك بمجرد اختلاف الرد.
 *
 * ── ولا تخزين مؤقت ──
 *
 * الرد يحمل محتوى ملف مستخدم بعينه. و`private, no-store` تمنع أي وسيط — أو
 * المتصفح نفسه — من الاحتفاظ به حيث قد يبلغ جلسةً أخرى.
 */

const idSchema = z.string().uuid();

/**
 * 0 أو 1 أو 2 — **مطابقةً حرفية** لا تحويلًا.
 *
 * `z.coerce.number().min(0).max(2)` يبدو مكافئًا وليس كذلك: `Number("")` صفر،
 * و`Number("0x2")` اثنان، و`Number(" 1 ")` واحد. فكل هذه كانت تمرّ **قيمًا
 * صالحة** بينما هي مَعالِم مشوّهة — و`?neighbors=` الفارغة تحديدًا كانت تُقرأ
 * «صفر جيران» فيحصل العميل على غير ما طلب بلا أن يعلم. (كشفه الاختبار.)
 */
const neighborsSchema = z.enum(["0", "1", "2"]);

/** سقف بنيوي: نافذة ±2 حول الهدف = خمسة مقاطع على الأكثر */
const MAX_CHUNKS = 5;

interface ChunkRow {
  chunk_id: string;
  file_id: string;
  chunk_index: number;
  content: string;
  page_number: number | null;
  original_name: string;
  is_target: boolean;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; chunkId: string }> },
) {
  const { id: fileId, chunkId } = await params;

  // المعرّفات: شكلٌ خاطئ ⇒ 400 عامة، بلا ذكر أيّهما
  if (!idSchema.safeParse(fileId).success || !idSchema.safeParse(chunkId).success) {
    return json({ error: "طلب غير صحيح." }, 400);
  }

  /**
   * `neighbors`: غيابه يعني الافتراضي 1، ووجوده يعني قيمةً تُفحص.
   *
   * القيمة الخاطئة **تُرفض ولا تُصحَّح**: تصحيحُ `neighbors=99` إلى 2 صامتًا
   * يجعل العميل يظنّ أنه حصل على ما طلب.
   */
  const raw = req.nextUrl.searchParams.get("neighbors");
  let neighborCount = 1;
  if (raw !== null) {
    const parsed = neighborsSchema.safeParse(raw);
    if (!parsed.success) return json({ error: "طلب غير صحيح." }, 400);
    neighborCount = Number(parsed.data);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const { data, error } = await supabase.rpc("get_owned_file_chunk", {
    p_file_id: fileId,
    p_chunk_id: chunkId,
    p_neighbors: neighborCount,
  });

  if (error) {
    /**
     * لا `error.message` ولا `details` ولا `hint`، ولا معرّفات كاملة: رسائل
     * PostgREST قد تحمل صفًّا مخالفًا، والمعرّف الكامل يربط سطر السجلّ بملف
     * مستخدم بعينه.
     */
    logger.error({ event: "evidence.chunk", code: "chunk_read_failed" });
    return json({ error: "تعذّر فتح المصدر." }, 500);
  }

  const rows = Array.isArray(data) ? (data as ChunkRow[]) : [];
  /**
   * صفر صفوف تعني: غير موجود، أو ليس لك، أو من ملف آخر — بلا تفريق.
   * وهي أيضًا حال المصدر المحذوف، فيصل العميل 404 لا 500.
   */
  if (rows.length === 0) return json({ error: "المصدر غير متاح." }, 404);

  const ordered = [...rows]
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .slice(0, MAX_CHUNKS);

  const target = ordered.find((r) => r.is_target === true) ?? null;

  logger.info({
    event: "evidence.chunk",
    code: "ok",
    // عدد فقط — لا محتوى ولا اسم ملف ولا معرّف
    count: ordered.length,
  });

  return json(
    {
      fileId: ordered[0]!.file_id,
      fileName: ordered[0]!.original_name,
      targetChunkId: target?.chunk_id ?? null,
      chunks: ordered.map((r) => ({
        chunkId: r.chunk_id,
        chunkIndex: r.chunk_index,
        content: r.content,
        pageNumber: r.page_number,
        isTarget: r.is_target === true,
      })),
    },
    200,
  );
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // محتوى ملف مستخدم بعينه — لا يُخزَّن في أي طبقة
      "Cache-Control": "private, no-store",
    },
  });
}
