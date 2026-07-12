import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";

/**
 * موفر OpenRouter — عبر واجهة Chat Completions المتوافقة مع OpenAI.
 * النموذج الافتراضي للتطوير: "openrouter/free" — موجّه رسمي من OpenRouter
 * يختار تلقائيًا نموذجًا مجانيًا متاحًا، فلا يعتمد النظام على نموذج مجاني بعينه.
 * المفتاح يُقرأ من البيئة على الخادم فقط — لا يصل للمتصفح أو السجلات أبدًا.
 */

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

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
      userMessage:
        "الخدمة المجانية مضغوطة حاليًا. انتظر قليلًا ثم أعد المحاولة.",
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
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
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
        id: "openrouter/free",
        providerId: this.id,
        displayNameAr: "YSD مجاني",
        displayNameEn: "YSD Free",
        contextWindow: 32_000,
        enabled: true,
      },
    ];
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const messages: { role: string; content: string }[] = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    for (const m of req.messages) {
      if (m.role !== "system") messages.push({ role: m.role, content: m.content });
    }

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          // تعريف اختياري لدى OpenRouter — لا يحمل أي أسرار
          "HTTP-Referer": "https://ysd.ai",
          "X-Title": "YSD AI",
        },
        body: JSON.stringify({
          model: req.modelId,
          messages,
          stream: true,
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature,
          usage: { include: true },
        }),
        signal: req.signal,
      });
    } catch {
      if (req.signal?.aborted) {
        yield { type: "done" };
        return;
      }
      console.error("[openrouter] fetch failed: network");
      yield {
        type: "error",
        error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مجددًا.",
      };
      return;
    }

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      const mapped = mapOpenRouterError(res.status, raw);
      // السجل يحمل الحالة والتصنيف فقط — لا مفاتيح ولا نص خام
      console.error(`[openrouter] request failed: status=${res.status} kind=${mapped.kind}`);
      yield { type: "error", error: mapped.userMessage };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage: { inputTokens: number; outputTokens: number } | null = null;

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
            const mapped = mapOpenRouterError(null, chunk.error.message);
            console.error(`[openrouter] stream error event: kind=${mapped.kind}`);
            yield { type: "error", error: mapped.userMessage };
            return;
          }
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield { type: "text", text };
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
        }
      }

      if (usage) yield { type: "usage", usage };
      yield { type: "done" };
    } catch {
      if (req.signal?.aborted) {
        yield { type: "done" };
        return;
      }
      console.error("[openrouter] stream read failed");
      yield { type: "error", error: "انقطع البث أثناء توليد الرد. أعد المحاولة." };
    }
  }
}
