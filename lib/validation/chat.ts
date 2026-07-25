import { z } from "zod";

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
    clientRequestId: z.string().min(8).max(64).optional(),
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
  })
  .refine((d) => d.title !== undefined || d.projectId !== undefined, {
    message: "لا يوجد ما يُحدّث",
  });
