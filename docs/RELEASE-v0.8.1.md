# إصدار v0.8.1 — خطة النشر والترتيب والتراجع

## لماذا الترتيب مهم

ترحيلٌ واحد في هذه الحزمة **يكسر التطبيق الحيّ**: `0028` يسحب صلاحية
`beta_invite_valid` و`beta_claim_invite` عن `anon`، والتطبيق المنشور اليوم
ينادي هاتين الدالتين بعميل الطلب (anon). فبين لحظة تطبيقه ولحظة النشر نافذةٌ
يتعطّل فيها التسجيل بالدعوة كلّه.

وترحيلٌ آخر **يلزم قبل النشر**: التطبيق الجديد يقرأ
`usage_limits.max_output_tokens` وينادي دوال الحجز والمقاعد وحدّ المعدّل. لو
نُشر قبل تطبيقها لسقط إلى مسارات احتياطية (وهي موجودة عمدًا) لكنه يعمل بحماية
أضعف.

> **الترتيب العددي ليس ترتيب التطبيق.** `0028` تُطبَّق **أخيرًا**، بعد `0029`
> و`0030` و`0031` وبعد أن يصير الفرع حيًّا. الرقم يحفظ الاسم المتفق عليه لا
> الجدول الزمني.

## الترتيب الإلزامي

| # | الخطوة | النوع | إن فشلت |
|---|--------|-------|---------|
| **أ** | تطبيق `0027` + `0029` + `0030` + `0031` | إضافية بحتة | تراجع فوري (أدناه) — لا أثر على الحيّ |
| **ب** | التأكد أن التطبيق **القديم** ما زال يعمل | فحص | توقّف؛ لا تنشر |
| **ج** | نشر الفرع (`staging` → Railway) | نشر | تراجع النشر وحده |
| **د** | فحص `/api/chat` ومسارات الدعوة | فحص | تراجع النشر؛ لا تطبّق `0028` |
| **هـ** | تطبيق `0028` | **كاسرة للقديم** | تراجع فوري (أدناه) |
| **و** | إعادة الفحص | فحص | تراجع `0028` أولًا |

### (أ) التطبيق الإضافي

```
0027_prepare_cost_limits.sql
0029_chat_budget_reservations.sql
0030_generation_slots.sql
0031_invite_rate_limits.sql
```

كلها **إضافية**: لا سحب صلاحية، ولا حذف عمود أو جدول، ولا تغيير توقيع.
اختبارٌ يفرض ذلك (`0027 لا تسحب أي صلاحية`) كي لا تُدمج المرحلتان ثانيةً.

الأثر السلوكي الوحيد في هذه الخطوة: `claude-sonnet-4-6` يصير `min_tier=plus`.
والتطبيق القديم **لا يقرأ** `min_tier` إطلاقًا، فلا يتغيّر شيء عنده.

### (ب) التحقق أن القديم يعمل

- `/api/live` = 200 · `/api/health` = 200 · 7 passing
- `/register` → التحقق من كود دعوة صالح ما زال يعمل (`beta_invite_valid` عبر anon)
- `/api/chat` برسالة قصيرة ⇒ ردّ طبيعي

### (ج) النشر

`staging` fast-forward ثم مراقبة Railway حتى ظهور الإصدار.

### (د) فحص الجديد

- `/api/invite/verify` و`/api/invite/claim` عبر عميل الخدمة ⇒ يعملان
- `/api/chat` ⇒ يعمل، ومستخدم مجاني يطلب Claude ⇒ إشعار تخفيض + ردّ من `ysd/free`
- `/register` ⇒ حقل الدعوة وسلوكه كما هما

### (هـ) `0028`

بعد أن يثبت (د). من هنا لا يستطيع `anon` مناداة دوال الدعوة، والمسار الوحيد
هو `/api/invite/*` بعميل الخدمة.

### (و) إعادة الفحص

- `anon` → `beta_invite_valid` ⇒ `permission denied` (مقيس عبر REST)
- `/register` ⇒ التحقق من الدعوة يعمل (عبر الخادم الآن)
- صفر 500

## التراجع

| الترحيل | التراجع | فقد بيانات |
|---|---|---|
| `0028` | `grant execute on function public.beta_invite_valid(text) to anon, authenticated;`<br>`grant execute on function public.beta_claim_invite(text, text, integer) to anon, authenticated;` | لا |
| `0031` | `drop function public.consume_invite_rate_limit(text,text,int,int); drop table public.invite_rate_limits;` | عدّادات مؤقتة فقط |
| `0030` | `drop function public.acquire_generation_slot(uuid,text,int); drop function public.release_generation_slot(uuid,text); drop table public.generation_slots;` | مقاعد جارية فقط |
| `0029` | `drop function public.reserve_chat_budget(uuid,text,int,int); drop function public.finalize_chat_budget(text,int,int); drop function public.release_chat_budget(text); drop table public.chat_budget_reservations;` | حجوزات جارية فقط |
| `0027` | `update public.ai_models set min_tier='free' where id='claude-sonnet-4-6';`<br>(العمود يمكن إبقاؤه — لا يضرّ) | لا |

**التطبيق يحتمل غياب `0029`–`0031`**: كل نداء يفحص رمز «الدالة غير موجودة»
(`42883`/`42P01`) ويسقط إلى مسار احتياطي مع رمز صريح في السجل. فالتراجع عنها
لا يُسقط المسار — يُضعف الحماية فقط، ولا ندّعي غير ذلك.

الاستثناء: `reserve_chat_budget` **يمنع عند العطل لا يسمح** — الحدّ الذي ينفتح
عند العطل ليس حدًّا. غياب الترحيل وحده يُمرَّر (كي لا ينكسر الإنتاج بين النشر
والتطبيق)؛ أمّا عطل القاعدة الحقيقي فيُردّ رفضًا.

## التراجع الكامل للنشر

`staging` إلى `bffa4b55bdf8e2d0426d020d1f33c9f4146a0fa5` — آخر حالة معتمدة
قبل v0.8.1.

## متغيّرات بيئة اختيارية

| المتغيّر | الافتراضي | متى يُضبط |
|---|---|---|
| `YSD_TRUSTED_PROXY_HOPS` | `1` | إن صار أمام Railway وكيلٌ آخر (Cloudflare ⇒ `2`) |
| `YSD_RATE_LIMIT_SECRET` | مشتقّ من `SUPABASE_SERVICE_ROLE_KEY` | لفصل مفتاح HMAC عن مفتاح الخدمة |

لا شيء منهما إلزامي: الافتراضان صحيحان للبنية الحالية.
