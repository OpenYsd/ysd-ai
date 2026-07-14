import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk, UsageReport } from "./types";
import { FREE_MODEL_CHAIN, YSD_FREE_MODEL_ID } from "./free-models";
import {
  GUARD_FAILURE_MESSAGE,
  GUARD_WINDOW_CHARS,
  STRICT_LANGUAGE_SUFFIX,
  detectExpectedLanguage,
  violatesLanguage,
} from "./language-guard";

/**
 * موفر OpenRouter — واجهة Chat Completions المتوافقة مع OpenAI.
 *
 * النموذج المنطقي "ysd/free" يُحل إلى سلسلة نماذج مجانية معتمدة
 * (lib/ai/free-models.ts) بدلًا من الموجّه العشوائي openrouter/free.
 * حارس اللغة يخزّن أول نافذة من الرد ويوقف النموذج قبل عرض خليط لغات،
 * ثم يعيد المحاولة مرة واحدة بالنموذج الاحتياطي وبموجه أكثر صرامة.
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
  if (status === 404 || lower.includes("no endpoints") || lower.includes("not found")) {
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

/** نتيجة محاولة واحدة مع نموذج واحد */
interface AttemptResult {
  status: "ok" | "guard_violation" | "http_error" | "network_error" | "aborted";
  httpStatus?: number;
  errorRaw?: string;
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

    let guardRetryUsed = false;
    let lastError: { kind: string; userMessage: string } | null = null;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      if (!model) continue;
      const strict = guardRetryUsed;
      const result: AttemptResult = yield* this.attempt(req, model, strict, userText, expected);

      if (result.status === "ok" || result.status === "aborted") return;

      if (result.status === "guard_violation") {
        console.error(`[openrouter] language guard tripped: model=${model} expected=${expected}`);
        if (!guardRetryUsed && i + 1 < chain.length) {
          // إعادة محاولة واحدة بالنموذج الاحتياطي وبموجه أكثر صرامة
          guardRetryUsed = true;
          continue;
        }
        yield { type: "error", error: GUARD_FAILURE_MESSAGE };
        return;
      }

      // فشل تقني (429/5xx/شبكة) — جرّب التالي في السلسلة
      lastError =
        result.status === "network_error"
          ? {
              kind: "network",
              userMessage: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مجددًا.",
            }
          : mapOpenRouterError(result.httpStatus ?? null, result.errorRaw ?? "");
      console.error(
        `[openrouter] attempt failed: model=${model} status=${result.httpStatus ?? "?"} kind=${lastError.kind}`,
      );
    }

    yield {
      type: "error",
      error: lastError?.userMessage ?? GUARD_FAILURE_MESSAGE,
    };
  }

  /**
   * محاولة واحدة مع نموذج محدد: بث + نافذة حارس اللغة.
   * لا تُصدر usage إلا عند نجاح المحاولة — فلا يُسجل استهلاك لمحاولة فاشلة.
   */
  private async *attempt(
    req: ChatRequest,
    model: string,
    strictPrompt: boolean,
    userText: string,
    expected: ReturnType<typeof detectExpectedLanguage>,
  ): AsyncGenerator<StreamChunk, AttemptResult> {
    const system = (req.systemPrompt ?? "") + (strictPrompt ? STRICT_LANGUAGE_SUFFIX : "");
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
      if (req.signal?.aborted) {
        yield { type: "done" };
        return { status: "aborted" };
      }
      // مهلة الموفر أو انقطاع الشبكة — قابل لإعادة المحاولة
      return { status: "network_error" };
    }
    clearTimeout(timeoutId);
    req.signal?.removeEventListener("abort", onClientAbort);

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      return { status: "http_error", httpStatus: res.status, errorRaw: raw };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage: UsageReport | null = null;
    let actualModel = model;

    // نافذة الحارس: نخزّن أول جزء من الرد قبل عرضه
    let window = "";
    let windowFlushed = false;

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
            if (windowFlushed) {
              // الخطأ بعد بدء العرض — نبلغه ونُنهي
              const mapped = mapOpenRouterError(null, chunk.error.message);
              console.error(`[openrouter] mid-stream error: kind=${mapped.kind}`);
              yield { type: "error", error: mapped.userMessage };
              return { status: "ok" };
            }
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

          if (windowFlushed) {
            yield { type: "text", text };
            continue;
          }

          window += text;
          if (window.length >= GUARD_WINDOW_CHARS) {
            const verdict = violatesLanguage(window, expected, userText);
            if (verdict.violated) {
              await reader.cancel().catch(() => undefined);
              return { status: "guard_violation" };
            }
            yield { type: "meta", model: actualModel };
            yield { type: "text", text: window };
            windowFlushed = true;
          }
        }
      }

      // انتهى البث والنافذة لم تُعرض بعد (رد قصير) — افحص ثم اعرض
      if (!windowFlushed) {
        const verdict = violatesLanguage(window, expected, userText);
        if (verdict.violated) return { status: "guard_violation" };
        yield { type: "meta", model: actualModel };
        if (window) yield { type: "text", text: window };
      }

      if (usage) yield { type: "usage", usage };
      yield { type: "done" };
      return { status: "ok" };
    } catch {
      if (req.signal?.aborted) {
        // عرض ما وصل قبل الإيقاف إن لم تكن النافذة عُرضت
        if (!windowFlushed && window) {
          yield { type: "meta", model: actualModel };
          yield { type: "text", text: window };
        }
        yield { type: "done" };
        return { status: "aborted" };
      }
      console.error("[openrouter] stream read failed");
      if (windowFlushed) {
        yield { type: "error", error: "انقطع البث أثناء توليد الرد. أعد المحاولة." };
        return { status: "ok" };
      }
      return { status: "network_error" };
    }
  }
}
