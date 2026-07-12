import Anthropic from "@anthropic-ai/sdk";
import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";

/** تصنيف أخطاء Anthropic إلى رسائل عربية واضحة للمستخدم — دون كشف تفاصيل حساسة */
export function mapAnthropicError(err: unknown): {
  status: number | null;
  kind: string;
  userMessage: string;
} {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? null;
    const raw = (err.message || "").toLowerCase();

    if (status === 400 && raw.includes("credit balance")) {
      return {
        status,
        kind: "insufficient_credit",
        userMessage:
          "رصيد خدمة الذكاء الاصطناعي غير كافٍ حاليًا. تواصل مع إدارة المنصة أو حاول لاحقًا.",
      };
    }
    if (status === 401 || status === 403) {
      return {
        status,
        kind: "auth",
        userMessage: "إعدادات موفر الذكاء الاصطناعي غير صحيحة. تواصل مع إدارة المنصة.",
      };
    }
    if (status === 429) {
      return {
        status,
        kind: "rate_limit",
        userMessage: "الخدمة مشغولة حاليًا. انتظر قليلًا ثم أعد المحاولة.",
      };
    }
    if (status === 529 || (status !== null && status >= 500)) {
      return {
        status,
        kind: "overloaded",
        userMessage: "خدمة الذكاء الاصطناعي غير متاحة مؤقتًا. أعد المحاولة بعد قليل.",
      };
    }
    return {
      status,
      kind: "api_error",
      userMessage: "تعذّر إكمال الطلب لدى موفر الذكاء الاصطناعي.",
    };
  }
  return {
    status: null,
    kind: "network",
    userMessage: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مجددًا.",
  };
}

/**
 * الموفر التجريبي الأول: Anthropic
 * المفتاح يُقرأ من البيئة على الخادم فقط — لا يصل للمتصفح أبدًا.
 */
export class AnthropicProvider implements AIProviderAdapter {
  readonly id = "anthropic";
  readonly displayName = "Anthropic";

  isConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: "claude-sonnet-4-6",
        providerId: this.id,
        displayNameAr: "YSD سريع",
        displayNameEn: "YSD Swift",
        contextWindow: 200_000,
        enabled: true,
      },
    ];
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      const stream = client.messages.stream(
        {
          model: req.modelId,
          max_tokens: req.maxTokens ?? 2048,
          temperature: req.temperature,
          system: req.systemPrompt,
          messages: req.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        },
        { signal: req.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      yield {
        type: "usage",
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        },
      };
      yield { type: "done" };
    } catch (err) {
      if (req.signal?.aborted) {
        yield { type: "done" };
        return;
      }
      // لا نُسرّب تفاصيل حساسة للعميل — نسجّل الحالة فقط دون أي مفاتيح
      const mapped = mapAnthropicError(err);
      console.error(`[anthropic] stream error: status=${mapped.status ?? "?"} kind=${mapped.kind}`);
      yield { type: "error", error: mapped.userMessage };
    }
  }
}
