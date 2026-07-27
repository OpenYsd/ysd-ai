# النشر على Railway — YSD AI

دليل تشغيلي لخدمة ويب دائمة. الإعداد البرمجي في [`railway.json`](../railway.json)،
وهذا الملف لما تفعله أنت من اللوحة.

---

## 1) المشروع والجذر

| الحقل | القيمة |
|---|---|
| **Root Directory** | `ysd-ai-starter/ysd-ai` |
| Builder | Dockerfile (مضبوط في `railway.json`) |
| Dockerfile Path | `Dockerfile` |

> المستودع فيه مجلد أعلى؛ بلا ضبط الجذر يبني Railway المكان الخطأ.

## 2) المتغيرات — أسماء فقط، لا تضع القيم هنا

### وقت البناء (Build Variables)
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_APP_NAME          (اختياري)
NEXT_PUBLIC_DEFAULT_LOCALE    (اختياري)
```

> ⚠️ **`NEXT_PUBLIC_*` متغيرات وقت بناء**: تُحقَن في حزمة المتصفح أثناء البناء.
> **أي تغيير فيها يتطلب إعادة بناء** — لا يكفي تعديلها في متغيرات التشغيل.
> وهي عامة بطبيعتها (تصل كل زائر)، والمفتاح anon محكوم بـRLS.

### وقت التشغيل (Service Variables)
```
NEXT_PUBLIC_SUPABASE_URL        ← نعم، مرة ثانية
NEXT_PUBLIC_SUPABASE_ANON_KEY   ← نعم، مرة ثانية
OPENROUTER_API_KEY              ← سرّ
SUPABASE_SERVICE_ROLE_KEY       ← سرّ (اختياري)
ANTHROPIC_API_KEY               ← سرّ (اختياري)
YSD_STRICT_ENV=1
YSD_LOW_MEMORY=1
YSD_APP_URL                     ← نطاقك النهائي
```

**لماذا `NEXT_PUBLIC_*` مرتين؟** `lib/env.ts` يقرأ `process.env[name]` ديناميكيًا،
وNext.js لا يحقن إلا الوصول الساكن. بدونها وقت التشغيل يفشل `checkEnv`، ومع
`YSD_STRICT_ENV=1` يُرفض الإقلاع وترد كل المسارات 500.

### ❌ لا تضف `PORT`
Railway يحقنه، والتطبيق يقرأ `process.env.PORT` (`HOSTNAME=0.0.0.0` مضبوط في
الصورة). تثبيته يدويًا يكسر التوجيه.

### 🔒 الأسرار
`OPENROUTER_API_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `ANTHROPIC_API_KEY`
**أسرار تشغيل فقط** — ليست build args ولا `NEXT_PUBLIC_*`. وسمها Secret.
`SUPABASE_SERVICE_ROLE_KEY` **لا يصل المتصفح إطلاقًا**: `lib/supabase/admin.ts`
محروس بـ`import "server-only"` فاستيراده من مكوّن عميل خطأ بناء.

## 3) فحص الصحة

| الحقل | القيمة |
|---|---|
| Health Check Path | **`/api/live`** |
| Timeout | **300** |

**لماذا `/api/live` لا `/api/health`؟** `/api/health` فحص **readiness** يرد 503
حين تتعثّر خدمة خارجية (رُصد انقطاع استمر 345 ثانية والتطبيق سليم). لو رُبط به
فحص المنصّة لأعادت تشغيل خادم سليم — وإعادة التشغيل لا تُصلح خدمة خارجية.

`/api/live` **liveness خالص**: لا يلمس Supabase ولا OpenRouter ولا التخزين ولا
نموذج Embeddings، ويرد `{"status":"ok","version":"…"}` ما دامت العملية حية.

للمراقبة: `/api/health` (ملخّص عام) و`/api/admin/health` (تفصيل إداري).

## 4) الموارد المبدئية

| المورد | القيمة |
|---|---|
| RAM | **2GB** |
| vCPU | **2** |
| Replicas | **1** |
| متغيّر | `YSD_LOW_MEMORY=1` |

من قياس فعلي: خامل ~150MB · ذروة RAG 677–694MB · أسوأ حالة 1.9GB (5 ملفات
متزامنة). **1GB لا يكفي** — أول تزامن يعني OOM-kill.

> **نسخة واحدة مبدئيًا**: `lib/rate-limit.ts` في ذاكرة العملية، فمع نسختين
> يصير الحد الفعلي ضعف المقصود. رفع العدد ينتظر حدًّا مدعومًا بمخزن مشترك.

## 5) النطاق المؤقت ثم المخصص

1. **Settings → Networking → Generate Domain** — نطاق `*.up.railway.app` فوري.
2. اختبر عليه: `/api/live` ثم تسجيل الدخول ثم محادثة (تأكد أن النص يصل **تدريجيًا**
   لا دفعة واحدة — البثّ محميّ بـ`X-Accel-Buffering: no`).
3. **Custom Domain** → أدخل نطاقك → خذ هدف CNAME.
4. في Cloudflare: سجل `CNAME` → الهدف · **SSL/TLS = Full (strict)** (لا Flexible:
   تسبب حلقات إعادة توجيه) · **عطّل Rocket Loader وAuto Minify**.
5. ابدأ **DNS only (grey cloud)** وتأكد من عمل SSE، ثم فعّل الوكيل وأعد الاختبار.

> ⏱️ الوكلاء يقطعون قرب 100 ثانية. التطبيق ينهي الطلب بنفسه عند **110 ثانية**
> برسالة عربية واضحة — ومهلة الخمول 25 ثانية بلا بيانات، وميزانية السلسلة 45.

## 6) نموذج Embeddings — بلا Volume

النموذج (~112MB) **مخبوز في الصورة** وقت البناء (`npm run embeddings:prefetch`)
في `/app/.model-cache`، ويقرؤه التشغيل من `YSD_MODEL_CACHE`.

- ✅ أول طلب RAG **لا ينزّل شيئًا** من الإنترنت.
- ❌ **لا تستخدم Railway Volume** له: يقيّد الخدمة بنسخة واحدة بلا داعٍ، والصورة
  تحمله أصلًا.
- ❌ **لا تُخزَّن ملفات المستخدمين في الصورة** — كلها في Supabase Storage.
- البناء **يفشل صراحةً** إن لم يكتمل التنزيل، بدل صورة ناقصة صامتة.

## 7) Production و Staging

خدمتان منفصلتان، وكل واحدة على **مشروع Supabase مستقل**.

> ⚠️ **لا تشارك Production وStaging مشروع Supabase واحدًا.** اختبارات E2E تنشئ
> حسابات ومحادثات وتحذف بيانات — على قاعدة الإنتاج تعني فقدان بيانات مستخدمين.

| | Production | Staging |
|---|---|---|
| المصدر | tag `v0.x.y` | فرع `master` |
| Supabase | مشروع الإنتاج | مشروع منفصل بنفس الترحيلات |
| الموارد | 2GB / 2 vCPU | أقل |

## 8) الرجوع (Rollback)

**الأسرع:** Deployments → اختر النشر السابق → **Redeploy**. ثوانٍ، بلا بناء.

**الأضمن:** اربط الخدمة بـ**tag** لا فرع، فالنشر حتمي:
```
v0.6.6   ← آخر إصدار مستقر (release commit 5395502)
```

> الصور المحلية (`ysd-ai:0.6.6` وغيرها) **ليست في أي سجل** — Railway يبني من
> المصدر، فالصورة الناتجة معرّفها مختلف وإن كان الكود مطابقًا. للحصول على
> «الصورة نفسها بالضبط» يلزم دفعها إلى سجل (GHCR مثلًا) والنشر منه.

## 9) قبل أول نشر — قائمة تحقق

- [ ] ترحيلات `0017` و`0018` مطبَّقة على قاعدة **الإنتاج**
      (انظر [`V0.6.6_DATABASE_GATE.md`](V0.6.6_DATABASE_GATE.md))
- [ ] Root Directory = `ysd-ai-starter/ysd-ai`
- [ ] متغيرات البناء والتشغيل مضبوطة، وبلا `PORT`
- [ ] Health Check Path = `/api/live` · Timeout = 300
- [ ] 2GB / 2 vCPU / نسخة واحدة
- [ ] Staging على مشروع Supabase منفصل
- [ ] تحقّق من البثّ على النطاق المؤقت قبل ربط النطاق المخصص
