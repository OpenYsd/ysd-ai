import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  customInstructions: z.string().max(4000).optional(),
  defaultModelId: z.string().min(1).max(100).nullable().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectSchema>;
