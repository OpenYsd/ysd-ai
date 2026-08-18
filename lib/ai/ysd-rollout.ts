import "server-only";

import { YSD_ALPHA_MODEL_ID, YSD_PROVIDER_ID } from "./ysd";
import { isYSDAlphaActivationEnabled } from "./ysd-activation";
import { getConfiguredProviders } from "./registry";
import { getAdminClient } from "@/lib/supabase/admin";
import type { AIProviderAdapter } from "./types";

/**
 * تدرّج أهليّة نموذج YSD في القاعدة (v0.9.3، الرقعة التاسعة).
 *
 * ── ما هذه الخطوة، وما ليست ──
 *
 * ترفع `ai_models['ysd/model-alpha'].enabled` إلى `true` — وذلك **تجهيزٌ
 * لا نشر**. فالخدمة العامّة تحتاج بوّابتين أخريين، وأولاهما مفتاح الإذن
 * الذي يبقى مغلقًا هنا شرطًا لا صدفة.
 *
 * ── ولماذا الترتيب هو الأمان ──
 *
 * كل فحصٍ يسبق ما هو أخطر منه:
 *
 *   المالك ⇐ المفتاح مغلق ⇐ المزوّد مهيّأ ⇐ الفحص يقول «متصل»
 *   ⇐ **وبعدها وحدها** تُفتح صلاحية الخدمة وتُكتب القاعدة.
 *
 * ولو انعكس ترتيبان منها لَصارت العملية شيئًا آخر: كتابةٌ قبل الفحص
 * تُفعّل ما لم يُثبت أنه يعمل، وقبولُ المفتاح مفتوحًا يجعل هذه الدالة
 * نفسها نشرًا عامًّا فوريًّا بدل أن تكون تجهيزًا له.
 *
 * ── ولا يخرج منها نصٌّ خام ──
 *
 * الأسباب رموزٌ مغلقة: لا خطأ قاعدة، ولا معرّف نشرة، ولا عنوان، ولا
 * مفتاح. ولوحةُ إدارةٍ تعرض خطأ PostgreSQL نصًّا تكشف شكل الجداول لمن
 * يقرأ الشاشة.
 */

export type YSDEligibilityStageResult =
  | { ok: true; alreadyEnabled: boolean }
  | {
      ok: false;
      reason:
        | "owner_required"
        | "kill_switch_must_be_off"
        | "provider_not_configured"
        | "health_not_connected"
        | "admin_client_unavailable"
        | "database_error"
        | "model_not_found";
    };

const fail = (reason: Exclude<YSDEligibilityStageResult, { ok: true }>["reason"]) =>
  ({ ok: false, reason }) as const;

/** الحدّ الأدنى مما نقرؤه من الصفّ — بأعمدة صريحة لا `*` */
interface ModelRow {
  id: string;
  provider_id: string;
  enabled: boolean;
}

/** ما تحتاجه الدالة من العالم — يُحقن كي تُختبر بلا قاعدة ولا شبكة */
export interface YSDRolloutDependencies {
  isKillSwitchOn: () => boolean;
  listConfiguredProviders: () => AIProviderAdapter[];
  getAdminClient: typeof getAdminClient;
}

const DEFAULTS: YSDRolloutDependencies = {
  isKillSwitchOn: () => isYSDAlphaActivationEnabled(),
  listConfiguredProviders: getConfiguredProviders,
  getAdminClient,
};

/**
 * ★ يُجهّز أهليّة القاعدة — ولا يفتح الخدمة.
 *
 * @param isOwner من سياق الإدارة. لا تُقرأ الأدوار هنا: المستدعي أثبت
 *   الهوية سلفًا، وإعادةُ التحقّق من مكانٍ ثانٍ تخلق مصدرين للحقيقة.
 */
export async function stageYSDDatabaseEligibility(
  isOwner: boolean,
  deps: Partial<YSDRolloutDependencies> = {},
): Promise<YSDEligibilityStageResult> {
  const d = { ...DEFAULTS, ...deps };

  /**
   * ★ (١) المالك وحده — والمشرف لا يكفي.
   *
   * تفعيل نموذج المنصّة قرارٌ يُتّخذ مرةً ويصعب التراجع عنه بلا أثر:
   * سيصل النموذج مستخدمين، وستُسجَّل محادثاتٌ منسوبةٌ إليه. وصلاحيةُ
   * الإشراف اليومي أوسع من أن تحمل هذا.
   */
  if (isOwner !== true) return fail("owner_required");

  /**
   * ★ (٢) والمفتاح مغلق — قبل أي فحصٍ وأي كتابة.
   *
   * لو كان مفتوحًا لَصارت هذه الكتابة **نشرًا عامًّا فوريًّا**: البوّابتان
   * الباقيتان مفتوحتان أصلًا، فيصل النموذج المستخدمين في اللحظة نفسها.
   * والخطوتان منفصلتان عمدًا كي يُراجَع كلٌّ منهما وحده — ومن أراد
   * النشر أغلق المفتاح، جهّز، ثم فتحه بقرارٍ ثانٍ.
   */
  if (d.isKillSwitchOn()) return fail("kill_switch_must_be_off");

  const provider = d.listConfiguredProviders().find((p) => p.id === YSD_PROVIDER_ID);
  if (!provider) return fail("provider_not_configured");

  /**
   * ★ (٣) والفحص شرطٌ لا زينة.
   *
   * مزوّدٌ بلا فاحص لا يستطيع أن يُثبت شيئًا، وقبولُه يعني تفعيلًا على
   * أمل. وهذا كل ما بنته الرقعة السابعة: ألّا يُفتح شيء بلا دليل.
   */
  if (typeof provider.healthCheck !== "function") return fail("health_not_connected");

  let health;
  try {
    health = await provider.healthCheck();
  } catch {
    // استثناءٌ من الفاحص يُبتلع رمزًا — لا نصّ يصل لوحة الإدارة
    return fail("health_not_connected");
  }

  /**
   * `connected` وحدها تمرّ. و`no_models` أخطر ما يُغرى بقبوله: تعني أن
   * وقت التشغيل حيّ ولا يحمل نموذجنا — وهي بالضبط الحالة التي وُجد
   * الفحص لأجلها.
   */
  if (health.status !== "connected") return fail("health_not_connected");

  let admin;
  try {
    admin = d.getAdminClient();
  } catch {
    return fail("admin_client_unavailable");
  }
  if (!admin) return fail("admin_client_unavailable");

  /**
   * ★ (٤) يُقرأ الصفّ قبل الكتابة — بأعمدة صريحة.
   *
   * و`provider_id` يُتحقَّق منه: صفٌّ بهذا المعرّف يملكه مزوّدٌ آخر يعني
   * أن السجلّ ليس ما نظنّه. والكتابة على سجلٍّ لا نفهمه أسوأ من الامتناع.
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
    // المعرّف مفتاحٌ أساسيّ — فصفّان بالمعرّف نفسه يعني سجلًّا لا نفهمه
    if (rows.length !== 1) return fail("database_error");
    row = rows[0] ?? null;
  } catch {
    return fail("database_error");
  }

  if (!row || row.id !== YSD_ALPHA_MODEL_ID) return fail("model_not_found");
  if (row.provider_id !== YSD_PROVIDER_ID) return fail("database_error");

  /**
   * ★ مُفعَّلٌ سلفًا ⇒ نجاحٌ موسوم — **بعد** اجتياز الفحوص كلها.
   *
   * ولا يُختصر الطريق إليه: الخروج المبكر كان سيجعل الاستدعاء الثاني
   * يقول «تمّ» بلا أن يمسّ الفحص شيئًا — فيُعلن نجاح تدرّجٍ على بنيةٍ
   * قد تكون انكسرت بعد الأول.
   */
  if (row.enabled === true) return { ok: true, alreadyEnabled: true };

  /**
   * ★ (٥) الكتابة: تحديثٌ لصفٍّ قائم، لا إنشاء.
   *
   * لا `upsert` ولا `insert`: هوية النموذج تملكها الترحيلة `0036` وحدها.
   * وصفٌّ يُنشئه مسارُ تفعيل هو صفٌّ بلا مراجعة — يحمل ما تصادف أن
   * كتبناه هنا لا ما قرّرته الترحيلة.
   */
  try {
    const { data, error } = await admin
      .from("ai_models")
      .update({ enabled: true })
      .eq("id", YSD_ALPHA_MODEL_ID)
      .eq("provider_id", YSD_PROVIDER_ID)
      .select("id");
    if (error) return fail("database_error");
    // صفٌّ واحد بالضبط — لا صفر ولا أكثر
    if ((data ?? []).length !== 1) return fail("database_error");
  } catch {
    return fail("database_error");
  }

  return { ok: true, alreadyEnabled: false };
}
