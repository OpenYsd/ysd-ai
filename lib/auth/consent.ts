import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * بوابة الموافقة (v0.8.0) — لمستخدمي Google تحديدًا.
 *
 * مسار البريد وكلمة المرور يقبل الشروط **قبل** إنشاء الحساب، فيُسجّلها
 * المُحفّز في user_consents لحظة الإنشاء. أمّا تسجيل Google فلا يملك فيه
 * المستخدم فرصة القبول قبل عودته من المزوّد، فيُنشأ حسابه **بلا صفوف موافقة**
 * عمدًا — وغيابها هو العلامة التي توقفه هنا.
 *
 * الفحص في تخطيط التطبيق لا في الوسيط: الوسيط يعمل على كل طلب بما فيه الأصول
 * الساكنة ومسارات API، وإضافة رحلة قاعدة هناك ثمنها على كل نقرة. التخطيط يعمل
 * على صفحات التطبيق وحدها، وهي بالضبط ما نريد حجبه.
 */

/** الوثيقتان المطلوبتان — قبول إحداهما لا يكفي */
export const REQUIRED_DOCUMENTS = ["terms", "privacy"] as const;

/**
 * هل قبل المستخدم الوثيقتين بالنسخة الحالية؟
 *
 * النسخة تُقارَن: تغيير `terms_version` في الإعدادات يعني وثيقة جديدة تحتاج
 * قبولًا جديدًا. وغياب النسخة من الإعدادات لا يعطّل البوابة — نقبل أي نسخة
 * مسجّلة حينئذ بدل أن نحبس الجميع خارج التطبيق بسبب إعداد ناقص.
 */
export async function hasAcceptedCurrentTerms(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const [{ data: setting }, { data: rows }] = await Promise.all([
    supabase.from("platform_settings").select("value").eq("key", "terms_version").maybeSingle(),
    supabase.from("user_consents").select("document, version").eq("user_id", userId),
  ]);

  const current = typeof setting?.value === "string" ? setting.value : null;
  const accepted = rows ?? [];
  if (accepted.length === 0) return false;

  return REQUIRED_DOCUMENTS.every((doc) =>
    accepted.some((r) => r.document === doc && (current === null || r.version === current)),
  );
}
