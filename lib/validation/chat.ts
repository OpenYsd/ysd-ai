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
  })
  .refine((d) => d.regenerate === true || typeof d.message === "string", {
    message: "message مطلوبة إلا عند إعادة التوليد",
  });

export type ChatRequestBody = z.infer<typeof chatRequestSchema>;

export const createConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
});

export const renameConversationSchema = z.object({
  title: z.string().min(1).max(120),
});
