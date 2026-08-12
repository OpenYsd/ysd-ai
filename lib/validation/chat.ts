import { z } from "zod";

/**
 * شكل معرّف الطلب — **نفس** النمط المفروض في القاعدة
 * (chat_request_ids_format في migration 0017). التطابق مقصود: التحقق هنا
 * يعطي رسالة عربية واضحة، والقيد هناك هو الضمان الأخير مهما كان المصدر.
 * معرّف مبهم لا وعاء نصّي: لا مسافات ولا عربية ولا رموز.
 */
export const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    modelId: z.string().min(1).max(100),
    /** نص الرسالة — غير مطلوب عند إعادة التوليد */
    message: z.string().min(1).max(32_000).optional(),
    /** تعديل رسالة مستخدم سابقة ثم إعادة التوليد من عندها */
    editMessageId: z.string().uuid().optional(),
    /** إعادة توليد آخر رد دون رسالة جديدة */
    regenerate: z.boolean().optional(),
    /**
     * معرّف الطلب من العميل (v0.6.6) — يمنع ازدواج الحفظ حين يتكرر الطلب نفسه
     * (نقر مزدوج، شبكة بطيئة، إعادة اتصال). الخادم يتجاهل التكرار.
     */
    clientRequestId: z
      .string()
      .regex(CLIENT_REQUEST_ID_RE, "معرّف الطلب غير صالح")
      .optional(),
    /**
     * أعلى إصدار تقسيم تفهمه حزمة العميل (v0.9.2) — تفاوض قدرات.
     *
     * غيابه يعني عميلًا قديمًا أقصاه 1، فلا يستطيع توليد رسالة بإصدار لا
     * يفهمها. المشكلة تُمنع بالبناء لا بالانضباط. واختياريّته تُبقي كل عميل
     * منشور يمرّ بلا خطأ تحقّق.
     */
    evidenceSegmentationMaxVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .refine((d) => d.regenerate === true || typeof d.message === "string", {
    message: "message مطلوبة إلا عند إعادة التوليد",
  });

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;

export const createConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
});

export const updateConversationSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    /** ربط بمشروع (uuid) أو فك الربط (null) */
    projectId: z.string().uuid().nullable().optional(),
    /**
     * نموذج المحادثة (v0.8.0). الطول وحده لا يكفي: المسار يتحقق أن المعرّف
     * **موجود فعلًا** في سجل المزوّدين الموثوق. ولا يُقبل حقل provider من
     * العميل إطلاقًا — يُستنتج خادميًا من النموذج، وإلا صار بوسع العميل نسب
     * نموذج إلى مزوّد لا يملكه.
     */
    modelId: z.string().min(1).max(120).optional(),
  })
  .refine(
    (d) => d.title !== undefined || d.projectId !== undefined || d.modelId !== undefined,
    { message: "لا يوجد ما يُحدّث" },
  );
