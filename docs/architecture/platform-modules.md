# وحدات منصّة YSD — الحدود المعمارية

المصدر البرمجي: `lib/platform/modules.ts`. التنقل يُبنى منه وحده، ولا يظهر فيه إلا ما يعمل.

| الوحدة | الحالة | المسارات | ما تملكه الآن | العقود المشتركة |
|---|---|---|---|---|
| Chat | متاحة | `/chat`, `/chat/[id]` | `components/chat/*`، `lib/chat/*`، `app/api/chat` | منتقي النموذج عبر `lib/models/contracts.ts` |
| Projects | متاحة | `/projects`, `/projects/[id]` | `components/projects/*`، `app/api/projects` | محادثات المشروع وملفاته من Chat وLibrary |
| Library | متاحة | `/files` | `components/files/*`، `lib/files/*`، `lib/rag/*` | الاسترجاع (RAG) يخدم Chat وProjects |
| Settings | متاحة | `/settings` | `components/settings/*`، `lib/ui-preferences.ts` | الثيم والسطوع (`components/theme.tsx`) |
| Models | خادمية فقط | — | `lib/models/*` فوق `lib/ai/*` | `ModelDescriptor`، `PickerModel`، `orderForPicker` |
| Code | مخطَّطة | — | — | — |
| Extensions | مخطَّطة | — | — | — |
| Automations | مخطَّطة | — | — | — |

## القواعد

- **لا وحدة مخطَّطة في الواجهة.** تبقى `status: "planned"` بلا `href` حتى تُبنى صفحتها فعلًا.
- **المشاريع ليست «Work».** هي اليوم مجلّداتٌ تجمع محادثاتٍ وملفات. لا تُسمّى «العمل» ولا يظهر مبدّل Chat/Work حتى يوجد فعلًا مساعدٌ ينفّذ مهامّ.
- **الهيكل:** شريط أيقونات ضيّق (أسماء مسموعة لا نصوص مرئية) + لوحة سياق تتبع الوحدة: المحادثات والمشاريع في Chat وProjects، وبحث الإعدادات وأقسامها في Settings، ولا لوحة في Library. الحساب والاستهلاك والإدارة والخروج في قائمة الصورة الرمزية.
- **الهيكل** (`components/shell/*`) يعرض الوحدات ولا يعرف منطقها. ولا تستورد وحدةٌ مكوّنات وحدةٍ أخرى إلا عبر عقدٍ معلن.
- **النماذج:** الواجهات لا تبني قوائم النماذج بنفسها. الخادم يستدعي `listModelsForUser` من `lib/models/gateway.ts`، وهي طبقة رقيقة فوق `lib/ai/registry.ts`.
  - البوابة لا تفترض أسماء نماذج YSD ولا عناوينها. أي نموذج جديد يُضاف كمزوّد في `lib/ai/registry.ts`، فيظهر عبرها بعد التحقّق من تهيئته وتفعيله.
  - المدخلات والمخرجات من إعلان المزوّد (`inputModalities` / `outputModalities`). غيابها = نصّ فقط.
- **لا قاعدة بيانات لوحدةٍ قبل أن تحتاجها ميزة فعلية.**
- **أي تنفيذ للأوامر أو تحكّم بالمتصفح أو Git** (Code / Automations) يأتي في مرحلة لاحقة، بصلاحيات محدودة وعزل وسجلّ عمليات. لا وصول كامل افتراضيًا.
