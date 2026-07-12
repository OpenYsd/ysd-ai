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

## الميزات

**مكتمل في هذا الهيكل:**
- بنية المشروع وطبقة الموفرين الموحدة
- مخطط قاعدة البيانات الكامل مع RLS (16 جدولًا)
- مسار محادثة آمن: مصادقة، تحقق مدخلات، Rate limiting، حدود استهلاك، Streaming SSE، تسجيل Tokens
- الوسيط الأمني: حماية الصفحات + منع وصول غير المشرفين للوحة الإدارة
- صفحة دخول أولية

**التالي (انظر docs/YSD_AI_ROADMAP.md):**
- واجهة المحادثة الكاملة (النموذج الأولي جاهز كمرجع للتصميم)
- التسجيل ونسيان كلمة المرور وتأكيد البريد
- رفع الملفات واستخراج النصوص
- المشاريع · لوحة الإدارة · صفحة الباقات
