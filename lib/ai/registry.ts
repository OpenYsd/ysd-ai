import type { AIProviderAdapter, ModelInfo } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenRouterProvider } from "./openrouter";

/**
 * سجل الموفرين — نقطة الإضافة الوحيدة لأي موفر جديد.
 * أضف الموفر هنا فقط، وسيظهر تلقائيًا في النظام كله.
 * الترتيب يحدد الافتراضي: OpenRouter (مجاني) أولًا الآن،
 * وAnthropic يبقى متاحًا عند توفر الرصيد.
 */
const providers: AIProviderAdapter[] = [
  new OpenRouterProvider(),
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

/** خيارات النماذج للواجهة: النموذج + اسم موفره — بترتيب الموفرين */
export interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
  provider: string;
}

export function listModelOptions(): ModelOption[] {
  return getConfiguredProviders().flatMap((p) =>
    p
      .listModels()
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        nameAr: m.displayNameAr,
        nameEn: m.displayNameEn,
        provider: p.displayName,
      })),
  );
}

export function resolveProviderForModel(modelId: string): AIProviderAdapter | null {
  for (const p of getConfiguredProviders()) {
    if (p.listModels().some((m) => m.id === modelId && m.enabled)) return p;
  }
  return null;
}
