import "server-only";

import { checkProviderUrl } from "./provider-config";
import type { DeploymentEnvironment } from "./model-registry";

/**
 * إعداد وقت تشغيل YSD — **خادميّ بحت، ومغلق افتراضيًّا** (v0.9.3، الرقعة الرابعة).
 *
 * ── ما يفعله ──
 *
 * يقرأ البيئة مرة واحدة ويُعيد إعدادًا **مُتحقَّقًا منه** أو سببًا مغلقًا.
 * ولا يطبع قيمة ولا جزءًا منها ولا طولها: إعدادٌ يحمل مفتاحًا، وسجلٌّ واحد
 * متساهل يكفي لتسريبه.
 *
 * ── ولماذا عَلَمان لا واحد ──
 *
 * `YSD_PROVIDER_ENABLED` يفتح **المزوّد** في السجلّ. و`YSD_RUNTIME_ENABLED`
 * يفتح **الاتصال بوقت التشغيل**. والفصل مقصود: قد نريد المزوّد ظاهرًا
 * للإدارة بلا أن يوجد وقت تشغيل خلفه، والعكس أثناء التجهيز. وربطُهما كان
 * سيجعل فتح أحدهما يفتح الآخر بلا قصد.
 */

/** لا يخرج من هنا سبب يحمل قيمة — رموز مغلقة فقط */
export type YSDRuntimeConfigFailureReason =
  | "disabled"
  | "missing_environment"
  | "invalid_environment"
  | "missing_alias"
  | "invalid_alias"
  | "missing_base_url"
  | "invalid_url"
  | "bad_scheme"
  | "insecure_in_production"
  | "embedded_credentials"
  | "url_query_not_allowed"
  | "url_hash_not_allowed"
  | "missing_api_key";

export interface YSDRuntimeConfig {
  deploymentEnvironment: DeploymentEnvironment;
  endpointAlias: string;
  baseUrl: string;
  apiKey: string;
}

export type YSDRuntimeConfigResult =
  | { ok: true; config: YSDRuntimeConfig }
  | { ok: false; reason: YSDRuntimeConfigFailureReason };

const fail = (reason: YSDRuntimeConfigFailureReason): YSDRuntimeConfigResult => ({
  ok: false,
  reason,
});

const ENVIRONMENTS: readonly DeploymentEnvironment[] = [
  "development",
  "staging",
  "production",
];

/** حدّ محافظ — الاسم المستعار معرّفٌ قصير لا مسار */
const MAX_ALIAS_LENGTH = 128;

/**
 * ★ الاسم المستعار **اسمٌ لا عنوان**.
 *
 * المسموح: حروف ASCII وأرقام ونقطة وشرطة وشرطة سفلية. ولا مائل ولا نقطتان
 * ولا فراغ — فلا يمكن لقيمةٍ في هذا الحقل أن تُقرأ يومًا كمسار أو كمضيف
 * أو كمنفذ. والمقارنة به مقارنة تطابقٍ لا بناء عنوان.
 */
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * يقرأ الإعداد من البيئة ويتحقق منه بالكامل.
 *
 * `env` مُحقَن اختياريًّا كي يُختبر بلا لمس بيئة العملية — والافتراض هو
 * `process.env` نفسه.
 */
export function readYSDRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): YSDRuntimeConfigResult {
  if (env.YSD_RUNTIME_ENABLED !== "1") return fail("disabled");

  // ── البيئة المستهدفة ──
  const rawEnvironment = (env.YSD_DEPLOYMENT_ENVIRONMENT ?? "").trim();
  if (rawEnvironment.length === 0) return fail("missing_environment");
  if (!ENVIRONMENTS.includes(rawEnvironment as DeploymentEnvironment)) {
    return fail("invalid_environment");
  }
  const deploymentEnvironment = rawEnvironment as DeploymentEnvironment;

  // ── الاسم المستعار ──
  const alias = (env.YSD_RUNTIME_ENDPOINT_ALIAS ?? "").trim();
  if (alias.length === 0) return fail("missing_alias");
  if (alias.length > MAX_ALIAS_LENGTH) return fail("invalid_alias");
  if (!ALIAS_PATTERN.test(alias)) return fail("invalid_alias");

  // ── العنوان ──
  const rawUrl = (env.YSD_RUNTIME_BASE_URL ?? "").trim();
  if (rawUrl.length === 0) return fail("missing_base_url");

  /**
   * ★ يُعاد استعمال حارس المزوّدين القائم لا يُكتب حارسٌ ثانٍ.
   *
   * `source: "env"` لأن العنوان يضبطه المشغّل لا المستخدم — وهو ما يسمح
   * بمضيف داخليّ في الإنتاج وفق سياسة المشروع القائمة. وحارسان لقاعدة
   * واحدة يفترقان يومًا، وقد رأينا ذلك في هذا المشروع أكثر من مرة.
   */
  const checked = checkProviderUrl(rawUrl, {
    source: "env",
    isProduction: process.env.NODE_ENV === "production",
  });
  if (!checked.ok) {
    // الأسباب المشتركة تُمرَّر كما هي؛ وما لا يخصّ هذا المسار يُعمَّم
    if (
      checked.reason === "invalid_url" ||
      checked.reason === "bad_scheme" ||
      checked.reason === "insecure_in_production"
    ) {
      return fail(checked.reason);
    }
    return fail("invalid_url");
  }

  /**
   * ★ قيود إضافية فوق الحارس المشترك.
   *
   * بيانات اعتماد داخل العنوان تعني مفتاحًا في سجلّ أو في رسالة خطأ.
   * والاستعلام والشذرة لا معنى لهما في **جذر واجهة**، ووجودهما يعني إما
   * إعدادًا خاطئًا أو محاولة حقن معامل في كل نداء.
   */
  const parsed = new URL(checked.url);
  if (parsed.username !== "" || parsed.password !== "") return fail("embedded_credentials");
  if (parsed.search !== "") return fail("url_query_not_allowed");
  if (parsed.hash !== "") return fail("url_hash_not_allowed");

  // المائل الأخير يُطبَّع مرة واحدة هنا، فلا يبنيه كل مستدعٍ بطريقته
  const baseUrl = checked.url.replace(/\/+$/, "");

  // ── المفتاح ──
  const apiKey = (env.YSD_RUNTIME_API_KEY ?? "").trim();
  if (apiKey.length === 0) return fail("missing_api_key");

  return {
    ok: true,
    config: { deploymentEnvironment, endpointAlias: alias, baseUrl, apiKey },
  };
}
