import { z } from "zod";

export const uploadFieldsSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  /** معرّفٌ يولّده العميل لكل ملفٍّ مختار — يجعل إعادة الرفع لا تكرّر ملفًّا حُفظ */
  clientUploadId: z.string().uuid().optional(),
});

export const linkFileSchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    conversationId: z.string().uuid().nullable().optional(),
  })
  .refine((d) => d.projectId !== undefined || d.conversationId !== undefined, {
    message: "لا يوجد ما يُحدّث",
  });

/**
 * تعديل ملف: الربط كما في `linkFileSchema`، وإعادة تسمية الاسم المعروض (`name`).
 * الاسم يُعقَّم ويُتحقَّق من امتداده على الخادم (lib/files/library.ts).
 */
export const updateFileSchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    conversationId: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .refine((d) => d.projectId !== undefined || d.conversationId !== undefined || d.name !== undefined, {
    message: "لا يوجد ما يُحدّث",
  });
