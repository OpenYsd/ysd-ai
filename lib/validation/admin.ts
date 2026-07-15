import { z } from "zod";

export const roleSchema = z.enum(["user", "admin", "owner"]);
export const tierSchema = z.enum(["free", "plus", "pro", "business"]);
export const statusSchema = z.enum(["active", "banned", "ai_suspended"]);

/** تعديل مستخدم — عملية واحدة صريحة لكل طلب (منع mass assignment) */
export const setRoleSchema = z.object({ role: roleSchema });
export const setTierSchema = z.object({ tier: tierSchema });
export const setStatusSchema = z.object({ status: statusSchema });

export const usageLimitSchema = z.object({
  tier: tierSchema,
  monthly_messages: z.number().int().min(0).max(100_000_000),
  monthly_tokens: z.number().int().min(0).max(100_000_000_000),
  daily_messages: z.number().int().min(0).max(10_000_000),
  max_file_mb: z.number().int().min(0).max(1000),
  max_files: z.number().int().min(0).max(1_000_000),
  max_storage_mb: z.number().int().min(0).max(10_000_000),
  max_chunks_per_file: z.number().int().min(0).max(100_000),
  max_total_chunks: z.number().int().min(0).max(100_000_000),
});

export const toggleEnabledSchema = z.object({ enabled: z.boolean() });

export const settingSchema = z.object({
  key: z.enum([
    "maintenance_mode",
    "allow_registration",
    "rag_enabled",
    "default_model_id",
    "announcement",
  ]),
  value: z.unknown(),
});
