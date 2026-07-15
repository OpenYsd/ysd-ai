/**
 * قراءة إعدادات المنصة المركزية (platform_settings) — مصدر واحد للحقيقة.
 * لا توزيع للإعدادات داخل ملفات الواجهة.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type SettingKey =
  | "maintenance_mode"
  | "allow_registration"
  | "require_invite"
  | "rag_enabled"
  | "default_model_id"
  | "announcement"
  | "terms_version";

export async function getSetting<T = unknown>(
  supabase: SupabaseClient,
  key: SettingKey,
  fallback: T,
): Promise<T> {
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value ?? fallback) as T;
}

export async function getSettings(
  supabase: SupabaseClient,
  keys: SettingKey[],
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("platform_settings")
    .select("key, value")
    .in("key", keys);
  const out: Record<string, unknown> = {};
  for (const r of data ?? []) out[r.key as string] = r.value;
  return out;
}
