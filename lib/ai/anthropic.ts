import Anthropic from "@anthropic-ai/sdk";
import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";

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
      // لا نُسرّب تفاصيل حساسة للعميل — التفاصيل تذهب للسجلات فقط
      console.error("[anthropic] stream error:", err);
      yield { type: "error", error: "تعذّر إكمال الطلب لدى موفر الذكاء الاصطناعي." };
    }
  }
}
