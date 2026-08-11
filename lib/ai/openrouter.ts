import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk, UsageReport } from "./types";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "./free-models";
import {
  type CooldownReason,
  acquireProbeSlot,
  cooldownRemainingMs,
  probeGateRemainingMs,
  releaseProbeSlot,
  isCoolingDown,
  markCooldown,
  parseRetryAfterMs,
} from "./model-cooldown";
import {
  GUARD_FAILURE_MESSAGE,
  STRICT_LANGUAGE_SUFFIX,
  detectExpectedLanguage,
  violatesLanguage,
} from "./language-guard";
import {
  STRICT_UNCERTAINTY_SUFFIX,
  UNCERTAINTY_FALLBACK_MESSAGE,
  VERIFYING_STATUS_MESSAGE,
  needsVerifiedMode,
  violatesUncertainty,
} from "./uncertainty-guard";
import { buildNoCompletionMessage, isEmptyCompletion } from "./empty-completion";
import { codeFromProviderKind } from "./error-codes";
import { ambiguousCandidates, buildClarifyQuestion } from "./entity-aliases";
import {
  STRICT_GROUNDING_SUFFIX,
  buildUnsourcedMessage,
  violatesGrounding,
} from "./grounding-guard";
import {
  CONTINUATION_SUFFIX,
  GUARD_OVERLAP_CHARS,
  buildIncompleteSuffix,
  finalizeIncompleteText,
  dedupeContinuation,
  endsWithDanglingPreamble,
  shouldAppendTruncatedNotice,
  endsInsideCodeFence,
  stripCodeAware,
  takeCompleteUnits,
  violatesStreamUnit,
} from "./language-guard";

/**
 * موفر OpenRouter — واجهة Chat Completions المتوافقة مع OpenAI.
 *
 * النموذج المنطقي "ysd/free" يُحل إلى سلسلة نماذج مجانية معتمدة
 * (lib/ai/free-models.ts) بدلًا من الموجّه العشوائي openrouter/free.
 * v0.6.5 RC2: يُجمَّع الرد كاملًا ثم يُفحص بحارسَين قبل تسليمه:
 *   - حارس اللغة: خليط لغات/كلمة دخيلة → إعادة محاولة واحدة بنموذج احتياطي وموجّه أصرم.
 *   - حارس عدم اليقين: تخمين متحفّظ لتفاصيل دقيقة → إعادة توليد صارمة واحدة، ثم رسالة آمنة.
 * المفتاح يُقرأ من البيئة على الخادم فقط — لا يصل للمتصفح أو السجلات أبدًا.
 */

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
/**
 * مهلة المحاولة الواحدة مع مزوّد (v0.6.6: 60s → 25s).
 * قِيس حيًّا أن أول بايت من النماذج المجانية يصل خلال 2–10s في الحالة السوية،
 * و60s كانت تعني انتظارًا طويلًا بلا طائل قبل الانتقال للتالي.
 */
export const PROVIDER_TIMEOUT_MS = 25_000;

/**
 * منافذ اختبار **خادمية بحتة** (v0.7.0) — لا تعمل إلا خلف بوابة صريحة.
 *
 * البوابة: NODE_ENV=test أو YSD_ENABLE_TEST_PROVIDER=1. في الإنتاج تبقى مغلقة،
 * فلا يستطيع أحد — ولا حتى بمتغيّر بيئة مُسرَّب — تحويل نداءات المزوّد إلى
 * عنوان آخر. ولا شيء من هذا يصل المتصفح (الملف خادمي ولا NEXT_PUBLIC).
 *
 * الغرض: التحقق الفعلي من مهلة الخمول والسقف الكلي بمزوّد وهمي يتوقف عمدًا —
 * وهو ما تعذّر في RC1 لأن العنوان كان ثابتًا في الكود.
 */
function testHooksEnabled(): boolean {
  return process.env.NODE_ENV === "test" || process.env.YSD_ENABLE_TEST_PROVIDER === "1";
}

/** عنوان المزوّد — الحقيقي، أو عنوان اختبار خلف البوابة وحدها */
function providerUrl(): string {
  if (testHooksEnabled() && process.env.YSD_TEST_PROVIDER_URL) {
    return process.env.YSD_TEST_PROVIDER_URL;
  }
  return API_URL;
}

/** مهلة الخمول — قابلة للتقصير في الاختبار وحده كي لا يطول CI */
function idleTimeoutMs(): number {
  if (testHooksEnabled() && process.env.YSD_TEST_IDLE_MS) {
    const n = Number(process.env.YSD_TEST_IDLE_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return PROVIDER_TIMEOUT_MS;
}

/**
 * سقف انتظار المستخدم لسلسلة الاحتياط كاملة.
 * بدونه كانت أربع محاولات × مهلة كل منها تعني انتظارًا مفتوحًا (رُصد حيًّا 129
 * ثانية). عند بلوغ السقف نتوقف فورًا ونعرض رسالة واضحة بدل إطالة الصمت.
 */
export const CHAIN_BUDGET_MS = 45_000;

/**
 * مهلة **أول بايت ذي محتوى** — منفصلة عن مهلة الخمول (v0.9.0).
 *
 * ── لماذا لزمت ──
 *
 * مهلة الخمول تُعاد تسليحها عند كل بايت يصل، وهذا صحيح للبثّ المتدفّق. لكن
 * المزوّد يُرسل **نبضات إبقاء** (`: OPENROUTER PROCESSING`) بينما النموذج في
 * الطابور، وهي بايتات بلا محتوى. فكانت كل نبضة تُعيد تسليح المهلة، فلا تنقضي
 * أبدًا، ويبقى الطلب معلّقًا على نموذج لم يبدأ التوليد أصلًا — حتى يقتله سقف
 * المسار (110 ث). ولا احتياط يُجرَّب لأن المحاولة الأولى لم تنتهِ قط.
 *
 * رُصد حيًّا (المحادثة 47eb4342): طلبان بـ`first_byte_ms = -1` واستهلكا
 * 109769مل و73820مل بلا رسالة ولا احتياط.
 *
 * ── القيمة ──
 *
 * 20 ثانية ليست اعتباطية: مهلة الخمول 25 ث وميزانية السلسلة 45 ث، فـ
 * `20 + 25 = 45` — أي أن فشل أول بايت **يترك محاولة احتياط كاملة داخل
 * الميزانية القائمة بلا تغييرها**.
 */
export const FIRST_BYTE_TIMEOUT_MS = 20_000;

/** مهلة أول بايت — تُقصَّر في الاختبار وحده خلف البوابة */
function firstByteTimeoutMs(): number {
  if (testHooksEnabled() && process.env.YSD_TEST_FIRST_BYTE_MS) {
    const n = Number(process.env.YSD_TEST_FIRST_BYTE_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return FIRST_BYTE_TIMEOUT_MS;
}

/** ميزانية السلسلة — تُقصَّر في الاختبار وحده خلف البوابة */
function chainBudgetMs(): number {
  if (testHooksEnabled() && process.env.YSD_TEST_CHAIN_BUDGET_MS) {
    const n = Number(process.env.YSD_TEST_CHAIN_BUDGET_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return CHAIN_BUDGET_MS;
}

/** تصنيف أخطاء OpenRouter إلى رسائل عربية واضحة — دون كشف تفاصيل حساسة */
export function mapOpenRouterError(status: number | null, raw: string): {
  kind: string;
  userMessage: string;
} {
  const lower = raw.toLowerCase();
  if (status === 401) {
    return {
      kind: "auth",
      userMessage: "إعدادات موفر الذكاء الاصطناعي غير صحيحة. تواصل مع إدارة المنصة.",
    };
  }
  /**
   * 403 **ليس** خطأ حساب بالضرورة.
   *
   * 401 يعني مفتاحًا مرفوضًا — حكمٌ على الحساب، لا يتغيّر بتبديل النموذج.
   * أما 403 فتستعمله OpenRouter أيضًا للحجب والإشراف، وذلك **قد** يخصّ نموذجًا
   * بعينه. فإلحاقه بـ`auth` كان يجعل حجب نموذج واحد يوقف السلسلة كلها.
   *
   * يبقى رمزه العام `provider_unavailable` كما كان، لكنه **قابل للإعادة**.
   */
  if (status === 403) {
    return {
      kind: "forbidden",
      userMessage: "هذا النموذج غير متاح حاليًا. جرّب نموذجًا آخر أو أعد المحاولة.",
    };
  }
  if (status === 402) {
    return {
      kind: "insufficient_credit",
      userMessage:
        "رصيد خدمة الذكاء الاصطناعي غير كافٍ حاليًا. تواصل مع إدارة المنصة أو حاول لاحقًا.",
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      userMessage: "الخدمة المجانية مضغوطة حاليًا. انتظر قليلًا ثم أعد المحاولة.",
    };
  }
  if (
    status === 404 ||
    lower.includes("no endpoints") ||
    lower.includes("not found") ||
    // رسالة OpenRouter الصريحة حين يغيب المزوّد المجاني (رُصدت حيًا):
    // "This model is unavailable for free"
    lower.includes("unavailable for free") ||
    lower.includes("unavailable_for_free")
  ) {
    return {
      kind: "no_free_model",
      userMessage:
        "لا يتوفر نموذج مجاني في هذه اللحظة. رسالتك محفوظة — أعد المحاولة بعد قليل أو اختر نموذجًا آخر.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: "overloaded",
      userMessage: "خدمة الذكاء الاصطناعي غير متاحة مؤقتًا. أعد المحاولة بعد قليل.",
    };
  }
  return {
    kind: "api_error",
    userMessage: "تعذّر إكمال الطلب لدى موفر الذكاء الاصطناعي.",
  };
}

interface SSEDelta {
  model?: string;
  choices?: {
    delta?: { content?: string; reasoning?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

/** عدّاد طلبات التوليد الفعلية — يُمرَّر بالمرجع عبر كل المحاولات */
interface ProviderStats {
  providerCalls: number;
  /**
   * عدد محاولات النماذج المكتملة قبل النموذج الجاري (v0.9.0).
   *
   * `fallback_count` كان يُشتقّ من `indexOf(actualModelId)`، وهو مضلّل حين لا
   * يصل أول بايت: المعرّف يبقى null فيُخرج `indexOf("") = -1` ⇒ صفر، فيبدو
   * أن لا احتياط جرى بينما جرت محاولات. العدّاد يقول الحقيقة.
   */
  attempts: number;
  /**
   * تصنيف داخلي لنهاية السلسلة — للتشخيص وحده، بلا محتوى ولا هوية.
   *
   * `provider_unavailable` وحده لا يقول هل جُرّب شيء أصلًا. هذا يقوله.
   */
  outcome: ChainOutcome;
  /** النموذج المسبور إن حُجزت بوابة السبر — يُحرَّر مركزيًا عند الانتهاء */
  probeModel?: string;
}

/** نهايات السلسلة الممكنة — رموز مغلقة لا نصوص */
export type ChainOutcome =
  | "unknown"
  | "success"
  | "chain_exhausted"
  | "all_models_cooling"
  | "cooled_probe_failed"
  | "account_auth"
  | "insufficient_credit"
  | "short_circuit"
  | "client_abort";

/** نتيجة محاولة واحدة مع نموذج واحد — الرد الكامل يُرجَّع للفحص في streamChat */
interface AttemptResult {
  status:
    | "ok"
    | "guard_violation" // تسريب قبل عرض أي شيء → احتياط نظيف بنموذج آخر
    | "leak_after_flush" // تسريب بعد عرض جمل نظيفة → متابعة صامتة
    | "empty_completion" // أنهى البثّ بلا نص للمستخدم → فشل محاولة لا نجاح
    | "http_error"
    | "network_error"
    | "aborted";
  /**
   * هل كان الفشل **مهلتنا** لا عطل شبكة؟ (v0.9.0)
   *
   * كلاهما يُنهي المحاولة، والفرق يظهر للمستخدم وللتشخيص: «تعذّر الاتصال»
   * تُوجّهه إلى شبكته، و«استغرق وقتًا أطول» تصف ما جرى فعلًا — مزوّد تلكّأ.
   */
  timedOut?: boolean;
  /**
   * قياسات تشخيصية للمحاولة (v0.9.0) — **أرقام ورموز فقط**.
   *
   * الحادثة الأخيرة تعذّر تشخيصها لأن السجل لم يقل أين انقضت المهلة، ولا هل
   * وصل شيء من المزوّد أصلًا. هذه الحقول تقولها بلا أي محتوى.
   */
  timeoutStage?: "before_response" | "first_content" | "stream_idle" | "none";
  /** هل عادت استجابة HTTP (ترويسات) قبل انتهاء المحاولة؟ */
  headersReceived?: boolean;
  /** عدد إطارات SSE المقروءة — عددًا لا مضمونًا */
  sseFrameCount?: number;
  /** مجموع أطوال المحتوى النصّي الواصل — طولًا لا نصًّا */
  contentByteCount?: number;
  /** سبب الإنهاء كما أرسله المزوّد — للتسجيل الآمن فقط */
  finishReason?: string | null;
  /** هل أرسل النموذج تفكيرًا داخليًا؟ قيمة منطقية فقط — لا يُعرض ولا يُحفظ */
  reasoningPresent?: boolean;
  /** عدد أحرف النص الصالح — رقم فقط بلا محتوى */
  textLen?: number;
  /** سبب سقوط حارس اللغة — رمز فقط، بلا الكلمة المخالفة ولا محتوى المستخدم */
  guardReason?: string;
  /** ما عُرض فعلًا للمستخدم من جمل نظيفة (لبناء طلب المتابعة) */
  emitted?: string;
  httpStatus?: number;
  errorRaw?: string;
  /** من ترويسة Retry-After إن أرسلها الموفر — تتقدّم على مدة 429 الافتراضية */
  retryAfterMs?: number | null;
  /** الرد الكامل عند النجاح (يُفحص بالحارسَين قبل التسليم) */
  text?: string;
  /** معرّف النموذج الفعلي الذي أجاب */
  model?: string;
  /** استهلاك التوكنات إن أرسله الموفر */
  usage?: UsageReport | null;
}

/** يُحوّل نوع الخطأ إلى سبب تهدئة، أو null لما لا يستحق تهدئة */
function cooldownReasonFor(kind: string): CooldownReason | null {
  if (kind === "rate_limit") return "rate_limit";
  if (kind === "no_free_model") return "no_free_model";
  /**
   * 5xx أو شبكة أو **مهلة** — عطل مزوّد عابر.
   *
   * `timeout` أُعيد هنا بعد أن أسقطته رقعة سابقة سهوًا: كانت المهلة تُصنَّف
   * `network` فتُهدَّأ، ثم صار لها نوعها الخاص فسقطت من هذا الجدول ⇒ نموذج
   * يتلكّأ يُجرَّب في كل طلب بدل أن يُبعَد دقيقتين.
   *
   * و`forbidden` معه: حجبٌ قد يكون مؤقتًا وخاصًّا بنموذج.
   */
  if (
    kind === "overloaded" ||
    kind === "network" ||
    kind === "timeout" ||
    kind === "forbidden"
  ) {
    return "provider_error";
  }
  // auth / insufficient_credit / api_error: مشكلة إعداد أو حساب لا تخصّ نموذجًا
  // بعينه — تهدئته تحجب نموذجًا سليمًا بلا سبب.
  return null;
}

export class OpenRouterProvider implements AIProviderAdapter {
  readonly id = "openrouter";
  readonly displayName = "OpenRouter";

  isConfigured(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: YSD_FREE_MODEL_ID,
        providerId: this.id,
        displayNameAr: "YSD مجاني",
        displayNameEn: "YSD Free",
        contextWindow: 131_072,
        enabled: true,
      },
    ];
  }

  /**
   * ★ الحدث الختامي — **ضمانة مركزية لا تذكُّرٌ يدوي**.
   *
   * كان `attemptCount` يُضاف إلى إطارات `meta` واحدًا واحدًا، فسقط من ثلاثة
   * منها — بينها مسار البثّ العام الناجح — ومن مسار الفشل الذي لا يُصدر `meta`
   * أصلًا. فبقي `fallback_count` صفرًا في أكثر الحالات، وهو ما ضلّل تشخيص
   * ثلاث حوادث متتالية.
   *
   * الآن السلسلة كلها ملفوفة: أيًّا كانت نهايتها — نجاح، خطأ مزوّد، مهلة،
   * استنفاد، أو صفر نماذج — يُصدَر إطار ختامي واحد يحمل العدّاد الحقيقي
   * ونتيجة السلسلة. و`finally` تضمن إصداره حتى مع الخروج المبكر، فلا يمكن
   * لمسارٍ جديد أن «ينسى» العدّاد.
   */
  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const stats: ProviderStats = { providerCalls: 0, attempts: 0, outcome: "unknown" };
    let terminalSent = false;
    const terminalFrame = (): StreamChunk => ({
      type: "meta",
      attemptCount: stats.attempts,
      chainOutcome: stats.outcome,
      providerCalls: stats.providerCalls,
    });
    try {
      /**
       * النجاح يُستنتج مركزيًا من **وصول نصّ للمستخدم**، لا من تعليمٍ في كل
       * مسار نجاح. فمسارات النجاح متعددة (عام، محمي، متابعة، إعادة صارمة)،
       * ووسمها واحدًا واحدًا يعيد الخطأ نفسه الذي عالجه الحدث الختامي.
       */
      for await (const chunk of this.runChain(req, stats)) {
        if (chunk.type === "text" && chunk.text && stats.outcome === "chain_exhausted") {
          stats.outcome = "success";
        }
        /**
         * الحدث الختامي يسبق `done` — لا يليه.
         *
         * `done` آخر ما يصل المستهلك بحكم العقد القائم، ووضع إطارٍ بعده يكسر
         * كل قارئ يعتبره النهاية. فيُدرَج قبله، ويبقى `done` خاتمةً كما كان.
         */
        if (chunk.type === "done" && !terminalSent) {
          terminalSent = true;
          yield terminalFrame();
        }
        yield chunk;
      }
    } finally {
      /**
       * تحرير حق السبر **مركزيًا** — كالحدث الختامي تمامًا.
       *
       * لو وُضع عند كل مخرج لَنُسي واحد يومًا ما، ونسيانه يُبقي البوابة
       * مقفلة `inFlight` إلى الأبد فتتوقف كل محاولات السبر.
       */
      if (stats.probeModel) {
        releaseProbeSlot(stats.probeModel, stats.outcome === "success");
      }
      // مسارات لا تُنهي بـ`done` (خطأ، إجهاض) — الضمانة تبقى قائمة
      if (!terminalSent) {
        terminalSent = true;
        yield terminalFrame();
      }
    }
  }

  private async *runChain(req: ChatRequest, stats: ProviderStats): AsyncGenerator<StreamChunk> {
    /** يُكتب في `stats.outcome` عند كل خروج — والغلاف يبثّه */
    const setOutcome = (o: ChainOutcome) => {
      stats.outcome = o;
    };
    setOutcome("chain_exhausted");

    const chain: readonly string[] =
      req.modelId === YSD_FREE_MODEL_ID ? FREE_MODEL_CHAIN : [req.modelId];

    /** حالة اكتمال الرد (RC8) — تُضبط عند أي إنهاء غير مكتمل */
    let incomplete: StreamChunk["completion"] = undefined;
    /** عدد محاولات المتابعة (RC8) — واحدة كحد أقصى، ولا تُخلط بالاحتياط */
    let continuationCount = 0;

    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";
    const expected = detectExpectedLanguage(userText);

    let langRetryUsed = false;
    let uncRetryUsed = false;
    let groundingRetryUsed = false;
    let emptyCompletionCount = 0;
    let lastError: { kind: string; userMessage: string } | null = null;

    // اختيار الوضع: المحمي (تجميع + فحص قبل العرض) للأسئلة المتخصصة فقط،
    // والبثّ الفوري لكل ما عداها — فلا تدفع المحادثة العامة ثمن التحقق.
    const verified = needsVerifiedMode(userText);
    const groundingSource = req.grounding?.source ?? "none";


    /**
     * إنفاذ سؤال التوضيح (v0.6.6 RC2): اسم يحتمل أكثر من عمل.
     * كان توجيهًا في الموجّه فقط، ورُصد حيًّا أن النموذج يتجاهله ويجيب بالتخمين.
     * الآن يُحسم في النظام: لا نداء للمزوّد إطلاقًا، وسؤال توضيح واحد فقط.
     */
    const ambiguous = ambiguousCandidates(userText);
    if (ambiguous.length > 0) {
      console.log(
        `[openrouter] ambiguous_entity=true candidates=${ambiguous.map((a) => a.canonical).join("|")}`,
      );
      yield {
        type: "meta",
        attemptCount: stats.attempts,
        model: req.modelId,
        mode: verified ? "protected" : "general",
        regenerations: 0,
        emptyCompletions: 0,
        groundingSource,
        protectedDetailBlocked: false,
        shortCircuit: true,
        providerCalls: 0,
        ambiguousEntity: true,
      };
      yield { type: "text", text: buildClarifyQuestion(ambiguous) };
      yield { type: "done" };
      return;
    }

    /**
     * اختصار الوضع المحمي (v0.6.5 RC8): سؤال متخصص بلا أي مصدر موثوق.
     * النتيجة محسومة سلفًا — حارس الإسناد سيمنع أي تفاصيل مهما ولّد النموذج —
     * فنداء المزوّد انتظار بلا فائدة (قِيس حيًّا: 129 ثانية ثم الرسالة الآمنة
     * نفسها). نردّ فورًا بلا أي طلب توليد.
     */
    if (verified && groundingSource === "none") {
      yield { type: "status", text: VERIFYING_STATUS_MESSAGE };
      yield {
        type: "meta",
        attemptCount: stats.attempts,
        model: req.modelId,
        mode: "protected",
        regenerations: 0,
        emptyCompletions: 0,
        groundingSource: "none",
        protectedDetailBlocked: true,
        shortCircuit: true,
        providerCalls: 0,
      };
      setOutcome("short_circuit");
      yield { type: "text", text: buildUnsourcedMessage(userText) };
      yield { type: "done" };
      return;
    }

    // تخطٍّ **قبل** أي طلب: نموذج مهدّأ لا يُرسَل إليه أصلًا.
    let usable = chain.filter((m) => !isCoolingDown(m));

    /**
     * ★ سياسة منع انهيار السلسلة — **سبرٌ واحد** لا أكثر.
     *
     * التهدئة تحمي المزوّد، لكنها كانت قادرة على إفراغ السلسلة تمامًا: 404
     * واحد يُبعد نموذجًا ست ساعات، وأربعة منها تعني ستّ ساعات بلا خدمة ولو
     * تعافى المزوّد بعد دقيقة. ولا شيء يكسر ذلك إلا مرور الوقت.
     *
     * قُورن خياران:
     *
     *   (أ) سبر نموذج واحد — الأقرب انتهاءً — حين تُهدَّأ كل النماذج.
     *   (ب) إبقاء حدّ أدنى من المرشّحين متاحًا دائمًا رغم التهدئة.
     *
     * اخترنا (أ) لأنها **الأقل خطرًا**: كلفتها القصوى نداءٌ واحد لكل طلب،
     * والتهدئة تبقى نافذة على الباقي كما هي. أما (ب) فتُبقي عدة نماذج خارج
     * الحماية دائمًا، فترتدّ إلى ما قبل التهدئة عند عطل مزوّد ممتد — أي أربعة
     * نداءات فاشلة لكل طلب، وهو الطَّرق الذي وُضعت التهدئة لمنعه.
     *
     * و«الأقرب انتهاءً» اختيارٌ **حتمي**: نفس الحالة تُنتج نفس المرشّح، فلا
     * عشوائية تُصعّب التشخيص، والمُختار أقرب النماذج إلى التعافي فعلًا.
     */
    let cooledProbe = false;
    if (usable.length === 0 && chain.length > 0) {
      const probe = acquireProbeSlot(chain);
      if (probe) {
        usable = [probe];
        cooledProbe = true;
        stats.probeModel = probe;
        console.error("[openrouter] all cooled — probe acquired (gate open)");
      } else {
        console.error(
          `[openrouter] all cooled — probe gate closed: remaining_ms=${probeGateRemainingMs()}`,
        );
      }
    }

    if (usable.length === 0) {
      setOutcome("all_models_cooling");
      // الجميع مهدّأ — لا ننتظر ولا نكرر المحاولات. نُبلغ المستخدم بمدة صادقة.
      /**
       * المدة الصادقة هي الأقرب من: تعافي نموذج، أو فتح بوابة السبر.
       * فذكر ست ساعات بينما سيُعاد السبر بعد نصف دقيقة تضليلٌ للمستخدم.
       */
      const soonestCooldown = Math.min(...chain.map((m) => cooldownRemainingMs(m)));
      const gateMs = probeGateRemainingMs();
      const soonestMs = gateMs > 0 ? Math.min(soonestCooldown, gateMs) : soonestCooldown;
      const minutes = Math.max(1, Math.ceil(soonestMs / 60_000));
      console.error(
        `[openrouter] all models cooling down: count=${chain.length} soonest_ms=${soonestMs}`,
      );
      yield {
        type: "error",
        error: `جميع النماذج المجانية مضغوطة حاليًا. أعد المحاولة بعد نحو ${minutes} دقيقة — رسالتك محفوظة.`,
        errorCode: "provider_unavailable",
      };
      return;
    }

    // الوضع المحمي: حالة قصيرة تصل فورًا قبل نداء المزوّد — لا شاشة انتظار فارغة.
    if (verified) yield { type: "status", text: VERIFYING_STATUS_MESSAGE };

    const chainStartedAt = Date.now();
    /**
     * ★ الميزانية موعدٌ نهائي **يُجهض محاولةً جارية** لا شرطٌ يُفحص بينها.
     *
     * كان الفحص `if (i > 0 && elapsed >= budget)` يقع **قبل** كل محاولة فقط،
     * فمحاولة واحدة تتجاوز الميزانية كلها تعيش حتى مهلتها الخاصة بلا رقيب —
     * قِيس: محاولة عاشت 1351مل بميزانية 450مل. والمزوّد البطيء يجعل ذلك
     * انتظارًا مفتوحًا للمستخدم.
     *
     * الآن إشارة واحدة تُربط بكل محاولة، فتنقطع أينما كانت.
     */
    const chainDeadline = new AbortController();
    const chainTimer = setTimeout(() => chainDeadline.abort(), chainBudgetMs());
    /**
     * `unref` كي لا يُبقي المؤقّت حلقة الأحداث حيّة بعد ردٍّ سريع.
     *
     * لـ`streamChat` مخارج كثيرة (نجاح، خطأ، اختصار، إجهاض)، ووضعُ `clearTimeout`
     * عند كلٍّ منها يترك واحدًا منسيًّا يومًا ما. و`unref` تجعل النسيان غير مؤذٍ:
     * المؤقّت محلّي لهذا النداء، وإطلاقه بعد انتهائه يُجهض مراقبًا لا أحد يقرأه.
     */
    (chainTimer as unknown as { unref?: () => void }).unref?.();
    for (let i = 0; i < usable.length; i++) {
      const model = usable[i];
      if (!model) continue;

      // سقف انتظار المستخدم: لا نبدأ محاولة جديدة بعد نفاد الميزانية
      if (i > 0 && Date.now() - chainStartedAt >= chainBudgetMs()) {
        console.error(
          `[openrouter] chain budget exhausted: elapsed_ms=${Date.now() - chainStartedAt} tried=${i}`,
        );
        yield {
          type: "error",
          error: "استغرق الرد وقتًا أطول من المتوقع. رسالتك محفوظة — أعد المحاولة.",
          errorCode: "timeout",
        };
        return;
      }

      stats.attempts++;
      const result: AttemptResult = yield* this.attempt(
        req,
        model,
        { strictLang: langRetryUsed, strictUnc: uncRetryUsed, buffered: verified },
        userText,
        expected,
        stats,
        chainDeadline.signal,
      );

      if (result.status === "aborted") return;

      // إكمال فارغ: فشل محاولة — تهدئة قصيرة والانتقال للتالي بلا إعادة لنفس النموذج
      if (result.status === "empty_completion") {
        emptyCompletionCount++;
        const cooled = markCooldown(model, "empty_completion", null);
        // أرقام ومعرّفات فقط — لا محتوى ولا تفكير
        console.error(
          `[openrouter] failure_kind=empty_completion model_id=${model} ` +
            `finish_reason=${result.finishReason ?? "none"} text_char_count=${result.textLen ?? 0} ` +
            `reasoning_present=${result.reasoningPresent ?? false} cooldown_ms=${cooled}`,
        );
        continue;
      }

      // تسريب بعد عرض جمل نظيفة — لا خطأ ولا نص مخالف: متابعة صامتة مرة واحدة
      if (result.status === "leak_after_flush") {
        /**
         * v0.7.0 RC8 — تمييز حاسم بين **متابعة** و**احتياط**:
         *
         * المتابعة استكمال من آخر نص آمن بالنموذج **نفسه**؛ والاحتياط انتقال
         * إلى نموذج آخر. كان هذا المسار يمرّر usable[i + 1] — أي نموذجًا
         * مختلفًا — فيُدمج ردّان من نموذجين في رسالة واحدة بعد أن شاهد
         * المستخدم النص الأول. الآن: النموذج نفسه، محاولة واحدة، بلا احتياط.
         */
        continuationCount = langRetryUsed ? continuationCount : 1;
        console.error(
          `[openrouter] late leak: model=${model} reason=${result.guardReason ?? "?"} ` +
            `continue=${!langRetryUsed} continuation_count=${continuationCount} ` +
            `original_model=${model} continuation_model=${model}`,
        );
        if (!langRetryUsed) {
          langRetryUsed = true; // متابعة واحدة فقط — لا ثالثة ولا احتياط
          yield* this.continueAfterLeak(req, model, expected, userText, result.emitted ?? "", stats);
          return;
        }
        // لا احتياط متاح — إنهاء عند آخر جملة نظيفة.
        // العبارة تُضاف فقط إن كان الرد ناقصًا فعلًا؛ وإلا نُنهي بصمت.
        if (shouldAppendTruncatedNotice(result.emitted ?? "")) {
          // يغلق أي سياج مفتوح للعرض ثم يضع التنبيه خارج الكتلة (RC8)
          yield { type: "text", text: buildIncompleteSuffix(result.emitted ?? "") };
          incomplete = "incomplete_guard";
        }
        yield { type: "done", completion: incomplete, completionReason: result.guardReason };
        return;
      }

      // مخالفة لغة أثناء البثّ العام قبل عرض أي شيء — احتياط بنموذج آخر
      if (result.status === "guard_violation") {
        console.error(
          `[openrouter] language guard tripped: model=${model} reason=${result.guardReason ?? "?"}`,
        );
        if (!langRetryUsed && i + 1 < usable.length) {
          langRetryUsed = true;
          continue;
        }
        yield { type: "error", error: GUARD_FAILURE_MESSAGE };
        return;
      }

      if (result.status === "ok") {
        // البثّ العام: المحاولة عرضت الرد بنفسها بعد فحص كل مقطع — انتهى.
        if (!verified) return;

        const text = result.text ?? "";
        const actualModel = result.model ?? model;

        // حارس اللغة على الرد الكامل — خليط لغات/كلمة دخيلة يُرفض
        const lang = violatesLanguage(text, expected, userText, req.sourceVocabulary);
        if (lang.violated) {
          // حارس اللغة لا يُهدّئ النموذج: جودة رد لا عطل توفّر.
          console.error(
            `[openrouter] language guard tripped: model=${model} reason=${lang.reason ?? "?"}`,
          );
          if (!langRetryUsed && i + 1 < usable.length) {
            langRetryUsed = true; // إعادة محاولة واحدة بنموذج احتياطي وموجّه أصرم
            continue;
          }
          yield { type: "error", error: GUARD_FAILURE_MESSAGE, errorCode: "quality_guard" };
          return;
        }

        // حارس عدم اليقين — تخمين متحفّظ لتفاصيل دقيقة → إعادة توليد صارمة واحدة
        if (violatesUncertainty(userText, text).violated) {
          console.error(`[openrouter] uncertainty guard tripped: model=${model}`);
          if (!uncRetryUsed) {
            uncRetryUsed = true;
            yield* this.regenerateStrict(req, model, expected, userText, stats);
            return;
          }
          // سبق أن أُعيد التوليد بصرامة وما زال يخمّن → رسالة عدم تأكّد آمنة
          yield {
          type: "meta",
          attemptCount: stats.attempts,
          model: actualModel,
          mode: "protected",
          regenerations: 1,
        };
          yield { type: "text", text: UNCERTAINTY_FALLBACK_MESSAGE };
          yield { type: "done" };
          return;
        }

        // حارس الإسناد — تفاصيل متخصصة بلا مصدر موثوق لا تُعرض أصلًا
        const grounding = req.grounding ?? { source: "none" as const };
        if (violatesGrounding(text, userText, grounding).violated) {
          console.error(
            `[openrouter] unsourced specifics blocked: model=${model} grounding_source=${grounding.source}`,
          );
          if (!groundingRetryUsed) {
            groundingRetryUsed = true;
            yield* this.regenerateGrounded(req, model, expected, userText, grounding, stats);
            return;
          }
          yield {
            type: "meta",
          attemptCount: stats.attempts,
            model: actualModel,
            mode: "protected",
            regenerations: 1,
            emptyCompletions: emptyCompletionCount,
            groundingSource: grounding.source,
            protectedDetailBlocked: true,
          };
          yield { type: "text", text: buildUnsourcedMessage(userText) };
          yield { type: "done" };
          return;
        }

        // رد نظيف → سلّمه
        setOutcome("success");
        yield {
          type: "meta",
          attemptCount: stats.attempts,
          model: actualModel,
          mode: "protected",
          regenerations: 0,
          emptyCompletions: emptyCompletionCount,
          groundingSource: grounding.source,
          protectedDetailBlocked: false,
        };
        if (text) yield { type: "text", text };
        if (result.usage) yield { type: "usage", usage: result.usage };
        yield { type: "done" };
        return;
      }

      /**
       * v0.7.0 RC8 — انقطاع المزوّد **بعد** أن شاهد المستخدم نصًّا.
       *
       * الاحتياط هنا خطأ: النص معروض على الشاشة، والانتقال لنموذج آخر يعني
       * ردًّا ثانيًا يلتصق بالأول أو يحلّ محلّه. العقد: نتوقف عند ما عُرض،
       * ونُنهيه بعقد Markdown آمن، ونعلّمه ناقصًا صراحةً — بلا نداء إضافي.
       */
      if (result.status === "network_error" && (result.emitted ?? "").trim()) {
        const partial = result.emitted ?? "";
        const finalized = finalizeIncompleteText(partial);
        const added = finalized.slice(partial.length);
        if (added) yield { type: "text", text: added };
        console.error(
          `[openrouter] provider_interrupted_after_flush model=${result.model ?? model} text_char_count=${partial.length}`,
        );
        yield {
          type: "done",
          completion: "incomplete_provider",
          completionReason: "stream_interrupted",
        };
        return;
      }

      // فشل تقني (429/5xx/شبكة) — هدّئ النموذج ثم جرّب التالي في السلسلة
      lastError =
        result.status === "network_error"
          ? result.timedOut
            ? {
                kind: "timeout",
                userMessage:
                  "استغرق الرد وقتًا أطول من المتوقع. رسالتك محفوظة — أعد المحاولة.",
              }
            : {
                kind: "network",
                userMessage:
                  "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مجددًا.",
              }
          : mapOpenRouterError(result.httpStatus ?? null, result.errorRaw ?? "");

      /**
       * ★ خطأ حساب عالمي ⇒ توقّف فورًا.
       *
       * `httpStatus` هو حالة نداء OpenRouter نفسه، الموقّع بمفتاح الحساب.
       * فـ401 (مفتاح مرفوض) و402 (رصيد غير كافٍ) حكمان على الحساب لا على
       * نموذج: تبديل النموذج لا يغيّر منهما شيئًا، واستهلاك بقية السلسلة
       * أربعة نداءات فاشلة وتأخير للمستخدم بلا أي احتمال نجاح.
       *
       * و403 **ليس** منها عمدًا — قد يكون حجبًا خاصًّا بنموذج (أعلاه).
       */
      if (lastError.kind === "auth" || lastError.kind === "insufficient_credit") {
        setOutcome(lastError.kind === "auth" ? "account_auth" : "insufficient_credit");
        console.error(
          `[openrouter] account-level failure: kind=${lastError.kind} — chain stopped`,
        );
        break;
      }

      const reason: CooldownReason | null = cooldownReasonFor(lastError.kind);
      let cooledMs = 0;
      if (reason) cooledMs = markCooldown(model, reason, result.retryAfterMs ?? null);

      // سجل آمن: معرّف النموذج ونوع الخطأ ومدة التهدئة فقط —
      // لا مفاتيح ولا نص المستخدم ولا جسم رد الموفر.
      /**
       * سجلّ منظّم لكل محاولة — أرقامٌ ورموز فقط.
       *
       * الحادثة الأخيرة عجزتُ عن تشخيصها لأن السجل لم يقل **أين** انقضت
       * المهلة: قبل أي استجابة، أم بعدها بلا محتوى مفيد، أم بعد سكون البثّ.
       * والفرق يفصل «المزوّد رفض» عن «المزوّد قبِل ثم لم ينتج».
       *
       * ولا يعبر من هنا موجّه ولا نصّ ردّ ولا اسم ملف ولا محتوى مستخدم ولا
       * مفتاح: معرّف نموذج، ورمز حالة، ونوع، وعدّادات.
       */
      console.error(
        `[openrouter] attempt failed: model=${model} status=${result.httpStatus ?? "?"} ` +
          `kind=${lastError.kind}${reason ? ` cooldown=${reason} cooldown_ms=${cooledMs}` : " cooldown=none"} ` +
          `attempt_index=${i} timeout_stage=${result.timeoutStage ?? "none"} ` +
          `headers_received=${result.headersReceived === true} ` +
          `sse_frame_count=${result.sseFrameCount ?? 0} ` +
          `content_byte_count=${result.contentByteCount ?? 0}`,
      );
    }

    if (stats.outcome === "chain_exhausted" && cooledProbe) {
      setOutcome("cooled_probe_failed");
    }

    // انتهت السلسلة بلا نص صالح. إن كان السبب إكمالات فارغة فليست عطلًا تقنيًا:
    // نُعيد رسالة عربية واضحة (مع ذكر اسم اللعبة إن عُرف) بدل رسالة فارغة.
    if (emptyCompletionCount > 0 && !lastError) {
      const message = buildNoCompletionMessage(userText);
      console.error(
        `[openrouter] all attempts empty: count=${emptyCompletionCount} chain=${usable.length}`,
      );
      yield {
        type: "meta",
        attemptCount: stats.attempts,
        model: usable[usable.length - 1] ?? req.modelId,
        mode: verified ? "protected" : "general",
        regenerations: 0,
        emptyCompletions: emptyCompletionCount,
      };
      yield { type: "text", text: message };
      yield { type: "done" };
      return;
    }

    yield {
      type: "error",
      error: lastError?.userMessage ?? GUARD_FAILURE_MESSAGE,
      errorCode: lastError ? codeFromProviderKind(lastError.kind) : "quality_guard",
    };
  }

  /**
   * متابعة صامتة بعد تسريب لغوي متأخر: يُطلب من نموذج آخر إكمال الرد من آخر
   * جملة نظيفة بالعربية فقط، بلا إعادة بداية. المستخدم لا يرى خطأ ولا النص
   * المخالف. وإن تعذّر الإكمال يُنهى الرد بعبارة قصيرة عند آخر جملة نظيفة.
   * يُجمَّع رد المتابعة كاملًا (مسار تعافٍ نادر) ليُنقّى ويُفحص قبل عرضه.
   */
  private async *continueAfterLeak(
    req: ChatRequest,
    model: string,
    expected: ReturnType<typeof detectExpectedLanguage>,
    userText: string,
    emitted: string,
    stats: ProviderStats,
  ): AsyncGenerator<StreamChunk> {
    const contReq: ChatRequest = {
      ...req,
      systemPrompt: (req.systemPrompt ?? "") + CONTINUATION_SUFFIX,
      messages: [...req.messages, { role: "assistant", content: emitted }],
    };

    const r: AttemptResult = yield* this.attempt(
      contReq,
      model,
      { strictLang: true, strictUnc: false, buffered: true },
      userText,
      expected,
      stats,
    );

    if (r.status === "ok") {
      // انزع ما أعاده النموذج من نص سبق عرضه (مقارنة على مستوى الكلمات)،
      // ثم افحص التكملة لغويًا. أي شكّ في التكرار → لا تُعرض إطلاقًا.
      const d = dedupeContinuation(emitted, r.text ?? "");
      if (d.ok && !violatesLanguage(d.text, expected, userText, req.sourceVocabulary).violated) {
        yield { type: "text", text: (/\s$/.test(emitted) ? "" : " ") + d.text };
        if (r.usage) yield { type: "usage", usage: r.usage };
        yield { type: "done" };
        return;
      }
      // رمز القرار فقط — بلا نص الرد ولا الكلمة المخالفة
      console.error(`[openrouter] continuation rejected: reason=${d.ok ? "language" : d.reason}`);
    }

    /**
     * فشل الإكمال (تسريب أو عطل تقني) — إنهاء بلا رسالة خطأ.
     *
     * v0.7.0 RC8: الوصول إلى هنا يعني أن المتابعة **رُفضت**، فالرد ناقص
     * بالتعريف مهما بدت نهايته سليمة. ربط العلامة بـshouldAppendTruncatedNotice
     * وحده كان يُسقطها كلما انتهى المعروض بكتلة كود مغلقة — وهي نهاية تُعدّ
     * «جملة مكتملة» منذ RC7 — فيُحفظ رد مبتور على أنه مكتمل.
     *
     * التنبيه يُضاف عند الحاجة فقط (finalize يتكفّل بعدم التكرار)، أما
     * **حالة النقص فتُسجَّل دائمًا**.
     */
    const finalized = finalizeIncompleteText(emitted);
    const added = finalized.slice(emitted.length);
    if (added) yield { type: "text", text: added };
    yield {
      type: "done",
      completion: "incomplete_guard",
      completionReason: "continuation_rejected",
    };
  }

  /**
   * إعادة توليد واحدة بعد سقوط حارس الإسناد: يُطلب من النموذج ألا يذكر مواقع
   * أو خطوات أو أرقامًا غير موثقة وأن يعترف باختصار. إن أصرّ على التفاصيل
   * غير المُسنَدة تُعرض الرسالة الآمنة المرتبطة بالكيان — بلا تمرير أي تفصيل.
   */
  private async *regenerateGrounded(
    req: ChatRequest,
    model: string,
    expected: ReturnType<typeof detectExpectedLanguage>,
    userText: string,
    grounding: NonNullable<ChatRequest["grounding"]>,
    stats: ProviderStats,
  ): AsyncGenerator<StreamChunk> {
    const strictReq: ChatRequest = {
      ...req,
      systemPrompt: (req.systemPrompt ?? "") + STRICT_GROUNDING_SUFFIX,
    };
    const r: AttemptResult = yield* this.attempt(
      strictReq,
      model,
      { strictLang: false, strictUnc: true, buffered: true },
      userText,
      expected,
      stats,
    );

    const meta = (blocked: boolean): StreamChunk => ({
      type: "meta",
      model: r.model ?? model,
      mode: "protected",
      regenerations: 1,
      groundingSource: grounding.source,
      protectedDetailBlocked: blocked,
    });

    if (r.status === "ok") {
      const text = (r.text ?? "").trim();
      const clean =
        text.length > 0 &&
        !violatesLanguage(text, expected, userText, req.sourceVocabulary).violated &&
        !violatesGrounding(text, userText, grounding).violated;
      if (clean) {
        yield meta(false);
        yield { type: "text", text };
        if (r.usage) yield { type: "usage", usage: r.usage };
        yield { type: "done" };
        return;
      }
    }

    // ما زال يذكر تفاصيل غير موثقة (أو تعذّر التوليد) → الرسالة الآمنة وحدها
    yield meta(true);
    yield { type: "text", text: buildUnsourcedMessage(userText) };
    yield { type: "done" };
  }

  /**
   * إعادة توليد صارمة واحدة على نفس النموذج بعد سقوط حارس عدم اليقين.
   * إن جاء الرد نظيفًا (بلا تخمين متحفّظ ولا خلل لغة) سُلّم؛ وإلا عُرضت رسالة
   * عدم التأكد الآمنة بدل التخمين. لا تُدخل حلقة تكرار — محاولة واحدة فقط.
   */
  private async *regenerateStrict(
    req: ChatRequest,
    model: string,
    expected: ReturnType<typeof detectExpectedLanguage>,
    userText: string,
    stats: ProviderStats,
  ): AsyncGenerator<StreamChunk> {
    const retry: AttemptResult = yield* this.attempt(
      req,
      model,
      { strictLang: false, strictUnc: true, buffered: true },
      userText,
      expected,
      stats,
    );

    if (retry.status === "ok") {
      const text = retry.text ?? "";
      const actualModel = retry.model ?? model;
      const clean =
        !violatesLanguage(text, expected, userText, req.sourceVocabulary).violated &&
        !violatesUncertainty(userText, text).violated;
      if (clean && text) {
        yield {
          type: "meta",
          attemptCount: stats.attempts,
          model: actualModel,
          mode: "protected",
          regenerations: 1,
        };
        yield { type: "text", text };
        if (retry.usage) yield { type: "usage", usage: retry.usage };
        yield { type: "done" };
        return;
      }
      // ما زال يخمّن (أو كسر اللغة) بعد الصرامة → رسالة آمنة
      yield {
          type: "meta",
          attemptCount: stats.attempts,
          model: actualModel,
          mode: "protected",
          regenerations: 1,
        };
      yield { type: "text", text: UNCERTAINTY_FALLBACK_MESSAGE };
      yield { type: "done" };
      return;
    }

    if (retry.status === "aborted") return;

    // فشل تقني في إعادة التوليد — لا نكرر، نعرض الرسالة الآمنة
    yield { type: "meta", model, mode: "protected", regenerations: 1 };
    yield { type: "text", text: UNCERTAINTY_FALLBACK_MESSAGE };
    yield { type: "done" };
  }

  /**
   * محاولة واحدة مع نموذج محدد، بوضعين:
   * - buffered=false (البثّ العام): يُفحص كل مقطع بحارس اللغة **قبل** عرضه ثم يُبثّ
   *   فورًا. زمن أول token كما هو (نافذة الحارس نفسها) بلا أي تجميع كامل.
   * - buffered=true (الوضع المحمي): يُجمَّع الرد كاملًا ويُرجَّع بلا عرض، ليفحصه
   *   الحارسان في streamChat قبل التسليم.
   */
  private async *attempt(
    req: ChatRequest,
    model: string,
    opts: { strictLang: boolean; strictUnc: boolean; buffered: boolean },
    userText: string,
    expected: ReturnType<typeof detectExpectedLanguage>,
    stats: ProviderStats,
    /** موعد السلسلة النهائي — يُجهض هذه المحاولة أينما بلغت */
    chainSignal?: AbortSignal,
  ): AsyncGenerator<StreamChunk, AttemptResult> {
    const system =
      (req.systemPrompt ?? "") +
      (opts.strictLang ? STRICT_LANGUAGE_SUFFIX : "") +
      (opts.strictUnc ? STRICT_UNCERTAINTY_SUFFIX : "");
    const messages: { role: string; content: string }[] = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of req.messages) {
      if (m.role !== "system") messages.push({ role: m.role, content: m.content });
    }

    // مهلة الخمول (v0.7.0): تُقاس من **آخر بايت وصل** لا من بداية الطلب.
    // الفرق جوهري: بثّ بطيء لكنه متدفّق كان يُقتل عند 25ث رغم أنه يعمل؛
    // والمطلوب قتل الخامل فقط. تُعاد تسليحها عند كل دفعة (armIdle أدناه).
    const timeout = new AbortController();
    const idleMs = idleTimeoutMs();
    /**
     * قبل أول إطار بروتوكول: المهلة مهلةُ **أول بايت** ولا تُعاد تسليحها.
     * وبعده: مهلة خمول تُعاد تسليحها عند كل إطار `data:` — لا عند كل بايت.
     *
     * التمييز هو الإصلاح: نبضة الإبقاء بايتٌ بلا محتوى، وعدُّها تقدّمًا يُبقي
     * الطلب معلّقًا على نموذج لم يبدأ التوليد.
     */
    /**
     * ★ «أول بايت» تعني أول **محتوى**، لا أول إطار بروتوكول.
     *
     * المزوّد يفتتح البثّ بإطار `data:` بلا نصّ (`delta.role` وحده)، وقد يتبعه
     * إطارات وصفية. وعدُّ ذلك بدايةً للتوليد كان يُرقّي المؤقّت من مهلة أول
     * بايت (20 ث) إلى مهلة الخمول (25 ث)، فتصير كل محاولة متلكّئة أطول مما
     * قُدّر لها — والمقياس أثبته: محاولتان بإطار فارغ استغرقتا 530مل بمهل
     * 200/250، أي أن الفعّال كان 250 لا 200.
     */
    let sawContent = false;
    /**
     * مرحلة المهلة — تتحرّك مع تقدّم المحاولة.
     *
     * تبدأ `before_response` لأن المؤقّت يُسلَّح **قبل** `fetch`: انقضاؤه هنا
     * يعني أننا لم نتلقَّ استجابة بعد. ثم `first_content` بعد وصول الترويسات
     * وقبل أول محتوى مفيد، ثم `stream_idle` بعد أن يبدأ المحتوى.
     */
    let timeoutStage: "before_response" | "first_content" | "stream_idle" = "before_response";
    let headersReceived = false;
    let sseFrameCount = 0;
    let contentByteCount = 0;
    /** لقطة القياسات — تُرفق بكل مخرج من مخارج المحاولة */
    const telemetry = () => ({
      timeoutStage: timeout.signal.aborted ? timeoutStage : ("none" as const),
      headersReceived,
      sseFrameCount,
      contentByteCount,
    });
    let timeoutId = setTimeout(() => timeout.abort(), firstByteTimeoutMs());
    const armIdle = () => {
      if (!sawContent) return; // لم يصل محتوى بعد — مهلة أول بايت قائمة
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => timeout.abort(), idleMs);
    };
    /** يُستدعى عند أول **محتوى** — ينقل المؤقّت من «أول بايت» إلى «خمول» */
    const markFirstContent = () => {
      if (sawContent) return;
      sawContent = true;
      timeoutStage = "stream_idle";
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => timeout.abort(), idleMs);
    };
    const onClientAbort = () => timeout.abort();
    req.signal?.addEventListener("abort", onClientAbort);
    /**
     * موعد السلسلة يقطع المحاولة **ما لم يكن المحتوى قد بدأ**.
     *
     * غرض الميزانية أن تحدّ من تجريب النماذج، لا أن تبتر جوابًا يعمل: نموذج
     * يبثّ ببطء لكنه يتقدّم قد يتجاوز 45 ث وهو سليم، وقطعه يُري المستخدم ردًّا
     * مبتورًا — وهو أسوأ من الانتظار الذي جئنا نعالجه.
     *
     * فبعد أول محتوى تتولّى مهلة الخمول (25 ث بين الدفعات) وسقف المسار
     * (110 ث) الحراسة، وقبله يحكم موعد السلسلة.
     */
    const onChainDeadline = () => {
      if (!sawContent) timeout.abort();
    };
    chainSignal?.addEventListener("abort", onChainDeadline);
    if (chainSignal?.aborted) timeout.abort();

    let res: Response;
    stats.providerCalls++; // طلب توليد فعلي واحد
    try {
      res = await fetch(providerUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://ysd.ai",
          "X-Title": "YSD AI",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature ?? 0.3,
          top_p: 0.9,
          usage: { include: true },
        }),
        signal: timeout.signal,
      });
    } catch {
      clearTimeout(timeoutId);
      req.signal?.removeEventListener("abort", onClientAbort);
      if (req.signal?.aborted) return { status: "aborted" };
      // مهلتنا نحن (أول بايت/خمول) تُميَّز عن انقطاع الشبكة — كلاهما قابل للإعادة
      return { status: "network_error", timedOut: timeout.signal.aborted, ...telemetry() };
    }
    headersReceived = true;
    // الترويسات وصلت: ما بعدها انتظارٌ لمحتوى مفيد لا انتظارٌ لاستجابة
    if (!sawContent) timeoutStage = "first_content";
    // ملاحظة (v0.6.6 RC2): المهلة تبقى **مسلّحة** حتى نهاية قراءة البثّ.
    // كانت تُلغى هنا فور وصول الترويسات، فمزوّد يرسل الترويسات بسرعة ثم يتلكّأ
    // في الجسم كان يتجاوز أي سقف: قِيس حيًّا 85.7 ثانية رغم ميزانية 45 ثانية.
    //
    // ⚠️ v0.7.0 RC4 — السبب الجذري لتعليق السقف الكلي: كان هنا
    // `req.signal?.removeEventListener("abort", onClientAbort)`، فيُفصل رابط
    // الإلغاء **فور وصول الترويسات**. بعدها لا يصل إجهاض السقف إلى fetch
    // إطلاقًا، ويبقى reader.read() معلّقًا على بثّ لا ينتهي — طلب تجاوز 10
    // دقائق بسقف ثانية واحدة، والمزوّد لم يسجّل أي client_aborted.
    // الرابط الآن يبقى حتى finally (حيث يُنزع مرة واحدة).

    if (!res.ok || !res.body) {
      clearTimeout(timeoutId);
      const raw = await res.text().catch(() => "");
      return {
        status: "http_error",
        httpStatus: res.status,
        errorRaw: raw,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
        ...telemetry(),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage: UsageReport | null = null;
    let actualModel = model;
    let full = ""; // الرد الكامل — لا يُعرض قبل اجتياز الحارسَين
    let finishReason: string | null = null;
    let reasoningPresent = false; // قيمة منطقية فقط — التفكير لا يُخزَّن ولا يُعرض
    let seg = ""; // ما لم تكتمل منه جملة بعد
    let emitted = ""; // الجمل النظيفة التي عُرضت فعلًا
    let anyFlushed = false; // هل عُرض شيء للمستخدم بالفعل؟

    /**
     * يفحص وحدة قبل عرضها؛ يُرجع رمز السبب فقط — بلا الكلمة المخالفة.
     *
     * حالة سياج الكود (v0.7.0 RC8) تُشتقّ من **كامل** النص المعروض. المحاولتان
     * السابقتان ربطتاها بقصّة بطول ثابت (GUARD_OVERLAP_CHARS = 24)، وثبت حيًّا
     * أن حدّ القصّ يشطر علامة ``` نفسها فلا يراها أيٌّ من الطرفين:
     *
     *   emitted       = "**الدالة**\n\n```python\nimport requests"  (37 حرفًا)
     *   beforeOverlap = "**الدالة**\n\n`"          ← لا ``` كاملة
     *   overlap       = "``python\nimport requests" ← ولا هنا
     *
     * فيُقرأ جوف الكتلة نثرًا عربيًا، ويسقط stray_latin على `requests` و
     * `response`، فيُقطع رد برمجي سليم. القصّ لم يعد مسؤولًا عن حالة السياج
     * إطلاقًا، والتداخل صار يُؤخذ من النثر المجرَّد فيستحيل أن يشقّ علامة.
     */
    const checkSegment = (s: string): string | null => {
      // حالة السياج تُشتقّ من **كامل** ما عُرض — لا من قصّة بعدد أحرف ثابت.
      const insideCode = endsInsideCodeFence(emitted);
      const unitProse = stripCodeAware(s, insideCode).prose;
      if (unitProse.trim() === "") return null; // الوحدة كلها كود → لا فحص نثر

      // التداخل يُؤخذ من **نثر** ما عُرض لا من نصّه الخام، فيستحيل أن يشقّ ```
      const emittedProse = stripCodeAware(emitted, false).prose;
      const proseOverlap = emittedProse.slice(-GUARD_OVERLAP_CHARS);

      const verdict = violatesStreamUnit(proseOverlap + unitProse, expected, userText, false, req.sourceVocabulary);
      return verdict.violated ? (verdict.reason ?? "unknown") : null;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // ★ لا تسليح هنا: البايت قد يكون نبضة إبقاء بلا محتوى
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          // تعليق SSE (`: PROCESSING`) نبضةُ إبقاء — لا تُعدّ تقدّمًا
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;

          let chunk: SSEDelta;
          try {
            chunk = JSON.parse(payload) as SSEDelta;
          } catch {
            continue;
          }

          if (chunk.error?.message) {
            // خطأ أثناء البث وقبل أي عرض — عامله كخطأ تقني قابل للتحويل/الاحتياط
            await reader.cancel().catch(() => undefined);
            return { status: "http_error", errorRaw: chunk.error.message };
          }

          if (chunk.model) actualModel = chunk.model;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          // وجود التفكير يُسجَّل كقيمة منطقية فقط — لا يُقرأ محتواه ولا يُمرَّر
          if (choice?.delta?.reasoning || choice?.delta?.reasoning_content) {
            reasoningPresent = true;
          }

          sseFrameCount++;
          const text = choice?.delta?.content;
          if (typeof text === "string") contentByteCount += text.length;
          if (!text) continue;
          // ★ هنا وحده «بدأ التوليد»: محتوى فعلي لا إطار وصفي
          markFirstContent();
          armIdle();
          full += text;
          if (opts.buffered) continue; // الوضع المحمي: تجميع بلا عرض

          // البثّ العام: وحدات جمل — تُجمَّع حتى نهاية جملة (أو حدّ آمن) وتُفحص قبل العرض.
          seg += text;
          for (;;) {
            const { ready, rest } = takeCompleteUnits(seg);
            if (!ready) break;
            // وحدة بيضاء (مسافات/أسطر فقط) لا تُعرض وحدها — تُضمّ إلى ما بعدها
            if (ready.trim() === "") break;
            seg = rest;
            const reason = checkSegment(ready);
            if (reason) {
              await reader.cancel().catch(() => undefined);
              // لم يُعرض شيء بعد → احتياط نظيف بنموذج آخر
              if (!anyFlushed) return { status: "guard_violation", guardReason: reason };
              // عُرضت جمل نظيفة — لا تُعرض الجملة المخالفة ولا رسالة خطأ؛ تُتابَع صامتًا
              return {
                status: "leak_after_flush",
                guardReason: reason,
                emitted,
                model: actualModel,
                usage,
              };
            }
            if (!anyFlushed) {
              yield { type: "meta", model: actualModel, mode: "general", regenerations: 0 };
              anyFlushed = true;
            }
            yield { type: "text", text: ready };
            emitted += ready;

          }
        }
      }

      // v0.6.6: رد لا يحوي إلا تمهيدًا معلّقًا («اتبع الخطوات:» أو «1.» وحده)
      // ليس إجابة — يُعامَل كإكمال فارغ فيُجرَّب نموذج آخر بدل عرض بادئة مبتورة.
      if (!isEmptyCompletion(full) && endsWithDanglingPreamble(full) && !anyFlushed) {
        console.error(
          `[openrouter] failure_kind=dangling_preamble model_id=${model} text_char_count=${full.length}`,
        );
        return {
          status: "empty_completion",
          model: actualModel,
          finishReason,
          reasoningPresent,
          textLen: full.length,
        };
      }

      // إكمال فارغ (لا نص، أو مسافات/أسطر فقط، أو تفكير بلا إجابة) = فشل محاولة.
      // لا يُمرَّر إلى الحارسَين ولا يُعرض ولا يُحفظ.
      if (isEmptyCompletion(full)) {
        return {
          status: "empty_completion",
          model: actualModel,
          finishReason,
          reasoningPresent,
          textLen: full.length,
        };
      }

      if (opts.buffered) return { status: "ok", text: full, model: actualModel, usage };

      // بقية النص الأخيرة — وحدة تُفحص أيضًا قبل عرضها.
      // v0.6.6: إن لم تكن إلا تمهيدًا معلّقًا فلا تُعرض (الرد انتهى قبل الخطوات).
      if (seg && !endsWithDanglingPreamble(seg)) {
        const reason = checkSegment(seg);
        if (reason) {
          if (!anyFlushed) return { status: "guard_violation", guardReason: reason };
          return {
            status: "leak_after_flush",
            guardReason: reason,
            emitted,
            model: actualModel,
            usage,
          };
        }
        if (!anyFlushed) {
          yield { type: "meta", model: actualModel, mode: "general", regenerations: 0 };
          anyFlushed = true;
        }
        yield { type: "text", text: seg };
        emitted += seg;
      }
      if (usage) yield { type: "usage", usage };
      yield { type: "done" };
      return { status: "ok", text: full, model: actualModel, usage, emitted };
    } catch {
      if (req.signal?.aborted) return { status: "aborted" };
      // يشمل انقضاء مهلة المحاولة أثناء البثّ (المهلة تبقى مسلّحة عمدًا)
      console.error("[openrouter] stream read failed or timed out");
      // v0.7.0 RC8: نُعيد ما عُرض فعلًا. بدونه كان النص الذي شاهده المستخدم
      // يضيع، ويُستأنف احتياط بنموذج آخر وكأن شيئًا لم يُعرض.
      return {
        status: "network_error",
        emitted,
        model: actualModel,
        timedOut: timeout.signal.aborted,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * نداء JSON غير متدفّق — **خارج سلسلة الاحتياط وخارج حرّاس اللغة** (v0.9.0).
 *
 * لماذا لا يمرّ بـ`streamChat`: مخرَجه JSON محض بالإنجليزية، وحارس اللغة
 * سيقرأه نثرًا دخيلًا فيرفضه — وهو نفس جذر عطل الغلاف. وهذا المسار ليس كلامًا
 * للمستخدم أصلًا: لا يُعرض، ولا يُحفظ، ولا يمرّ بأي حارس عرض.
 *
 * ومحدود عمدًا: نموذج واحد، محاولة واحدة، مهلة قصيرة، وسقف رموز صغير — فكلفته
 * معروفة سلفًا ولا تتضاعف بالسلسلة.
 */
export async function requestJsonCompletion(input: {
  model: string;
  systemPrompt: string;
  userText: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string } | { ok: false; reason: "timeout" | "error" }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, reason: "error" };

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
  const onAbort = () => timeout.abort();
  input.signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(providerUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ysd.ai",
        "X-Title": "YSD AI",
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userText },
        ],
        stream: false,
        max_tokens: input.maxTokens,
        temperature: 0,
      }),
      signal: timeout.signal,
    });
    if (!res.ok) return { ok: false, reason: "error" };
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "error" };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: input.signal?.aborted ? "error" : "timeout" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
