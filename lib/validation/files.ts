import { z } from "zod";

export const uploadFieldsSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

export const linkFileSchema = z
  .object({
    projectId: z.string().uuid().nullable().optional(),
    conversationId: z.string().uuid().nullable().optional(),
  })
  .refine((d) => d.projectId !== undefined || d.conversationId !== undefined, {
    message: "لا يوجد ما يُحدّث",
  });
