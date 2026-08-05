# إصدار v0.8.1 — خطة النشر والترتيب والتراجع

## الترقيم يطابق ترتيب التطبيق

| الملف | النوع |
|---|---|
| `0027_prepare_cost_limits.sql` | إضافية |
| `0028_chat_budget_reservations.sql` | إضافية |
| `0029_distributed_generation_slots.sql` | إضافية |
| `0030_distributed_invite_rate_limits.sql` | إضافية |
| `0031_lock_invite_rpcs.sql` | **كاسرة للتطبيق القديم** |

من يشغّل الترحيلات تصاعديًا بأسمائها يحصل على الترتيب الصحيح بلا تعليمات
جانبية. ولا يبقى إلا شرطٌ واحد **لا يحمله أي ملف**: نشر التطبيق الجديد
وضبط `RATE_LIMIT_HMAC_SECRET` **بين `0030` و`0031`**.

## لماذا `0031` أخيرًا

يسحب صلاحية `beta_invite_valid` و`beta_claim_invite` عن `anon`، والتطبيق
المنشور اليوم ينادي هاتين الدالتين بعميل الطلب. فبين لحظة تطبيقه ولحظة النشر
نافذةٌ يتعطّل فيها التسجيل بالدعوة كلّه.

و`0027`–`0030` عكسه: التطبيق الجديد يحتاجها **قبل** أن يعمل بحمايته الكاملة
(`max_output_tokens`، ودوال الحجز والمقاعد وحدّ المعدّل).

## الترتيب الإلزامي

| # | الخطوة | إن فشلت |
|---|---|---|
| **A** | تطبيق `0027` ثم `0028` ثم `0029` ثم `0030` | تراجع فوري — لا أثر على الحيّ |
| **B** | فحص التطبيق **القديم** | توقّف؛ لا تنشر |
| **C** | ضبط `RATE_LIMIT_HMAC_SECRET` في Railway | لا تنشر قبله |
| **D** | نشر التطبيق الجديد | تراجع النشر وحده |
| **E** | فحص المحادثة والدعوات والحدود | تراجع النشر؛ لا تطبّق `0031` |
| **F** | تطبيق `0031` أخيرًا | تراجع فوري (أدناه) |
| **G** | التأكد أن `anon` يحصل على `permission denied` | تراجع `0031` |

### (A) الترحيلات الإضافية

لا سحب صلاحية، ولا حذف عمود أو جدول، ولا تغيير توقيع. اختبارٌ يفرض أن `0027`
لا تحوي `revoke` إطلاقًا، كي لا تُدمج المرحلتان ثانيةً.

الأثر السلوكي الوحيد هنا: `claude-sonnet-4-6` يصير `min_tier=plus`. والتطبيق
القديم **لا يقرأ** `min_tier`، فلا يتغيّر عنده شيء.

### (B) فحص القديم

- `/api/live` = 200 · `/api/health` = 200
- `/register` ⇒ التحقق من كود دعوة صالح يعمل (`anon` ما زال مسموحًا)
- `/api/chat` برسالة قصيرة ⇒ ردّ طبيعي

### (C) `RATE_LIMIT_HMAC_SECRET`

```
openssl rand -hex 32
```

**مطلوب**: بدونه تُهشَّم عناوين IP والبريد بلا سرّ، وكلاهما منخفض العشوائية
فيُكشف من الهاش بجدول قوس قزح. و**لا يُشتقّ** من `SUPABASE_SERVICE_ROLE_KEY`:
خلط الأسرار يجعل تدوير أحدهما يكسر الآخر صامتًا — كل عدّادات الحدّ تصير
مفاتيح جديدة دفعةً واحدة فينفتح الحدّ للجميع لحظةَ التدوير — وتسريب أحدهما
يفضح الاثنين.

في الإنتاج يرمي عند غيابه. ولهذا تسبق هذه الخطوةُ النشرَ لا العكس.

### (D) النشر

`staging` fast-forward ثم مراقبة Railway حتى ظهور الإصدار.

### (E) فحص الجديد

- `/api/health` ⇒ **8 passing · 0 failing** (فحص `rate_limit_secret` جديد)
- `/api/invite/verify` و`/api/invite/claim` عبر عميل الخدمة ⇒ يعملان
- `/api/chat` ⇒ يعمل؛ ومستخدم مجاني يطلب Claude ⇒ إشعار تخفيض وردّ من `ysd/free`
- `/register` ⇒ حقل الدعوة وسلوكه كما هما

### (F) `0031`

بعد أن يثبت (E). من هنا لا يستطيع `anon` مناداة دوال الدعوة، والمسار الوحيد
هو `/api/invite/*` بعميل الخدمة.

### (G) التأكيد

- `anon` → `beta_invite_valid` ⇒ `permission denied` (مقيس عبر REST)
- `/register` ⇒ التحقق من الدعوة يعمل (عبر الخادم الآن)
- صفر 500

## التراجع

| الترحيل | التراجع | فقد بيانات |
|---|---|---|
| `0031` | `grant execute on function public.beta_invite_valid(text) to anon, authenticated;`<br>`grant execute on function public.beta_claim_invite(text, text, integer) to anon, authenticated;` | لا |
| `0030` | `drop function public.consume_invite_rate_limit(text,text,int,int); drop table public.invite_rate_limits;` | عدّادات مؤقتة |
| `0029` | `drop function public.acquire_generation_slot(uuid,text,int); drop function public.release_generation_slot(uuid,text); drop table public.generation_slots;` | مقاعد جارية |
| `0028` | `drop function public.reserve_chat_budget(uuid,text,int,int); drop function public.finalize_chat_budget(text,int,int); drop function public.release_chat_budget(text); drop table public.chat_budget_reservations;` | حجوزات جارية |
| `0027` | `update public.ai_models set min_tier='free' where id='claude-sonnet-4-6';`<br>(العمود يمكن إبقاؤه — لا يضرّ) | لا |

**التطبيق يحتمل غياب `0028`–`0030`**: كل نداء يفحص رمز «الدالة غير موجودة»
(`42883`/`42P01`) ويسقط إلى مسار احتياطي مع رمز صريح في السجل. فالتراجع عنها
لا يُسقط المسار — يُضعف الحماية فقط، ولا ندّعي غير ذلك.

الاستثناء المقصود: `reserve_chat_budget` **يمنع عند العطل لا يسمح** — الحدّ
الذي ينفتح عند العطل ليس حدًّا. غياب الترحيل وحده يُمرَّر (كي لا ينكسر
الإنتاج بين النشر والتطبيق)؛ أمّا عطل القاعدة الحقيقي فيُردّ رفضًا.

## التراجع الكامل للنشر

`staging` إلى `bffa4b55bdf8e2d0426d020d1f33c9f4146a0fa5` — آخر حالة معتمدة
قبل v0.8.1.

## `supabase db push` — لا تُستعمل حاليًا

سجلّ الترحيلات البعيد لم يُزامَن كاملًا مع أسماء ملفات المشروع، فقد يعيد
`db push` تطبيق ما طُبِّق أو يتخطّى ما لم يُطبَّق. التطبيق يدويًا في SQL
Editor بالترتيب أعلاه، ملفًا ملفًا.

## متغيّرات البيئة

| المتغيّر | الحالة | ملاحظة |
|---|---|---|
| `RATE_LIMIT_HMAC_SECRET` | **مطلوب** | 32 بايتًا على الأقل · يُضبط في الخطوة (C) |
| `YSD_TRUSTED_PROXY_HOPS` | اختياري (`1`) | يخصّ `x-forwarded-for` وحدها حين تغيب `x-real-ip` |

## حدود الإخراج المعتمدة

| الخطة | `max_output_tokens` |
|---|---|
| free | 1024 |
| plus | 4096 |
| pro | 8192 |
| business | 8192 |

تُعدَّل من `usage_limits` بلا نشر.
