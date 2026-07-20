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
import {
  CONTINUATION_SUFFIX,
  GUARD_OVERLAP_CHARS,
  TRUNCATED_NOTICE,
  dedupeContinuation,
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
/** مهلة اتصال الموفر الخارجي */
const PROVIDER_TIMEOUT_MS = 60_000;

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
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

/** نتيجة محاولة واحدة مع نموذج واحد — الرد الكامل يُرجَّع للفحص في streamChat */
interface AttemptResult {
  status:
    | "ok"
    | "guard_violation" // تسريب قبل عرض أي شيء → احتياط نظيف بنموذج آخر
    | "leak_after_flush" // تسريب بعد عرض جمل نظيفة → متابعة صامتة
    | "http_error"
    | "network_error"
    | "aborted";
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
    let lastError: { kind: string; userMessage: string } | null = null;

    // اختيار الوضع: المحمي (تجميع + فحص قبل العرض) للأسئلة المتخصصة فقط،
    // والبثّ الفوري لكل ما عداها — فلا تدفع المحادثة العامة ثمن التحقق.
    const verified = needsVerifiedMode(userText);

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
      };
      return;
    }

    // الوضع المحمي: حالة قصيرة تصل فورًا قبل نداء المزوّد — لا شاشة انتظار فارغة.
    if (verified) yield { type: "status", text: VERIFYING_STATUS_MESSAGE };

    for (let i = 0; i < usable.length; i++) {
      const model = usable[i];
      if (!model) continue;
      const result: AttemptResult = yield* this.attempt(
        req,
        model,
        { strictLang: langRetryUsed, strictUnc: uncRetryUsed, buffered: verified },
        userText,
        expected,
      );

      if (result.status === "aborted") return;

      // تسريب بعد عرض جمل نظيفة — لا خطأ ولا نص مخالف: متابعة صامتة مرة واحدة
      if (result.status === "leak_after_flush") {
        console.error(
          `[openrouter] late leak: model=${model} reason=${result.guardReason ?? "?"} continue=${!langRetryUsed}`,
        );
        const next = usable[i + 1];
        if (!langRetryUsed && next) {
          langRetryUsed = true; // احتياط لغوي واحد فقط
          yield* this.continueAfterLeak(req, next, expected, userText, result.emitted ?? "");
          return;
        }
        // لا احتياط متاح — إنهاء لطيف عند آخر جملة نظيفة
        yield { type: "text", text: TRUNCATED_NOTICE };
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
          yield { type: "error", error: GUARD_FAILURE_MESSAGE };
          return;
        }

        // حارس عدم اليقين — تخمين متحفّظ لتفاصيل دقيقة → إعادة توليد صارمة واحدة
        if (violatesUncertainty(userText, text).violated) {
          console.error(`[openrouter] uncertainty guard tripped: model=${model}`);
          if (!uncRetryUsed) {
            uncRetryUsed = true;
            yield* this.regenerateStrict(req, model, expected, userText);
            return;
          }
          // سبق أن أُعيد التوليد بصرامة وما زال يخمّن → رسالة عدم تأكّد آمنة
          yield { type: "meta", model: actualModel, mode: "protected", regenerations: 1 };
          yield { type: "text", text: UNCERTAINTY_FALLBACK_MESSAGE };
          yield { type: "done" };
          return;
        }

        // رد نظيف → سلّمه
        yield { type: "meta", model: actualModel, mode: "protected", regenerations: 0 };
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

    yield {
      type: "error",
      error: lastError?.userMessage ?? GUARD_FAILURE_MESSAGE,
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

    // فشل الإكمال (تسريب أو عطل تقني) — إنهاء لطيف بلا رسالة خطأ
    yield { type: "text", text: TRUNCATED_NOTICE };
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
  ): AsyncGenerator<StreamChunk> {
    const retry: AttemptResult = yield* this.attempt(
      req,
      model,
      { strictLang: false, strictUnc: true, buffered: true },
      userText,
      expected,
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

    // مهلة صريحة للموفر الخارجي (مع احترام إلغاء العميل)
    const timeout = new AbortController();
    const timeoutId = setTimeout(() => timeout.abort(), PROVIDER_TIMEOUT_MS);
    const onClientAbort = () => timeout.abort();
    req.signal?.addEventListener("abort", onClientAbort);

    let res: Response;
    try {
      res = await fetch(API_URL, {
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
    clearTimeout(timeoutId);
    req.signal?.removeEventListener("abort", onClientAbort);

    if (!res.ok || !res.body) {
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

          const text = chunk.choices?.[0]?.delta?.content;
          if (!text) continue;
          full += text;
          if (opts.buffered) continue; // الوضع المحمي: تجميع بلا عرض

          // البثّ العام: وحدات جمل — تُجمَّع حتى نهاية جملة (أو حدّ آمن) وتُفحص قبل العرض.
          seg += text;
          for (;;) {
            const { ready, rest } = takeCompleteUnits(seg);
            if (!ready) break;
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

      if (opts.buffered) return { status: "ok", text: full, model: actualModel, usage };

      // بقية النص الأخيرة — وحدة تُفحص أيضًا قبل عرضها
      if (seg) {
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
      console.error("[openrouter] stream read failed");
      return { status: "network_error" };
    }
  }
}
