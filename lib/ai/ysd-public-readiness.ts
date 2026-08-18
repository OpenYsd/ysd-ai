import "server-only";

import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "./ysd";
import { isYSDAlphaActivationEnabled } from "./ysd-activation";
import { AI_SETTING_KEYS } from "./ai-settings";
import { getConfiguredProviders } from "./registry";
import { getAdminClient } from "@/lib/supabase/admin";
import type { AIProviderAdapter } from "./types";

/**
 * جاهزية الفتح العامّ لنموذج YSD (v0.9.3، الرقعة الحادية عشرة) — **قراءةٌ خالصة**.
 *
 * ── السؤال الذي تجيبه ──
 *
 * «هل كل شيءٍ مهيّأ بحيث تكون الخطوة التالية الآمنة هي **فقط** فتح
 * المفتاح؟»
 *
 * ولا تفتحه. ولا تكتب في القاعدة حرفًا. ولا تولّد رمزًا واحدًا.
 *
 * ── ولماذا `ready: true` مع `publiclyEnabled: false` ليس تناقضًا ──
 *
 * هما جوابا سؤالين مختلفين: الأول «أيجوز أن نخطو؟»، والثاني «أخطونا؟».
 * وخلطهما هو بالضبط ما بنت هذه السلسلة كلها لتمنعه — أن يصير التحقّق من
 * الإمكان إذنًا بالفعل.
 *
 * ── والترتيب هو معناها ──
 *
 *   المالك ⇐ المفتاح مغلق ⇐ المزوّد مهيّأ ⇐ أهليّة القاعدة
 *   ⇐ قائمة السماح ⇐ **وأخيرًا** الفحص.
 *
 * والفحص آخرًا لأنه رحلة شبكة: لا تُدفع كلفتها وأهليّةُ القاعدة مغلقة
 * أصلًا، أو قائمةُ السماح تمنع النموذج. وترتيبٌ يبدأ بالأغلى يجعل كل
 * محاولةٍ فاشلة تكلّف ما لا داعي له.
 *
 * ── وما لا تفعله ──
 *
 * لا توليد. `chat/completions` قرارٌ آخر: اختبارُ توليدٍ اصطناعيّ قبل
 * الفتح مسألةٌ تُدرس وحدها، وخلطُها بقرار البوّابة يجعل زرًّا واحدًا
 * يستهلك رموزًا في كل ضغطة.
 */

export type YSDPublicReadinessResult =
  | { ok: true; ready: true; publiclyEnabled: false }
  | {
      ok: false;
      ready: false;
      reason:
        | "owner_required"
        | "kill_switch_must_be_off"
        | "provider_not_configured"
        | "admin_client_unavailable"
        | "model_not_found"
        | "model_gate_off"
        | "allowlist_blocked"
        | "allowlist_invalid"
        | "health_not_connected"
        | "database_error";
    };

const fail = (reason: Exclude<YSDPublicReadinessResult, { ok: true }>["reason"]) =>
  ({ ok: false, ready: false, reason }) as const;

const READY = { ok: true, ready: true, publiclyEnabled: false } as const;

/** الحدّ الأدنى مما يُقرأ من صفّ النموذج — بأعمدة صريحة لا `*` */
interface ModelRow {
  id: string;
  provider_id: string;
  enabled: boolean;
}

export interface YSDPublicReadinessDependencies {
  isKillSwitchOn: () => boolean;
  listConfiguredProviders: () => AIProviderAdapter[];
  getAdminClient: typeof getAdminClient;
}

const DEFAULTS: YSDPublicReadinessDependencies = {
  isKillSwitchOn: () => isYSDAlphaActivationEnabled(),
  listConfiguredProviders: getConfiguredProviders,
  getAdminClient,
};

/**
 * ★ يقرأ قائمة السماح ويحكم عليها — ولا يتساهل مع الفساد.
 *
 * ── لماذا لا تُستعمل `isModelAllowed` ──
 *
 * تلك تسأل «أيظهر هذا النموذج للمستخدم الآن؟»، وجوابها اليوم «لا» لأن
 * المفتاح مغلق — وهو الشرط الذي نتحقّق منه عمدًا. فاستعمالُها هنا يجعل
 * الفحص يفشل دائمًا لسببٍ نحن الذين اشترطناه.
 *
 * والسؤال المقصود مختلف: «حين يُفتح المفتاح، أستسمح القائمة بالنموذج؟».
 * فتُقرأ القيمة نفسها ويُحكم عليها مباشرةً.
 *
 * ── ولماذا التشدّد مع التالف ──
 *
 * قيمةٌ لا نفهم شكلها لا تعني «لا قيد»؛ تعني أننا لا نعرف ما القيد.
 * والتساهلُ هنا يجعل إعدادًا فاسدًا يوافق على فتحٍ عامّ — وهو أسوأ ما
 * يمكن أن يقوله فحصُ جاهزية.
 */
function judgeAllowlist(
  value: unknown,
): "pass" | "allowlist_blocked" | "allowlist_invalid" {
  // لا صفّ أو قيمة غائبة ⇒ لا قيد
  if (value === null || value === undefined) return "pass";
  if (!Array.isArray(value)) return "allowlist_invalid";
  if (value.some((v) => typeof v !== "string")) return "allowlist_invalid";
  return value.includes(YSD_ALPHA_MODEL_ID) ? "pass" : "allowlist_blocked";
}

/**
 * ★ يجيب: أنحن جاهزون لفتح المفتاح؟ — ولا يفتحه.
 *
 * @param isOwner من سياق الإدارة. لا تُقرأ الأدوار هنا: المستدعي أثبت
 *   الهوية سلفًا، وإعادةُ التحقّق من مكانٍ ثانٍ تخلق مصدرين للحقيقة.
 */
export async function checkYSDPublicActivationReadiness(
  isOwner: boolean,
  deps: Partial<YSDPublicReadinessDependencies> = {},
): Promise<YSDPublicReadinessResult> {
  const d = { ...DEFAULTS, ...deps };

  // ★ (١) المالك وحده — قبل أي قاعدة وأي شبكة
  if (isOwner !== true) return fail("owner_required");

  /**
   * ★ (٢) والمفتاح ما يزال مغلقًا.
   *
   * هذه الدالة تسأل «أنحن جاهزون للفتح؟» لا «أمفتوحٌ الآن؟». فمفتاحٌ
   * مفتوح أصلًا يعني أن السؤال فات أوانه — و«جاهز» حينها جوابٌ عن سؤالٍ
   * لم يُسأل، يوهم المشغّل بأن فحصًا وقع قبل الفتح ولم يقع.
   */
  if (d.isKillSwitchOn()) return fail("kill_switch_must_be_off");

  /**
   * ★ (٣) والمزوّد مهيّأ.
   *
   * ويُثبت ذلك ضمنًا ثلاثةً معًا — العَلَم، وإعداد وقت التشغيل، وصلاحية
   * السجلّ — لأن `isConfigured` تشترطها جميعًا. فلا تُكرَّر هنا.
   */
  const provider = d.listConfiguredProviders().find((p) => p.id === YSD_PROVIDER_ID);
  if (!provider) return fail("provider_not_configured");

  let admin;
  try {
    admin = d.getAdminClient();
  } catch {
    return fail("admin_client_unavailable");
  }
  if (!admin) return fail("admin_client_unavailable");

  /**
   * ★ (٤) أهليّة القاعدة — تُقرأ ولا تُكتب.
   *
   * هذه الرقعة **لا تفعّل** الصفّ: تتحقّق أن التدرّج وقع سابقًا بقرارٍ
   * مستقلّ. ودالةٌ تُصلح ما تفحصه ليست فحصًا بل تنفيذًا صامتًا.
   */
  let row: ModelRow | null;
  try {
    const { data, error } = await admin
      .from("ai_models")
      .select("id, provider_id, enabled")
      .eq("id", YSD_ALPHA_MODEL_ID)
      .limit(2);
    if (error) return fail("database_error");
    const rows = (data ?? []) as ModelRow[];
    if (rows.length === 0) return fail("model_not_found");
    // المعرّف مفتاحٌ أساسيّ — فصفّان به يعني سجلًّا لا نفهمه
    if (rows.length !== 1) return fail("database_error");
    row = rows[0] ?? null;
  } catch {
    return fail("database_error");
  }

  if (!row || row.id !== YSD_ALPHA_MODEL_ID) return fail("model_not_found");
  if (row.provider_id !== YSD_PROVIDER_ID) return fail("database_error");
  if (row.enabled !== true) return fail("model_gate_off");

  // ★ (٥) وقائمة السماح — انظر `judgeAllowlist` أعلاه
  let allowlistValue: unknown;
  try {
    const { data, error } = await admin
      .from("platform_settings")
      .select("key, value")
      .eq("key", AI_SETTING_KEYS.allowedModels)
      .limit(2);
    if (error) return fail("database_error");
    const rows = (data ?? []) as Array<{ key: string; value: unknown }>;
    if (rows.length > 1) return fail("database_error");
    // لا صفّ ⇒ لا قيد
    allowlistValue = rows.length === 0 ? null : rows[0]?.value;
  } catch {
    return fail("database_error");
  }

  const verdict = judgeAllowlist(allowlistValue);
  if (verdict !== "pass") return fail(verdict);

  /**
   * ★ (٦) والفحص أخيرًا — وهو وحده رحلة شبكة.
   *
   * ونجاحُه يُثبت سلسلة الرقع كلها في نداءٍ واحد: هدفٌ في السجلّ، ونسخةٌ
   * معتمدة، ونشرةٌ نشطة، ووقت تشغيلٍ يُجيب، والنموذج المطلوب محمَّلٌ فيه
   * بالاسم نفسه.
   */
  if (typeof provider.healthCheck !== "function") return fail("health_not_connected");

  let health;
  try {
    health = await provider.healthCheck();
  } catch {
    // استثناءٌ من الفاحص يُبتلع رمزًا — لا نصّ يصل لوحة الإدارة
    return fail("health_not_connected");
  }
  if (health.status !== "connected") return fail("health_not_connected");

  return READY;
}
