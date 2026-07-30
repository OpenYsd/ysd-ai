import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "../supabase/admin";
import { getConfiguredProviders, listModelOptions } from "./registry";

/**
 * إعدادات الذكاء الاصطناعي الإدارية (v0.8.0) — في platform_settings القائم.
 *
 * ما يُخزَّن هنا **قرارات** لا أسرار: أي مزوّد افتراضي، أي نموذج افتراضي، وأي
 * نماذج مسموحة. المفاتيح والعناوين تبقى في البيئة وحدها ولا تمرّ من هنا
 * إطلاقًا — قاعدة البيانات تُقرأ من مسارات كثيرة وتُنسخ احتياطيًا، فسرٌّ فيها
 * سرٌّ في كل نسخة.
 *
 * بلا migration: platform_settings جدول key/value موجود منذ 0009، وإضافة مفتاح
 * إدراج صفّ لا تغيير مخطط.
 */

export const AI_SETTING_KEYS = {
  defaultProvider: "ai.default_provider",
  defaultModel: "ai.default_model",
  allowedModels: "ai.allowed_models",
  modelsCache: "ai.models_cache",
} as const;

export interface AiModelsCache {
  /** لقطة آمنة: معرّفات وأسماء فقط — لا عناوين ولا مفاتيح */
  models: { id: string; name: string; providerId: string }[];
  updatedAt: string;
  count: number;
}

export interface AiSettings {
  defaultProvider: string | null;
  defaultModel: string | null;
  /** null = بلا تقييد (كل نماذج السجل مسموحة) · [] = لا شيء مسموح */
  allowedModels: string[] | null;
  modelsCache: Record<string, AiModelsCache>;
}

const KEYS = Object.values(AI_SETTING_KEYS);

/**
 * القائمة البيضاء الوحيدة المسموح بكتابتها عبر setAiSetting.
 * مُجمّدة عمدًا: تعديلها وقت التشغيل يُفرغ الحارس من معناه.
 */
export const ALLOWED_SETTING_KEYS = Object.freeze([...KEYS]) as readonly string[];

/** يقرأ الإعدادات الأربعة ويطهّرها — قيمة تالفة في القاعدة لا تُسقط المسار */
export async function getAiSettings(supabase: SupabaseClient): Promise<AiSettings> {
  const { data } = await supabase
    .from("platform_settings")
    .select("key, value")
    .in("key", KEYS);
  const raw: Record<string, unknown> = {};
  for (const r of data ?? []) raw[r.key as string] = r.value;

  const asString = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const allowed = raw[AI_SETTING_KEYS.allowedModels];
  return {
    defaultProvider: asString(raw[AI_SETTING_KEYS.defaultProvider]),
    defaultModel: asString(raw[AI_SETTING_KEYS.defaultModel]),
    allowedModels: Array.isArray(allowed)
      ? allowed.filter((x): x is string => typeof x === "string")
      : null,
    modelsCache:
      raw[AI_SETTING_KEYS.modelsCache] && typeof raw[AI_SETTING_KEYS.modelsCache] === "object"
        ? (raw[AI_SETTING_KEYS.modelsCache] as Record<string, AiModelsCache>)
        : {},
  };
}

/**
 * هل النموذج مسموح؟
 *
 * شرطان: أن يكون في سجل المزوّدين المهيّأ **وأن** يكون داخل allowlist إن وُجدت.
 * `allowedModels === null` تعني «بلا تقييد» لا «لا شيء مسموح» — والفرق جوهري:
 * الخلط بينهما يقفل المنتج كله على تثبيت جديد لم تُضبط فيه القائمة بعد.
 */
export function isModelAllowed(modelId: string, allowedModels: string[] | null): boolean {
  const inRegistry = listModelOptions().some((o) => o.id === modelId);
  if (!inRegistry) return false;
  if (allowedModels === null) return true;
  return allowedModels.includes(modelId);
}

/** النماذج المعروضة للمستخدم العادي — السجل مرشَّحًا بالـallowlist */
export function listAllowedModelOptions(allowedModels: string[] | null) {
  const all = listModelOptions();
  if (allowedModels === null) return all;
  return all.filter((o) => allowedModels.includes(o.id));
}

/**
 * النموذج الافتراضي لمحادثة جديدة.
 *
 * الترتيب: الافتراضي الإداري إن كان متاحًا ومسموحًا، وإلا أول مسموح من السجل.
 * إعدادٌ إداريٌّ يشير إلى نموذج اختفى لا يجوز أن يمنع إنشاء محادثة — يسقط
 * بهدوء إلى بديل صالح.
 */
export function resolveDefaultModel(settings: AiSettings): string | null {
  if (settings.defaultModel && isModelAllowed(settings.defaultModel, settings.allowedModels)) {
    return settings.defaultModel;
  }
  return listAllowedModelOptions(settings.allowedModels)[0]?.id ?? null;
}

/** المزوّدات المتاحة للوحة — مهيّأة فقط، بمعرّف وعنوان عرض آمنين */
export function listAdminProviders(): { id: string; displayName: string }[] {
  return getConfiguredProviders().map((p) => ({ id: p.id, displayName: p.displayName }));
}

/**
 * كتابة إعداد واحد.
 *
 * **لا تُستعمل عميل الطلب**: على platform_settings سياسة قراءة فقط
 * (`settings_read_all`) وبلا سياسة كتابة، فأي upsert بعميل المستخدم يُرفض
 * صامتًا بـRLS. رُصد حيًّا: PATCH كان يرد 200 وصفر صفوف تُكتب.
 *
 * والمسار الإداري القائم يكتب عبر RPC ‏`admin_set_platform_setting`، لكنه
 * `UPDATE ... where key = p_key` ويرد `not_found` لمفتاح غير موجود — فلا
 * يُنشئ مفاتيح `ai.*` الجديدة إلا بـmigration تُدرجها.
 *
 * فنكتب بعميل الخدمة **بعد** اجتياز حارس الإدارة في المسار: صلاحية مُتحقَّقة،
 * نطاق محصور في مفاتيح ai.* الأربعة، وبلا تغيير مخطط.
 *
 * ويُعاد النجاح صراحةً — والمستدعي **ملزم** بفحصه. الصيغة الأولى أهملت القيمة
 * فأعلن المسار نجاحًا على كتابة لم تقع، وهو أسوأ من الفشل لأنه يبدو سليمًا.
 */
export async function setAiSetting(
  supabase: SupabaseClient,
  key: (typeof AI_SETTING_KEYS)[keyof typeof AI_SETTING_KEYS],
  value: unknown,
  updatedBy: string | null,
): Promise<boolean> {
  /**
   * قائمة بيضاء **وقت التشغيل**، لا نوعية فقط.
   *
   * توقيع TypeScript يحصر المفتاح في الأربعة، لكنه يتبخّر عند البناء: أول
   * مستدعٍ غير مُنمَّط (قيمة من طلب، `as string`، جافاسكربت) يكتب أي مفتاح
   * بعميل الخدمة — أي بتجاوز RLS كاملًا. الحارس هنا يبقى بعد التصريف.
   *
   * والرفض يقع **قبل** إنشاء عميل الخدمة: لا نُنشئ عميلًا متجاوزًا للسياسات
   * من أجل طلب سنرفضه أصلًا.
   */
  if (!(ALLOWED_SETTING_KEYS as readonly string[]).includes(key)) {
    // اسم المفتاح المرفوض فقط — لا قيمته: قد تكون هي ما حاول المهاجم تسريبه
    console.error(`[ai-settings] rejected_key=${String(key).slice(0, 64)} reason=not_in_allowlist`);
    return false;
  }
  const admin = getAdminClient();
  if (!admin) {
    console.error("[ai-settings] service role غير مهيّأ — تعذّرت الكتابة");
    return false;
  }
  const { error } = await admin
    .from("platform_settings")
    .upsert(
      { key, value, owner_only: false, updated_by: updatedBy, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) {
    // رمز الخطأ فقط — لا نصّ القاعدة
    console.error(`[ai-settings] write failed key=${key} code=${error.code ?? "?"}`);
    return false;
  }
  void supabase; // عميل الطلب يبقى للقراءة الخاضعة لـRLS
  return true;
}
