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

/**
 * كاش platform_settings في ذاكرة الخادم — TTL 30 ثانية.
 * الإعدادات تتغيّر نادرًا (من لوحة الإدارة فقط)، بينما تُقرأ على كل طلب مُصادَق
 * (وضع الصيانة). بلا كاش = رحلة ~310ms إلى Supabase لكل طلب.
 *
 * لا يخزّن أي بيانات مستخدم — قيم منصة عامة فقط. يُبطَل فورًا عند التعديل عبر
 * invalidateSettingsCache (تُستدعى من admin settings PATCH).
 */
let settingsCache: { value: Record<string, unknown>; expires: number } | null = null;
const SETTINGS_TTL_MS = 30_000;

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/** كل الإعدادات، من الكاش إن كان حيًّا وإلا من القاعدة. */
export async function getCachedSettings(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (settingsCache && settingsCache.expires > now) return settingsCache.value;
  const { data } = await supabase.from("platform_settings").select("key, value");
  const value: Record<string, unknown> = {};
  for (const r of data ?? []) value[r.key as string] = r.value;
  settingsCache = { value, expires: now + SETTINGS_TTL_MS };
  return value;
}

/** لأغراض الاختبار فقط */
export function _settingsCacheState() {
  return settingsCache;
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
