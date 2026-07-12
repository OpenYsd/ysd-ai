import type { AIProviderAdapter, ModelInfo } from "./types";
import { AnthropicProvider } from "./anthropic";

/**
 * سجل الموفرين — نقطة الإضافة الوحيدة لأي موفر جديد.
 * أضف الموفر هنا فقط، وسيظهر تلقائيًا في النظام كله.
 */
const providers: AIProviderAdapter[] = [
  new AnthropicProvider(),
  // new OpenAIProvider(),
  // new GoogleProvider(),
  // new YSDProvider(),
];

export function getConfiguredProviders(): AIProviderAdapter[] {
  return providers.filter((p) => p.isConfigured());
}

export function listAvailableModels(): ModelInfo[] {
  return getConfiguredProviders().flatMap((p) => p.listModels()).filter((m) => m.enabled);
}

export function resolveProviderForModel(modelId: string): AIProviderAdapter | null {
  for (const p of getConfiguredProviders()) {
    if (p.listModels().some((m) => m.id === modelId && m.enabled)) return p;
  }
  return null;
}
