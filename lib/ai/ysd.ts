import "server-only";

import type {
  AIProviderAdapter,
  ChatRequest,
  ModelInfo,
  ProviderHealth,
  StreamChunk,
} from "./types";
import type { ModelDeploymentRecord, ModelVersionRecord } from "./model-registry";
import { readYSDRuntimeConfig, type YSDRuntimeConfig } from "./ysd-runtime-config";
import {
  checkYSDRuntimeReadiness,
  requestYSDRuntimeJsonCompletion,
  streamYSDRuntimeChat,
  type YSDRuntimeFailureReason,
  type YSDRuntimeReadinessResult,
} from "./ysd-runtime-client";
import { resolveServableDeployment } from "./model-registry-resolver";
import { getAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";
import { ERROR_MESSAGES, type ChatErrorCode } from "./error-codes";
import { isYSDAlphaActivationEnabled } from "./ysd-activation";

/**
 * YSD — مزوّد نموذج المنصّة، **موصولٌ بالكامل وخاملٌ بالكامل**.
 *
 * ── ما تغيّر في هذه الرقعة ──
 *
 * صار المسار حقيقيًّا من طرفه إلى طرفه:
 *
 *   إعداد وقت التشغيل → عميل السجلّ الخادميّ → حلّ النشرة الصالحة
 *   → ناقل وقت التشغيل
 *
 * ولم يتغيّر شيء للمستخدم: `ysd/model-alpha` ما يزال `enabled: false`، فلا
 * يظهر في قائمة ولا يُوجَّه إليه طلب. توصيلٌ لا تفعيل — يُختبر الأنبوب
 * كاملًا قبل أن يُفتح الصنبور.
 *
 * ── وثلاث طبقات تمنع الخدمة اليوم ──
 *
 *   (١) `YSD_PROVIDER_ENABLED` مغلق ⇒ يرشّحه السجلّ فلا يصله طلب.
 *   (٢) إعداد وقت التشغيل غير مكتمل ⇒ `isConfigured` تردّ `false`.
 *   (٣) النموذج `enabled: false` ⇒ لا يظهر ولا يُختار.
 *
 * ── ولا عبور لحدود المزوّد ──
 *
 * `fallbackPolicy = "none"` و`fallbackEligible = false`: فشلُ السجلّ أو
 * وقت التشغيل يبقى فشل YSD، ولا يُحوَّل الطلب إلى Groq أو OpenRouter.
 * فالمستخدم الذي اختار نموذج المنصّة يريده هو؛ وإجابةٌ من غيره تحت اسمه
 * أسوأ من عطلٍ صريح — لأن العطل يظهر والاستبدال لا يظهر.
 */

export const YSD_PROVIDER_ID = "ysd";

/** معرّف نموذج المنصّة الأول — محجوز الآن، غير مفعَّل */
export const YSD_ALPHA_MODEL_ID = "ysd/model-alpha";

/**
 * ★ قيمة تعاقدية مؤقتة — **ليست قدرة مقيسة**.
 *
 * وُضعت محافظةً عمدًا كي لا تُبنى عليها قرارات إنتاج (تقدير رموز، تقليم
 * سياق، اختيار نموذج). وتُستبدل بالقيمة الحقيقية حين يُقاس السياق فعلًا.
 */
const CONTRACT_PLACEHOLDER_CONTEXT_WINDOW = 8_192;

/**
 * ★ اعتمادات المزوّد — تُحقن كاملةً.
 *
 * لولا ذلك لَاحتاج اختبارُ مسارٍ من أربع طبقات محاكاةً عامّة هشّة تُطابق
 * الوحدات بأسمائها. والحقن يجعل كل فرعٍ قابلًا للقياس بلا شبكة ولا قاعدة
 * ولا سرّ — وهو شرطُ أن نثق بالخمول نفسه.
 */
export interface YSDProviderDependencies {
  readRuntimeConfig: typeof readYSDRuntimeConfig;
  hasRegistryAccess: () => boolean;
  getAdminClient: typeof getAdminClient;
  resolveDeployment: typeof resolveServableDeployment;
  streamRuntimeChat: typeof streamYSDRuntimeChat;
  requestRuntimeJsonCompletion: typeof requestYSDRuntimeJsonCompletion;
  /** مِسبار الجاهزية — يُحقن كي يُختبر الفاحص كاملًا بلا شبكة */
  checkRuntimeReadiness: typeof checkYSDRuntimeReadiness;
}

/**
 * جاهزية السجلّ — **تهيئةٌ لا اتصال**.
 *
 * تُقرأ في `isConfigured` التي تُستدعى في كل طلب تقريبًا، فرحلةٌ شبكية هنا
 * تكلّف كل طلبٍ في النظام. والسؤال المقصود «هل يمكن أن نتصل؟» لا «هل
 * اتصلنا؟» — والثانية تُجاب عند الحاجة لا قبلها.
 *
 * ولا تُقرأ قيمة المفتاح ولا تُمرَّر: `isServiceRoleConfigured` تقول
 * «موجود» ولا تكشف شيئًا.
 */
function defaultHasRegistryAccess(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (typeof url !== "string" || url.trim().length === 0) return false;
  return isServiceRoleConfigured();
}

const DEFAULTS: YSDProviderDependencies = {
  readRuntimeConfig: readYSDRuntimeConfig,
  hasRegistryAccess: defaultHasRegistryAccess,
  getAdminClient,
  resolveDeployment: resolveServableDeployment,
  streamRuntimeChat: streamYSDRuntimeChat,
  requestRuntimeJsonCompletion: requestYSDRuntimeJsonCompletion,
  checkRuntimeReadiness: checkYSDRuntimeReadiness,
};

/** الهدف المحلول — داخليّ بحت، لا يخرج منه شيء إلى المستخدم */
interface RuntimeTarget {
  config: YSDRuntimeConfig;
  deployment: ModelDeploymentRecord;
  version: ModelVersionRecord;
}

/**
 * ★ لماذا صار «لا هدف» أربعةَ أسبابٍ لا واحدًا.
 *
 * `null` كان كافيًا للبثّ: المستخدم يرى تعذّرًا عامًّا في الحالتين، ولا
 * يعنيه أهو السجلّ أم النشرة. أما المشرف الذي يضغط «اختبار الاتصال» فيسأل
 * سؤالًا مختلفًا: **ما الذي أُصلحه؟** و«غير متصل» جوابٌ لا يدلّه على شيء.
 *
 *   `not_configured`        ⇐ إعدادٌ ناقص — أصلحه في البيئة، ولم تُلمس القاعدة.
 *   `registry_unavailable`  ⇐ القاعدة لم تُجب — العطل خارج بيانات النماذج.
 *   `no_servable_deployment`⇐ القاعدة أجابت ولا نشرة صالحة — أصلحه في السجلّ.
 *   `unsupported_model`     ⇐ معرّفٌ ليس لنا — خطأ برمجيّ لا تشغيليّ.
 *
 * والأربعة **مغلقة**: لا يخرج سبب الحلّال الخام من هذا الحاجز، فلا يتسرّب
 * إلى واجهةٍ إدارية شكلُ الجداول ولا مفرداتها.
 */
type RuntimeTargetResolution =
  | { ok: true; target: RuntimeTarget }
  | {
      ok: false;
      reason:
        | "unsupported_model"
        | "not_configured"
        | "registry_unavailable"
        | "no_servable_deployment";
    };

/**
 * ★ تحويل سبب وقت التشغيل إلى رمز خطأ عامّ.
 *
 * `YSDRuntimeFailureReason` مفردات داخلية تصف **أين** تعثّر المسار. ولا
 * يعني المستخدمَ ذلك: أهو السجلّ أم النسخة أم وقت التشغيل؟ سؤالٌ تشغيليّ
 * لا يغيّر ما يفعله. فيُختصر إلى ما يفيده: أهي مهلة، أم ضغط، أم انقطاع،
 * أم تعذّرٌ عامّ.
 */
function errorCodeFor(reason: YSDRuntimeFailureReason): ChatErrorCode {
  switch (reason) {
    case "rate_limit":
      return "rate_limit";
    case "timeout":
      return "timeout";
    case "network_error":
      return "network_error";
    default:
      // unauthorized · runtime_unavailable · invalid_response · stream_error · invalid_target
      return "provider_unavailable";
  }
}

/** إطار الخطأ العامّ — الرسالة من المصدر المركزيّ لا من هنا */
const providerError = (code: ChatErrorCode = "provider_unavailable"): StreamChunk => ({
  type: "error",
  error: ERROR_MESSAGES[code],
  errorCode: code,
});

export class YSDProvider implements AIProviderAdapter {
  readonly id = YSD_PROVIDER_ID;
  readonly displayName = "YSD";

  readonly userSelectable = true;
  readonly supportsStreaming = true;
  readonly supportsTools = false;
  readonly supportsVision = false;

  /** لا عبور لحدود المزوّد — انظر شرح الرأس */
  readonly fallbackPolicy = "none" as const;

  /**
   * ولا يصلح بديلًا لأحد في هذه المرحلة — لا خدمة خلفه بعد.
   *
   * وهي الوجه الآخر من `fallbackPolicy`: تلك تمنع الخروج منه، وهذه تمنع
   * الدخول إليه. فلا يُحوَّل طلبه إلى غيره، ولا يُحوَّل إليه طلب غيره.
   */
  readonly fallbackEligible = false;

  private readonly deps: YSDProviderDependencies;

  constructor(deps: Partial<YSDProviderDependencies> = {}) {
    this.deps = { ...DEFAULTS, ...deps };
  }

  /**
   * ★ ثلاثة شروط لا واحد — والعَلَم أضعفها.
   *
   * كان `YSD_PROVIDER_ENABLED` وحده كافيًا، وذلك إعلانٌ كاذب: يقول «المزوّد
   * جاهز» بينما قد يغيب عنوان وقت التشغيل أو مفتاحه أو صلاحية السجلّ.
   * فيصل الطلب إلى مزوّدٍ لا يستطيع خدمته، ويظهر العطل عند المستخدم بدل
   * أن يُمنع الطلب أصلًا.
   *
   * ولا قاعدة ولا شبكة ولا `getAdminClient` هنا: تُستدعى في كل طلب تقريبًا،
   * ورحلةٌ واحدة فيها تكلّف النظام كلَّه.
   */
  isConfigured(): boolean {
    if (process.env.YSD_PROVIDER_ENABLED !== "1") return false;
    if (!this.deps.readRuntimeConfig().ok) return false;
    return this.deps.hasRegistryAccess() === true;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: YSD_ALPHA_MODEL_ID,
        providerId: YSD_PROVIDER_ID,
        displayNameAr: "نموذج YSD (ألفا)",
        displayNameEn: "YSD Model (Alpha)",
        contextWindow: CONTRACT_PLACEHOLDER_CONTEXT_WINDOW,
        /**
         * ★ مفتاح الإذن وحده — لا التهيئة ولا الجاهزية.
         *
         * كان `false` ثابتًا لأن الرقعات السابقة لم تكن تملك ما تأذن به.
         * والآن صار للإذن مفتاحه: `YSD_MODEL_ALPHA_ENABLED=1` وحدها ترفعه.
         *
         * ولا فحص هنا ولا قاعدة ولا `await`: هذه الدالة تُستدعى في بناء كل
         * قائمة نماذج — رحلةٌ واحدة فيها تكلّف كل صفحةٍ في النظام. وجاهزية
         * وقت التشغيل تُفحص بالزرّ الإداريّ قبل فتح المفتاح، لا في كل نداء.
         *
         * ورفعُه هنا **لا يفتح الخدمة** وحده: أهليّة القاعدة ما تزال `false`
         * في `0036`، و`/api/models` تشترطها صراحةً.
         */
        enabled: isYSDAlphaActivationEnabled(),
      },
    ];
  }

  /**
   * يحلّ الهدف الصالح للخدمة — أو `null` بلا تفصيل.
   *
   * الترتيب مقصود: كل فحصٍ أرخص يسبق ما هو أغلى منه. فلا رحلة قاعدة قبل
   * أن يثبت اكتمال الإعداد، ولا نداء وقت تشغيل قبل أن تثبت النشرة.
   *
   * وكل وصولٍ إلى القاعدة يمرّ بالحلّال وحده — لا استعلام مباشر من هنا.
   */
  /**
   * ★ بوّابة الخدمة العامّة — **لا يمرّ منها الفاحص**.
   *
   * تُستدعى من `streamChat` و`requestJsonCompletion` قبل أي قاعدة وأي
   * شبكة. ولا تُستدعى من `healthCheck` عمدًا: المشرف يحتاج أن يُثبت أن
   * السلسلة تعمل **قبل** أن يفتح المفتاح، فلو خضع الفحص للمفتاح لصار
   * الشرط دائريًّا — لا يُفتح حتى يُفحص، ولا يُفحص حتى يُفتح.
   *
   * وهي هنا لا في السجلّ وحده: السجلّ يمنع **التوجيه**، وهذه تمنع
   * **الخدمة**. فلو استُدعي المزوّد مباشرةً، أو تجاوز مستدعٍ
   * `resolveProviderForModel` بخطأ، لا يزال المفتاح قائمًا. وحارسٌ في
   * طبقةٍ واحدة يسقط بخطأٍ واحد.
   */
  private isServingEnabled(modelId: string): boolean {
    if (modelId !== YSD_ALPHA_MODEL_ID) return false;
    return isYSDAlphaActivationEnabled();
  }

  private async resolveRuntimeTarget(modelId: string): Promise<RuntimeTargetResolution> {
    /**
     * ★ نموذج واحد مملوك — لا وكالة عامّة.
     *
     * بلا هذا الشرط يصير المزوّد بابًا لأي معرّفٍ في القاعدة: يكفي صفٌّ
     * مكتوبٌ بخطأ ليُوجَّه إليه طلب تحت اسم YSD.
     */
    if (modelId !== YSD_ALPHA_MODEL_ID) return { ok: false, reason: "unsupported_model" };

    if (process.env.YSD_PROVIDER_ENABLED !== "1") {
      return { ok: false, reason: "not_configured" };
    }

    const configResult = this.deps.readRuntimeConfig();
    if (!configResult.ok) return { ok: false, reason: "not_configured" };

    if (this.deps.hasRegistryAccess() !== true) {
      return { ok: false, reason: "not_configured" };
    }

    let client;
    try {
      client = this.deps.getAdminClient();
    } catch {
      // عطلٌ غير متوقّع في إنشاء العميل — يُبتلع رمزًا لا نصًّا
      return { ok: false, reason: "registry_unavailable" };
    }
    if (!client) return { ok: false, reason: "registry_unavailable" };

    let resolution;
    try {
      resolution = await this.deps.resolveDeployment(
        client,
        modelId,
        configResult.config.deploymentEnvironment,
      );
    } catch {
      return { ok: false, reason: "registry_unavailable" };
    }

    if (!resolution.ok) {
      /**
       * ★ `invalid_input` يُصنَّف عطلَ سجلٍّ لا نقصَ نشرة — عمدًا.
       *
       * المعرّف والبيئة يأتيان من هنا: الأول ثابتٌ في الكود، والثانية من
       * إعدادٍ تحقّقنا منه قبل سطرين. فرفضُ الحلّال لهما يعني خللًا في
       * برنامجنا لا في بيانات السجلّ. و«لا نشرة صالحة» كان سيرسل المشرف
       * يفتّش جداولَ لا عيب فيها.
       */
      const reason =
        resolution.reason === "registry_error" || resolution.reason === "invalid_input"
          ? ("registry_unavailable" as const)
          : ("no_servable_deployment" as const);
      return { ok: false, reason };
    }

    return {
      ok: true,
      target: {
        config: configResult.config,
        deployment: resolution.deployment,
        version: resolution.version,
      },
    };
  }

  /**
   * يبثّ من وقت تشغيل YSD.
   *
   * ولا يخرج من هنا شيءٌ عن الهدف: لا معرّف نتاج ولا اسم مستعار ولا عنوان
   * ولا معرّف نشرة. و`meta.model` هو **المعرّف المنطقيّ** الذي طلبه
   * المستخدم — فهو ما يُحفظ في المحادثة وما يُعرض له. أما `runtimeModel`
   * فتفصيلٌ تشغيليّ يتغيّر مع كل ترقية نسخة، وتسريبُه يجعل تاريخ المحادثة
   * يحمل معرّفات نتاجٍ لا معنى لها بعد شهر.
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    // ★ ملغى قبل البدء ⇒ صمتٌ تامّ، بلا قاعدة ولا وقت تشغيل
    if (req.signal?.aborted) return;

    /**
     * ★ المفتاح مغلق ⇒ تعذّرٌ عامّ، بصفر قاعدة وصفر شبكة.
     *
     * ولا يُقال للمستخدم «موقوف بمفتاح إيقاف»: حالةُ تفعيلٍ داخلية تكشف
     * أن ثمّة نموذجًا يُهيَّأ ولمّا يُفتح — خبرٌ لا يفيده ويكشف خطّتنا.
     * فهو يقرأ ما يقرؤه في كل تعذّر: أن الخدمة غير متاحة الآن.
     */
    if (!this.isServingEnabled(req.modelId)) {
      yield providerError();
      return;
    }

    /**
     * السبب المفصَّل لا يعبر من هنا: البثّ يتصرّف كما كان بالضبط — تعذّرٌ
     * عامّ واحد لكل صور الفشل. والتمييز يخدم الفاحص الإداريّ وحده.
     */
    let resolution: RuntimeTargetResolution;
    try {
      resolution = await this.resolveRuntimeTarget(req.modelId);
    } catch {
      yield providerError();
      return;
    }
    if (!resolution.ok) {
      yield providerError();
      return;
    }
    const target = resolution.target;

    // ★ وقد ينصرف المستخدم أثناء استعلام السجلّ — فلا يبدأ توليدٌ لا يقرأه
    if (req.signal?.aborted) return;

    /**
     * ★ نسبُ الهدف — يخرج مع `meta` ولا يتجاوزها.
     *
     * `model` هو المعرّف المنطقيّ الذي طلبه المستخدم. والثلاثة الباقية
     * تقول **أيّ نسخةٍ وأيّ نشرةٍ** خدمتاه — سؤالٌ لا يُجاب بعد شهر إن لم
     * يُلتقط الآن، لأن النشرة تتغيّر مع كل ترقية.
     *
     * ولا يخرج معها شيء من أهداف الاتصال: لا معرّف نتاج ولا مرجع أساس
     * ولا اسم مستعار ولا عنوان ولا مفتاح.
     */
    yield {
      type: "meta",
      model: req.modelId,
      modelVersion: target.version.version,
      modelVersionId: target.version.id,
      deploymentId: target.deployment.id,
      deploymentEnvironment: target.deployment.environment,
    };

    /**
     * ★ تتبّع النهاية — الناقل قد ينتهي بلا إطارٍ طرفيّ.
     *
     * مولّدٌ ينتهي صامتًا يترك المسار بلا `done` ولا `error`، فيبدو الرد
     * مكتملًا وهو مبتور — أو يُعلَّق منتظرًا ما لن يأتي. والصمت أسوأ من
     * العطل هنا لأنه لا يُرى.
     */
    let sawText = false;
    let sawTerminal = false;

    try {
      for await (const chunk of this.deps.streamRuntimeChat(
        target.config,
        target.deployment,
        target.version,
        req,
      )) {
        if (chunk.type === "text") {
          sawText = true;
          yield { type: "text", text: chunk.text };
        } else if (chunk.type === "usage") {
          yield { type: "usage", usage: chunk.usage };
        } else if (chunk.type === "done") {
          sawTerminal = true;
          yield {
            type: "done",
            ...(chunk.completion ? { completion: chunk.completion } : {}),
            ...(chunk.completionReason ? { completionReason: chunk.completionReason } : {}),
          };
          return;
        } else {
          // ★ إلغاء المستدعي ليس عطلًا يُعرض — ينتهي البثّ صامتًا
          if (chunk.reason === "aborted") return;
          sawTerminal = true;
          yield providerError(errorCodeFor(chunk.reason));
          return;
        }
      }
    } catch {
      // استثناء غير متوقّع من الناقل — رمزٌ عامّ بلا أثر منه
      yield providerError();
      return;
    }

    /**
     * وصلنا هنا ⇒ انتهى المولّد طبيعيًّا بلا إطارٍ طرفيّ.
     *
     * والإلغاء يُفحص أولًا: انصرافُ المستخدم لا يستحق إطارًا مصطنعًا.
     * ثم يُفرَّق بين ردٍّ خرج بعضه — فهو **ناقص** موسوم — وردٍّ لم يخرج
     * منه شيء، فذاك تعذّرٌ لا نقص.
     */
    if (sawTerminal) return;
    if (req.signal?.aborted) return;

    if (sawText) {
      yield {
        type: "done",
        completion: "incomplete_provider",
        completionReason: "runtime_stream_ended",
      };
      return;
    }
    yield providerError();
  }

  /**
   * نداء JSON غير متدفّق — لاسترداد الاستشهادات.
   *
   * ★ يستعمل `YSD_ALPHA_MODEL_ID` صراحةً لأن عقد `AIProviderAdapter` لا
   * يمرّر `modelId` إلى هذه الدالة (عمدًا: منعُ تسريب معرّف نموذجٍ عبر
   * حدود المزوّد). وذلك صحيحٌ **ما دام لـYSD نموذج منطقيّ واحد**.
   *
   * فإن أُضيف نموذج ثانٍ، وجب تغيير عقد الاسترداد **قبل** تفعيله — وإلا
   * استُرِدّت استشهادات نموذجٍ من نموذجٍ آخر.
   */
  async requestJsonCompletion(input: {
    systemPrompt: string;
    userText: string;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ ok: true; text: string } | { ok: false; reason: "timeout" | "error" }> {
    // عقد المحوّل لا يعرف `aborted` — فالإلغاء يُبلَّغ كتعذّر عامّ
    if (input.signal?.aborted) return { ok: false, reason: "error" };

    // ★ والمفتاح مغلق ⇒ تعذّرٌ عامّ كذلك، قبل السجلّ وقبل وقت التشغيل
    if (!this.isServingEnabled(YSD_ALPHA_MODEL_ID)) return { ok: false, reason: "error" };

    let resolution: RuntimeTargetResolution;
    try {
      resolution = await this.resolveRuntimeTarget(YSD_ALPHA_MODEL_ID);
    } catch {
      return { ok: false, reason: "error" };
    }
    if (!resolution.ok) return { ok: false, reason: "error" };
    const target = resolution.target;

    if (input.signal?.aborted) return { ok: false, reason: "error" };

    try {
      const result = await this.deps.requestRuntimeJsonCompletion(
        target.config,
        target.deployment,
        target.version,
        input,
      );
      if (result.ok) return { ok: true, text: result.text };
      // المهلة وحدها تُميَّز — وما عداها تعذّرٌ عامّ بلا تفصيل تشغيليّ
      return { ok: false, reason: result.reason === "timeout" ? "timeout" : "error" };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  /**
   * ★ فاحص اتصالٍ حقيقيّ — «متصل» تعني أن الرد ممكنٌ الآن.
   *
   * ── ما كان الزرّ يقوله قبل هذه الرقعة ──
   *
   * `AIProviderAdapter.healthCheck` اختياريّ، ومزوّدٌ بلا فاحصٍ يُعرض
   * `unsupported`. فكان YSD يظهر هكذا: صادقًا لكنه صامت. والبديل الأسهل —
   * أن يقول «متصل» لأن العنوان والمفتاح موجودان — أسوأ من الصمت بمراحل:
   * مفتاحٌ صحيح على وقت تشغيلٍ لا يحمل نموذجنا يردّ `200` على قائمة
   * نماذجه، فيطمئنّ المشرف، ويُفعَّل النموذج، ويفشل عند أول مستخدم.
   *
   * ── فالسلسلة تُقطع كاملة ──
   *
   *   السجلّ يُقرأ  ⇐  نشرةٌ نشطة لنسخةٍ معتمدة  ⇐  وقت تشغيلٍ يُجيب
   *   ⇐  **والنموذج المطلوب محمَّلٌ فيه بالاسم نفسه**.
   *
   * وأي حلقةٍ تنكسر تُعطي حالةً تدلّ المشرف على مكان العطل — بلا معرّفات
   * ولا عناوين ولا مفردات جداول.
   *
   * ولا يستهلك شيئًا: `GET /models` قراءةٌ لا توليد.
   */
  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const t0 = Date.now();
    const since = () => Date.now() - t0;

    // ★ ملغى قبل البدء ⇒ بلا قاعدة وبلا شبكة
    if (signal?.aborted) return { status: "unreachable", latencyMs: since() };

    let resolution: RuntimeTargetResolution;
    try {
      resolution = await this.resolveRuntimeTarget(YSD_ALPHA_MODEL_ID);
    } catch {
      return { status: "unreachable", latencyMs: since() };
    }

    if (!resolution.ok) {
      switch (resolution.reason) {
        case "not_configured":
          // إعدادٌ ناقص — ولم تُلمس قاعدة ولا شبكة للوصول إلى هنا
          return { status: "not_configured", latencyMs: since() };
        case "no_servable_deployment":
        case "unsupported_model":
          /**
           * `no_models` لا `unreachable`: الوصول تمّ، والجواب كان «لا شيء
           * صالحٌ للخدمة». وذلك عطلُ سجلٍّ يُصلحه المشرف في الجداول، لا
           * عطلُ اتصال يفتّش عنه في الشبكة.
           */
          return { status: "no_models", modelCount: 0, latencyMs: since() };
        default:
          return { status: "unreachable", latencyMs: since() };
      }
    }

    const target = resolution.target;

    let readiness: YSDRuntimeReadinessResult;
    try {
      readiness = await this.deps.checkRuntimeReadiness(
        target.config,
        target.deployment,
        target.version,
        YSD_ALPHA_MODEL_ID,
        signal,
      );
    } catch {
      return { status: "unreachable", latencyMs: since() };
    }

    /**
     * ★ الزمن المُبلَّغ زمنُ الفحص كلّه من `t0` — لا زمن الرحلة الأخيرة.
     *
     * المشرف ينتظر السلسلة كاملة: استعلام السجلّ ثم نداء وقت التشغيل.
     * فإبلاغُه بزمن النداء وحده يُخفي عنه أبطأ نصفٍ في الطريق.
     */
    if (readiness.ok) {
      return { status: "connected", modelCount: readiness.modelCount, latencyMs: since() };
    }

    switch (readiness.reason) {
      case "unauthorized":
        return { status: "unauthorized", latencyMs: since() };
      case "model_not_loaded":
        /**
         * ★ الحالة التي وُجد هذا الفحص لأجلها.
         *
         * وقت التشغيل حيّ، والمفتاح مقبول، والقائمة صالحة — وليس فيها
         * نموذجنا. و`connected` هنا كذبةٌ مكتملة الأركان.
         */
        return {
          status: "no_models",
          modelCount: readiness.modelCount ?? 0,
          latencyMs: since(),
        };
      default:
        // timeout · network_error · runtime_unavailable · invalid_response
        // · invalid_target · aborted — كلها «لم نصل»، بلا تفصيلٍ للمشرف
        return { status: "unreachable", latencyMs: since() };
    }
  }
}
