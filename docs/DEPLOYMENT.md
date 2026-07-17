# دليل نشر YSD AI

## المعمارية باختصار

- **قاعدة البيانات (Supabase/PostgreSQL) هي مصدر الحقيقة** للجلسات والبيانات وطابور
  RAG (`rag_jobs`) والأقفال والمحاولات. لا حالة حرجة في ذاكرة الخادم.
- **معالجة RAG حاليًا request-driven**: الطلب المُصادَق يُدرج وظيفة ثم يصرّفها عبر جلسته
  (RLS نافذ). لا يوجد عامل خلفي دائم مُفعّل.
- **العامل المستقل غير مُفعّل**. تشغيله عبر كل المستخدمين يتطلب `service role` آمنًا على
  الخادم (تجاوز RLS) + دالة التقاط إدارية — غير مُضاف بانتظار قرار.
- **نموذج Embeddings محلي** (`Xenova/multilingual-e5-small`, 384 بُعد) يعمل داخل عملية
  الخادم، **نسخة واحدة فقط**، **تزامن = 1** (تسلسلي، يحمي الذاكرة).

## متغيرات البيئة

المطلوبة (يُرفض بدء التشغيل الصارم بدونها — انظر `YSD_STRICT_ENV`):

| المتغير | الغرض |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | رابط مشروع Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | المفتاح العام anon |
| `OPENROUTER_API_KEY` | الموفر الافتراضي المجاني |

الاختيارية:

| المتغير | الغرض |
|---|---|
| `ANTHROPIC_API_KEY` | موفر Anthropic (عند توفر رصيد) |
| `SUPABASE_SERVICE_ROLE_KEY` | **للعامل المستقل فقط** — غير مطلوب في request-driven. **لا يُوضع في أي `NEXT_PUBLIC_*` ولا يصل المتصفح** |
| `YSD_LOW_MEMORY` | `1` لوضع الذاكرة المنخفضة (تقليل المقاطع/الدفعة) |
| `YSD_STRICT_ENV` | `1` لإيقاف بدء التشغيل عند نقص متغير (إنتاج) |

الفحص عند الإقلاع في `instrumentation.ts` (أسماء فقط، **لا تُطبع القيم**).

## النشر بالحاويات (Docker)

الصورة تُشغّل **خادم Node دائمًا** (`npm start`) — لا serverless (انظر القسم أدناه).

```bash
# البناء — NEXT_PUBLIC_* تُحقَن في حزمة المتصفح وقت البناء فلا مفرّ من تمريرها هنا
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  -t ysd-ai:0.6.1 .

# التشغيل — NEXT_PUBLIC_* تلزم هنا أيضًا (انظر الجدول)، والأسرار الخادمية runtime فقط
docker run -d --name ysd-ai -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=... \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  -e OPENROUTER_API_KEY=... \
  -e YSD_STRICT_ENV=1 \
  ysd-ai:0.6.1
```

### قاعدة الأسرار

| النوع | متى | لماذا |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **build arg + runtime** | مرّتان. **build**: تُحقَن في حزمة المتصفح. **runtime**: `lib/env.ts` يقرأ `process.env[name]` **ديناميكيًا**، وNext.js لا يحقن إلا الوصول الساكن — فبدونها يفشل `checkEnv`، ومع `YSD_STRICT_ENV=1` يُرفض الإقلاع وترد كل المسارات **500**. **عامة بطبيعتها**: تصل كل زائر أصلًا، والمفتاح anon محكوم بـRLS. |
| `OPENROUTER_API_KEY` · `ANTHROPIC_API_KEY` | **runtime فقط** (`-e` أو secrets المنصة) | أسرار خادمية. **لا تمرّرها كـbuild-arg إطلاقًا**: تبقى في تاريخ الطبقات ويكشفها `docker history`. |
| `SUPABASE_SERVICE_ROLE_KEY` | **لا يُمرَّر** | لعامل RAG المستقل فقط (غير مُفعّل). المعالجة request-driven لا تحتاجه. |

`.dockerignore` يُخرج `.env*` و`scripts/.qa-*` و`.git` من **سياق البناء نفسه** — فلا يمكن أن تتسرّب ولو بـ`COPY . .`. القالب: [`.env.docker.example`](../.env.docker.example) (أسماء فقط).

### تفاصيل الصورة

- **4 مراحل**: اعتماديات → بناء → اعتماديات إنتاج (`--omit=dev`) → تشغيل. طبقة التشغيل
  لا تحوي devDependencies ولا الكود المصدري ولا الاختبارات.
- **مستخدم غير جذر** (`USER node`).
- **`YSD_LOW_MEMORY=1`** مضبوط في الصورة (قالب النشر المبدئي) — يقلّل بصمة نموذج
  Embeddings المحلي. أزِله على خادم بذاكرة أوسع.
- **البناء يفشل مبكرًا** برسالة واضحة إن نقص أي `NEXT_PUBLIC_*` — بدل صورة تُبنى بنجاح
  ثم تنكسر في متصفح المستخدم.

### HEALTHCHECK — liveness لا readiness

`HEALTHCHECK` يعتبر **أي** رد HTTP دليلًا على أن الخادم حيّ؛ فشل الاتصال وحده يعني موته.
**لا يشترط 200 عمدًا**: `/api/health` يرد 503 حين تتعثّر خدمة خارجية (رُصد انقطاع Supabase
ثلاث مرات أثناء التطوير، كلها عابرة). لو ربطنا صحة الحاوية بذلك لأعادت المنصة تشغيل خادم
سليم بعد 90ث من انقطاع خارجي — وإعادة التشغيل لا تُصلح خدمة خارجية.

**جسم `/api/health` هو readiness**: استخدمه للمراقبة وصفحات الحالة والتنبيهات، لا لقرار
إعادة التشغيل.

## متطلبات الخادم (من القياس الفعلي)

القياس: أعلى **RSS ≈ 1.9GB** عند معالجة 5 ملفات متزامنة (يشمل خادم Next + النموذج ~500MB).
نموذج Embeddings يُحمّل مرة واحدة (~112MB على القرص) وأول تحميل ~18ث.

**الموصى به:**

| المورد | تطوير | إنتاج (request-driven) |
|---|---|---|
| RAM | 4GB | **≥ 2GB مخصّصة** (يُفضّل 4GB لهامش) |
| CPU | 2 vCPU | **≥ 2 vCPU** (النموذج CPU-bound أثناء embedding) |
| القرص | — | ≥ 1GB لكاش النموذج (`.cache/transformers`) |
| النوع | — | خادم دائم (VM/Container) لا Serverless |

وضع `YSD_LOW_MEMORY=1` يخفض الذروة (مقاطع أقل، دفعة 4 بدل 8) لخوادم 1–2GB.

## ⚠️ Serverless غير مناسب للـRAG

- **نموذج Embeddings المحلي** يحتاج تحميلًا (~18ث) وذاكرة مقيمة (~500MB) — بارد على كل
  استدعاء Serverless، ويتجاوز حدود الذاكرة/الزمن غالبًا.
- **العامل طويل التشغيل** لا يناسب دوال Serverless قصيرة العمر.
- **الحل**: انشر التطبيق على خادم دائم (Node) — VM أو Container (Fly.io / Render / Railway /
  VPS). يمكن نشر الواجهة والمصادقة والمحادثة على Serverless إن فُصل RAG لخدمة خادمية دائمة،
  لكن الحالي أحادي العملية فاختر خادمًا دائمًا.

## إعدادان

### Development Local
```
YSD_LOW_MEMORY غير مضبوط · YSD_STRICT_ENV غير مضبوط
npm run dev            # لا تشغّل build في الوقت نفسه
```

### Production Worker Ready (request-driven الآن)
```
NODE_ENV=production
YSD_STRICT_ENV=1
YSD_LOW_MEMORY=1        # على خوادم ≤ 2GB
npm run build && npm start
# العامل المستقل: npm run worker:rag  (يتطلب SUPABASE_SERVICE_ROLE_KEY + موافقة — غير مُفعّل)
```

## الفحص الصحي

`GET /api/health` — يفحص: التطبيق · Supabase · قاعدة البيانات · pgvector · Storage ·
OpenRouter (إعداد فقط، **بلا طلب AI مدفوع**) · نموذج Embeddings. يرجع 200 (ok/degraded) أو
503 (down). **لا يكشف أسرارًا ولا قيم بيئة ولا storage_path**. لكل استدعاء `correlation_id`.

## الترحيلات (migrations)

طبّق بالترتيب في Supabase SQL Editor: `0001` → `0008`. كلها آمنة لإعادة التشغيل.
`0008` يتطلب مراجعة الصلاحيات (منح `authenticated` للدوال المقيّدة بالمالك فقط).

## الاحتفاظ والتنظيف

- `cleanup_old_rag_jobs(7)` يحذف الوظائف المنتهية الأقدم من 7 أيام (service_role/cron فقط).
- جدولته عبر pg_cron (Supabase): `select cron.schedule('rag-cleanup','0 3 * * *', $$select cleanup_old_rag_jobs(7)$$);`
- سجلات الأداء لا تُخزَّن في قاعدة البيانات (stdout منظّم فقط) — تُدار عبر منصّة الاستضافة.

## المهلات (Timeouts)

- الموفر الخارجي (OpenRouter): 60ث.
- دفعة Embedding: 120ث (180ث في وضع الذاكرة المنخفضة).
- فحوص الصحة: 3ث لكل تبعية.
- `maxDuration` لمسار المحادثة 120ث، ولتجهيز RAG 300ث.

## الإيقاف اللطيف (Graceful Shutdown)

- request-driven: الوظيفة تكتمل ضمن دورة حياة الطلب؛ لا حالة معلّقة في الذاكرة.
- العامل المستقل: يلتقط SIGINT/SIGTERM وينتظر انتهاء الوظيفة الحالية قبل الخروج.
- الوظائف العالقة (عامل توقف فجأة) تُستعاد تلقائيًا عبر انتهاء القفل (`LEASE_SECONDS`).
