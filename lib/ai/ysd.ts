import "server-only";

import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";
import type { ModelDeploymentRecord, ModelVersionRecord } from "./model-registry";
import { readYSDRuntimeConfig, type YSDRuntimeConfig } from "./ysd-runtime-config";
import {
  requestYSDRuntimeJsonCompletion,
  streamYSDRuntimeChat,
  type YSDRuntimeFailureReason,
} from "./ysd-runtime-client";
import { resolveServableDeployment } from "./model-registry-resolver";
import { getAdminClient, isServiceRoleConfigured } from "@/lib/supabase/admin";
import { ERROR_MESSAGES, type ChatErrorCode } from "./error-codes";

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
};

/** الهدف المحلول — داخليّ بحت، لا يخرج منه شيء إلى المستخدم */
interface RuntimeTarget {
  config: YSDRuntimeConfig;
  deployment: ModelDeploymentRecord;
  version: ModelVersionRecord;
}

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
         * ★ `false` ثابتٌ لا يتغيّر بأي متغيّر بيئة.
         *
         * التوصيل لا يعني التفعيل. ورفعُه إلى `true` رقعةٌ مستقلّة تُتخذ
         * بقرار، لا أثرٌ جانبيّ لفتح عَلَمٍ آخر.
         */
        enabled: false,
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
  private async resolveRuntimeTarget(modelId: string): Promise<RuntimeTarget | null> {
    /**
     * ★ نموذج واحد مملوك — لا وكالة عامّة.
     *
     * بلا هذا الشرط يصير المزوّد بابًا لأي معرّفٍ في القاعدة: يكفي صفٌّ
     * مكتوبٌ بخطأ ليُوجَّه إليه طلب تحت اسم YSD.
     */
    if (modelId !== YSD_ALPHA_MODEL_ID) return null;

    if (process.env.YSD_PROVIDER_ENABLED !== "1") return null;

    const configResult = this.deps.readRuntimeConfig();
    if (!configResult.ok) return null;

    if (this.deps.hasRegistryAccess() !== true) return null;

    let client;
    try {
      client = this.deps.getAdminClient();
    } catch {
      // عطلٌ غير متوقّع في إنشاء العميل — يُبتلع رمزًا لا نصًّا
      return null;
    }
    if (!client) return null;

    let resolution;
    try {
      resolution = await this.deps.resolveDeployment(
        client,
        modelId,
        configResult.config.deploymentEnvironment,
      );
    } catch {
      return null;
    }
    if (!resolution.ok) return null;

    return {
      config: configResult.config,
      deployment: resolution.deployment,
      version: resolution.version,
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

    let target: RuntimeTarget | null;
    try {
      target = await this.resolveRuntimeTarget(req.modelId);
    } catch {
      yield providerError();
      return;
    }
    if (!target) {
      yield providerError();
      return;
    }

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

    let target: RuntimeTarget | null;
    try {
      target = await this.resolveRuntimeTarget(YSD_ALPHA_MODEL_ID);
    } catch {
      return { ok: false, reason: "error" };
    }
    if (!target) return { ok: false, reason: "error" };

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
}
