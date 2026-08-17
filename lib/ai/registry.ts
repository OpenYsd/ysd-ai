import type { AIProviderAdapter, ModelInfo } from "./types";
import { AnthropicProvider } from "./anthropic";
import { NineRouterProvider } from "./nine-router";
import { OpenRouterProvider } from "./openrouter";
import { GroqProvider } from "./groq";
import { YSDProvider } from "./ysd";

/**
 * سجل الموفرين — نقطة الإضافة الوحيدة لأي موفر جديد.
 * أضف الموفر هنا فقط، وسيظهر تلقائيًا في النظام كله.
 * الترتيب يحدد الافتراضي: OpenRouter (مجاني) أولًا الآن،
 * وAnthropic يبقى متاحًا عند توفر الرصيد.
 */
const providers: AIProviderAdapter[] = [
  new OpenRouterProvider(),
  new AnthropicProvider(),
  /**
   * v0.8.0: 9Router — متوافق مع OpenAI، **مغلق افتراضيًا**.
   * `isConfigured()` يرد false بلا NINE_ROUTER_ENABLED=1، وgetConfiguredProviders
   * يرشّحه، فوجوده هنا لا يغيّر سلوك الإنتاج القائم بشيء.
   */
  new NineRouterProvider(),
  /**
   * v0.9.0: Groq — **احتياط فقط**. مُهيّأ متى وُجد `GROQ_API_KEY`، ومخفيّ
   * دائمًا عن قائمة المستخدم بـ`userSelectable = false`.
   */
  new GroqProvider(),
  /**
   * v0.9.3: YSD — نموذج المنصّة، **خامل بالكامل**.
   *
   * `isConfigured()` يرد false بلا `YSD_PROVIDER_ENABLED=1`، فيرشّحه
   * `getConfiguredProviders` قبل أن يصل إليه شيء. ونموذجه `enabled: false`
   * فوق ذلك. فوجوده هنا لا يغيّر سلوك الإنتاج بحرف.
   *
   * وموضعه **آخر** القائمة مقصود: الترتيب يحدّد الافتراضي، ووضعه قبل
   * OpenRouter كان سيغيّر المزوّد الافتراضي لحظة تهيئته.
   */
  new YSDProvider(),
  // new OpenAIProvider(),
  // new GoogleProvider(),
];

export function getConfiguredProviders(): AIProviderAdapter[] {
  return providers.filter((p) => p.isConfigured());
}

/** المزوّدون الذين يجوز للمستخدم اختيار نماذجهم — الاحتياطيون مستثنون */
function getSelectableProviders(): AIProviderAdapter[] {
  return getConfiguredProviders().filter((p) => p.userSelectable !== false);
}

/**
 * المزوّد الاحتياطي: يُستدعى من المسار بعد فشل سلسلة المزوّد الأساسي.
 *
 * يتخطّى `getSelectableProviders` عمدًا — فالإخفاء عن المستخدم لا يعني
 * التعطيل. وغيابه (بلا مفتاح) يعني احتياطًا معطّلًا بلا أي فشل إقلاع.
 */
export function getFallbackProvider(): AIProviderAdapter | null {
  return providers.find((p) => p.userSelectable === false && p.isConfigured()) ?? null;
}

export function listAvailableModels(): ModelInfo[] {
  return getSelectableProviders().flatMap((p) => p.listModels()).filter((m) => m.enabled);
}

/** خيارات النماذج للواجهة: النموذج + اسم موفره — بترتيب الموفرين */
export interface ModelOption {
  id: string;
  nameAr: string;
  nameEn: string;
  provider: string;
  /**
   * هل النموذج متاح الآن؟ (v0.8.0) القائمة تُبنى من `getConfiguredProviders`
   * فكل ما يصلها مهيّأ — لكن الحقل صريح كي لا تخمّن الواجهة، ويصير للقائمة
   * وللمسار /api/models **مصدر واحد** لا مصدران يتباعدان.
   */
  available: boolean;
  /** رمز المزوّد الداخلي الآمن — لا عنوان ولا مفتاح */
  providerId: string;
}

export function listModelOptions(): ModelOption[] {
  return getSelectableProviders().flatMap((p) =>
    p
      .listModels()
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        nameAr: m.displayNameAr,
        nameEn: m.displayNameEn,
        provider: p.displayName,
        providerId: p.id,
        available: true,
      })),
  );
}

export function resolveProviderForModel(modelId: string): AIProviderAdapter | null {
  // المزوّد الاحتياطي غير قابل للتوجيه المباشر — لا يصله طلب باختيار المستخدم
  for (const p of getSelectableProviders()) {
    if (p.listModels().some((m) => m.id === modelId && m.enabled)) return p;
  }
  return null;
}
