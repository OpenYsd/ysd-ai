# إضافة موفر ذكاء اصطناعي جديد

النظام غير مرتبط بأي موفر واحد. الإضافة في خطوتين فقط:

## 1. نفّذ الواجهة

أنشئ `lib/ai/openai.ts` (مثالًا):

```typescript
import type { AIProviderAdapter, ChatRequest, ModelInfo, StreamChunk } from "./types";

export class OpenAIProvider implements AIProviderAdapter {
  readonly id = "openai";
  readonly displayName = "OpenAI";

  isConfigured() { return Boolean(process.env.OPENAI_API_KEY); }

  listModels(): ModelInfo[] { /* ... */ }

  async *streamChat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    // استدعِ API الموفر وأصدر chunks:
    // { type: "text", text }   أثناء البث
    // { type: "usage", usage } عند توفر الاستهلاك
    // { type: "done" }         في النهاية
    // { type: "error", error } عند الفشل (رسالة عامة، التفاصيل للسجلات)
  }
}
```

## 2. سجّله

في `lib/ai/registry.ts`:

```typescript
const providers: AIProviderAdapter[] = [
  new AnthropicProvider(),
  new OpenAIProvider(),   // ← فقط هذا السطر
];
```

## 3. أضف النموذج لقاعدة البيانات

```sql
insert into ai_providers (id, display_name) values ('openai', 'OpenAI');
insert into ai_models (id, provider_id, display_name_ar, display_name_en)
values ('gpt-4o', 'openai', 'YSD متوازن', 'YSD Balanced');
```

## القواعد

- المفتاح من متغيرات البيئة فقط — لا يُكتب في الكود ولا يصل للمتصفح.
- رسائل الأخطاء للمستخدم عامة؛ التفاصيل في السجلات.
- تعطيل نموذج = `enabled = false` في جدول `ai_models` (من لوحة الإدارة).
