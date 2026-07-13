# YSD AI — منصة الذكاء العربي

منصة ذكاء اصطناعي احترافية من **YSD AI Studio**. عربية أولًا (RTL) مع دعم الإنجليزية، مبنية على بنية Modular قابلة للتوسع.

## التقنيات

| الطبقة | التقنية |
|---|---|
| الواجهة | Next.js App Router · TypeScript Strict · Tailwind CSS |
| قاعدة البيانات والمصادقة | Supabase (PostgreSQL · Auth · Storage · RLS) |
| الذكاء الاصطناعي | طبقة `AIProviderAdapter` موحدة — Anthropic أولًا، جاهزة لأي موفر |
| التحقق | Zod · React Hook Form |
| الاختبارات | Vitest · Playwright |

## التشغيل المحلي

```bash
# 1. تثبيت الاعتماديات
npm install

# 2. إعداد البيئة
cp .env.example .env
# املأ مفاتيح Supabase وANTHROPIC_API_KEY

# 3. إعداد Supabase
#    - أنشئ مشروعًا على supabase.com
#    - ثبّت Supabase CLI ثم:
supabase link --project-ref YOUR_PROJECT_REF
supabase db push          # يشغّل migrations من supabase/migrations/

# 4. التشغيل
npm run dev
```

## الفحص قبل أي Commit

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

> ⚠️ **لا تشغّل `npm run build` أثناء عمل `npm run dev`** — كلاهما يكتب في `.next` نفسه،
> وسيؤدي ذلك إلى صفحات بلا CSS (روابط أصول قديمة ترجع 404).
> إن حدث ذلك: أوقف الخادم، احذف `.next`، ثم شغّل `npm run dev` من جديد.
> اختبار `tests/styling-e2e.test.ts` (مع `YSD_E2E=1`) يكتشف هذه الحالة آليًا.

## بنية المشروع

```
app/
  api/chat/route.ts        مسار المحادثة الآمن (Streaming · Rate limit · Usage)
  (auth)/login/            صفحات المصادقة
  (app)/chat/              واجهة المحادثة (قيد البناء — انظر النموذج الأولي)
lib/
  ai/                      AIProviderAdapter + الموفرون + السجل
  supabase/                عملاء الخادم والمتصفح
  validation/              مخططات Zod
supabase/migrations/       مخطط قاعدة البيانات + RLS
docs/                      خارطة الطريق والتوثيق
middleware.ts              حماية الجلسات والصفحات ولوحة الإدارة
```

## إضافة موفر ذكاء اصطناعي جديد

انظر `docs/ADDING_A_PROVIDER.md` — باختصار: نفّذ واجهة `AIProviderAdapter` وسجّله في `lib/ai/registry.ts`. لا حاجة لتعديل أي شيء آخر.

## الميزات — v0.1.1

**جديد في v0.1.1:**
- موفر OpenRouter مجاني افتراضي (Allowlist نماذج مُتحقق منها بالعربية — لا موجّه عشوائي)
- Language Guard: منع الردود مختلطة اللغات مع إعادة محاولة بنموذج احتياطي
- تسجيل النموذج الفعلي لكل رد (messages/usage_events) وعرضه في وضع التطوير
- حد يومي للرسائل حسب الباقة (free: 50/يوم) — migrations 0003 و0004
- نظام المشاريع الكامل: تعليمات خاصة تدخل موجه النظام، ربط المحادثات، بحث وفرز

**مكتمل ومُختبر (38/38 اختبار Runtime + E2E تنسيق):**
- المصادقة الكاملة: تسجيل، دخول/خروج، استعادة كلمة المرور، جلسات مستمرة، حماية صفحات
- واجهة المحادثة: بث SSE، إيقاف التوليد، إعادة توليد، تعديل رسالة المستخدم، Markdown + كتل كود مع نسخ، اختيار النموذج
- المحادثات محفوظة في قاعدة البيانات: إنشاء، عنوان تلقائي، إعادة تسمية، حذف ناعم، بحث
- الهيكل: شريط جانبي قابل للطي، متجاوب للجوال، داكن/فاتح، عربي RTL / إنجليزي LTR
- الحساب والاستهلاك: عدادات شهرية حقيقية (رسائل + Tokens) مقابل حدود الباقة
- الإعدادات: المظهر، اللغة، النموذج الافتراضي
- الأمان: RLS مُختبر بين مستخدمين، منع IDOR على مستوى الخادم، Rate limiting، أخطاء الموفر برسائل عربية دون تسريب أسرار

**التالي (انظر docs/YSD_AI_ROADMAP.md):**
- المشاريع (قيد التنفيذ) · رفع الملفات · لوحة الإدارة · صفحة الباقات
