import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk, UsageReport } from "./types";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "./free-models";
import {
  type CooldownReason,
  cooldownRemainingMs,
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
  TRUNCATED_NOTICE,
  dedupeContinuation,
  endsWithDanglingPreamble,
  shouldAppendTruncatedNotice,
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
const PROVIDER_TIMEOUT_MS = 25_000;

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
const CHAIN_BUDGET_MS = 45_000;

/** تصنيف أخطاء OpenRouter إلى رسائل عربية واضحة — دون كشف تفاصيل حساسة */
export function mapOpenRouterError(status: number | null, raw: string): {
  kind: string;
  userMessage: string;
} {
  const lower = raw.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      userMessage: "إعدادات موفر الذكاء الاصطناعي غير صحيحة. تواصل مع إدارة المنصة.",
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
}

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
  // 5xx أو مهلة/شبكة — عطل مزوّد عابر
  if (kind === "overloaded" || kind === "network") return "provider_error";
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

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const chain: readonly string[] =
      req.modelId === YSD_FREE_MODEL_ID ? FREE_MODEL_CHAIN : [req.modelId];

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
    const stats: ProviderStats = { providerCalls: 0 };

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
        model: req.modelId,
        mode: "protected",
        regenerations: 0,
        emptyCompletions: 0,
        groundingSource: "none",
        protectedDetailBlocked: true,
        shortCircuit: true,
        providerCalls: 0,
      };
      yield { type: "text", text: buildUnsourcedMessage(userText) };
      yield { type: "done" };
      return;
    }

    // تخطٍّ **قبل** أي طلب: نموذج مهدّأ لا يُرسَل إليه أصلًا.
    const usable = chain.filter((m) => !isCoolingDown(m));
    if (usable.length === 0) {
      // الجميع مهدّأ — لا ننتظر ولا نكرر المحاولات. نُبلغ المستخدم بمدة صادقة.
      const soonestMs = Math.min(...chain.map((m) => cooldownRemainingMs(m)));
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
    for (let i = 0; i < usable.length; i++) {
      const model = usable[i];
      if (!model) continue;

      // سقف انتظار المستخدم: لا نبدأ محاولة جديدة بعد نفاد الميزانية
      if (i > 0 && Date.now() - chainStartedAt >= CHAIN_BUDGET_MS) {
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

      const result: AttemptResult = yield* this.attempt(
        req,
        model,
        { strictLang: langRetryUsed, strictUnc: uncRetryUsed, buffered: verified },
        userText,
        expected,
        stats,
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
        console.error(
          `[openrouter] late leak: model=${model} reason=${result.guardReason ?? "?"} continue=${!langRetryUsed}`,
        );
        const next = usable[i + 1];
        if (!langRetryUsed && next) {
          langRetryUsed = true; // احتياط لغوي واحد فقط
          yield* this.continueAfterLeak(req, next, expected, userText, result.emitted ?? "", stats);
          return;
        }
        // لا احتياط متاح — إنهاء عند آخر جملة نظيفة.
        // العبارة تُضاف فقط إن كان الرد ناقصًا فعلًا؛ وإلا نُنهي بصمت.
        if (shouldAppendTruncatedNotice(result.emitted ?? "")) {
          yield { type: "text", text: TRUNCATED_NOTICE };
        }
        yield { type: "done" };
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
        const lang = violatesLanguage(text, expected, userText);
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
          yield { type: "meta", model: actualModel, mode: "protected", regenerations: 1 };
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
        yield {
          type: "meta",
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

      // فشل تقني (429/5xx/شبكة) — هدّئ النموذج ثم جرّب التالي في السلسلة
      lastError =
        result.status === "network_error"
          ? {
              kind: "network",
              userMessage: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مجددًا.",
            }
          : mapOpenRouterError(result.httpStatus ?? null, result.errorRaw ?? "");

      const reason: CooldownReason | null = cooldownReasonFor(lastError.kind);
      let cooledMs = 0;
      if (reason) cooledMs = markCooldown(model, reason, result.retryAfterMs ?? null);

      // سجل آمن: معرّف النموذج ونوع الخطأ ومدة التهدئة فقط —
      // لا مفاتيح ولا نص المستخدم ولا جسم رد الموفر.
      console.error(
        `[openrouter] attempt failed: model=${model} status=${result.httpStatus ?? "?"} ` +
          `kind=${lastError.kind}${reason ? ` cooldown=${reason} cooldown_ms=${cooledMs}` : " cooldown=none"}`,
      );
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
      if (d.ok && !violatesLanguage(d.text, expected, userText).violated) {
        yield { type: "text", text: (/\s$/.test(emitted) ? "" : " ") + d.text };
        if (r.usage) yield { type: "usage", usage: r.usage };
        yield { type: "done" };
        return;
      }
      // رمز القرار فقط — بلا نص الرد ولا الكلمة المخالفة
      console.error(`[openrouter] continuation rejected: reason=${d.ok ? "language" : d.reason}`);
    }

    // فشل الإكمال (تسريب أو عطل تقني) — إنهاء بلا رسالة خطأ.
    // إن كان المعروض إجابة مفيدة تنتهي بجملة مكتملة نُنهي بصمت: العبارة حينها
    // توحي بعطل بينما الرد سليم (رُصد حيًّا في رد Jujutsu Kaisen).
    if (shouldAppendTruncatedNotice(emitted)) {
      yield { type: "text", text: TRUNCATED_NOTICE };
    }
    yield { type: "done" };
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
        !violatesLanguage(text, expected, userText).violated &&
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
        !violatesLanguage(text, expected, userText).violated &&
        !violatesUncertainty(userText, text).violated;
      if (clean && text) {
        yield { type: "meta", model: actualModel, mode: "protected", regenerations: 1 };
        yield { type: "text", text };
        if (retry.usage) yield { type: "usage", usage: retry.usage };
        yield { type: "done" };
        return;
      }
      // ما زال يخمّن (أو كسر اللغة) بعد الصرامة → رسالة آمنة
      yield { type: "meta", model: actualModel, mode: "protected", regenerations: 1 };
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
    let timeoutId = setTimeout(() => timeout.abort(), idleMs);
    const armIdle = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => timeout.abort(), idleMs);
    };
    const onClientAbort = () => timeout.abort();
    req.signal?.addEventListener("abort", onClientAbort);

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
      // مهلة الموفر أو انقطاع الشبكة — قابل لإعادة المحاولة
      return { status: "network_error" };
    }
    // ملاحظة (v0.6.6 RC2): المهلة تبقى **مسلّحة** حتى نهاية قراءة البثّ.
    // كانت تُلغى هنا فور وصول الترويسات، فمزوّد يرسل الترويسات بسرعة ثم يتلكّأ
    // في الجسم كان يتجاوز أي سقف: قِيس حيًّا 85.7 ثانية رغم ميزانية 45 ثانية.
    req.signal?.removeEventListener("abort", onClientAbort);

    if (!res.ok || !res.body) {
      clearTimeout(timeoutId);
      const raw = await res.text().catch(() => "");
      return {
        status: "http_error",
        httpStatus: res.status,
        errorRaw: raw,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
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
    let overlap = ""; // ذيل ما عُرض — يُفحص مع الوحدة التالية منعًا لانقسام كلمة دخيلة

    // يفحص وحدة (مع تداخل) قبل عرضها؛ يُرجع رمز السبب فقط — بلا الكلمة المخالفة
    const checkSegment = (s: string): string | null => {
      const verdict = violatesStreamUnit(overlap + s, expected, userText);
      return verdict.violated ? (verdict.reason ?? "unknown") : null;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // وصلت بيانات → أعد تسليح مهلة الخمول من هذه اللحظة
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
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

          const text = choice?.delta?.content;
          if (!text) continue;
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
            overlap = emitted.slice(-GUARD_OVERLAP_CHARS);
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
      return { status: "network_error" };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
