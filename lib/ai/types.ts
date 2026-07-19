/**
 * AIProviderAdapter — الطبقة الموحدة لموفري الذكاء الاصطناعي
 *
 * أي موفر جديد (OpenAI, Google, نماذج مفتوحة، موفر YSD الخاص مستقبلًا)
 * يُضاف بتنفيذ هذه الواجهة وتسجيله في registry.ts — دون أي تعديل
 * على واجهة المحادثة أو مسار الـ API.
 */

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** معرّف النموذج كما هو مسجّل في جدول ai_models */
  modelId: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** لإلغاء الطلب من جهة العميل */
  signal?: AbortSignal;
}

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamChunk {
  /** "status" = حالة قصيرة تُعرض فورًا في الوضع المحمي (ليست جزءًا من الرد) */
  type: "text" | "usage" | "done" | "error" | "meta" | "status";
  text?: string;
  usage?: UsageReport;
  error?: string;
  /** معرّف النموذج الفعلي الذي أجاب (مع "meta") — للتسجيل والعرض في التطوير */
  model?: string;
  /** الوضع المختار (مع "meta"): بثّ عام أو محمي بالتحقق — للتسجيل الآمن */
  mode?: "general" | "protected";
  /** عدد مرات إعادة التوليد الصارمة (مع "meta") — يجب ألا يتجاوز 1 */
  regenerations?: number;
}

export interface ModelInfo {
  id: string;
  providerId: string;
  displayNameAr: string;
  displayNameEn: string;
  contextWindow: number;
  enabled: boolean;
}

export interface AIProviderAdapter {
  /** معرّف ثابت: "anthropic" | "openai" | "google" | "ysd" ... */
  readonly id: string;
  readonly displayName: string;

  /** هل مفتاح الموفر متوفر في البيئة؟ */
  isConfigured(): boolean;

  /** النماذج التي يقدّمها هذا الموفر */
  listModels(): ModelInfo[];

  /**
   * بث الرد قطعةً قطعة.
   * يجب أن يُرجع دائمًا chunk أخير من نوع "done" أو "error"،
   * ويُرجع "usage" قبل النهاية إن توفّر من الموفر.
   */
  streamChat(req: ChatRequest): AsyncGenerator<StreamChunk>;
}
