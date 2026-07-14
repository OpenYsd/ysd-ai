# سجل إصدارات YSD AI

جميع الإصدارات مُختبرة (typecheck · lint · build · unit + runtime tests) قبل الوسم.

## v0.4.1 — 2026-07-14 · Deployment Ready

- فحص متغيرات البيئة عند الإقلاع (`instrumentation.ts`) دون طباعة قيم؛ `YSD_STRICT_ENV`.
- `GET /api/health` آمن: التطبيق · Supabase · DB · pgvector · Storage · OpenRouter (إعداد
  فقط، بلا طلب AI مدفوع) · نموذج Embeddings — بلا كشف أسرار/مسارات، مع `correlation_id`.
- سجلات JSON منظّمة (`lib/logger.ts`) بلا نصوص/مفاتيح؛ وضع الذاكرة المنخفضة (`YSD_LOW_MEMORY`).
- مهلة موفر صريحة 60ث، حارس نسخة نموذج واحدة، واجهة العامل المستقل (غير مُفعّل)، graceful shutdown.
- `docs/DEPLOYMENT.md` + `docs/PRODUCTION_CHECKLIST.md` + `.env.example` محدّث.
- اختبارات: env 7/7، deployment-check حي 11/11 (فشل خدمة لا يُسقط المنصة).

## v0.4.0 — 2026-07-14 · Production-Hardened RAG

- **طابور RAG دائم في قاعدة البيانات** (`rag_jobs`) — PostgreSQL مصدر الحقيقة الوحيد
  للوظائف والأقفال والمحاولات والتقدم. الذاكرة للأداء فقط.
- التقاط ذري عبر `FOR UPDATE SKIP LOCKED`؛ فهرس فريد جزئي (وظيفة نشطة واحدة لكل ملف+نوع)؛
  idempotency key = `file_id:content_hash:job_type`.
- استئناف بعد التوقف: chunking يُتخطّى عبر hash، وembedding للمقاطع الفارغة فقط — بلا تكرار.
- Retry بـ backoff أُسّي وتصنيف أخطاء (transient/permanent/cancelled)، إلغاء، تنظيف دوري.
- **المعالجة request-driven**؛ العامل المستقل عبر المستخدمين غير مُفعّل (يحتاج service role).
- **تزامن Embeddings داخل العملية = 1**؛ أعلى استهلاك مقاس **≈ 1.9GB RSS** عند 5 ملفات.
- migration 0008 (+ مراجعة أمنية: `search_path=public,pg_temp`، `revoke/grant`، `WITH CHECK`).
- اختبارات: rag-stress-check 20/20، rag-check 22/22.

## v0.3.0 — 2026-07-13 · RAG محلي مجاني

- إرفاق ملف بالمحادثة → تقسيم عربي/إنجليزي → embeddings محلية
  (`Xenova/multilingual-e5-small`, 384 بُعد، بلا API خارجي) → بحث دلالي.
- استرجاع آمن عبر RPC `match_file_chunks` (يتحقق من `auth.uid()`)، عتبة مُعايَرة
  (أرضية 0.78 + ثقة 0.80)، تصريح «لم أجد» عند عدم التطابق، أرقام صفحات PDF.
- حماية Prompt Injection (سياق مُسوَّر)، مصادر قابلة للنقر. migration 0007 (pgvector).
- اختبار E2E من المتصفح (PDF متعدد الصفحات + DOCX).

## v0.2.0 — 2026-07-13 · نظام الملفات

- رفع PDF/DOCX/TXT/MD/PNG/JPG/WEBP، تحقق مزدوج (امتداد+MIME)، تعقيم أسماء، منع traversal.
- تخزين خاص (Bucket غير عام)، Signed URLs، استخراج نص حقيقي، حدود لكل باقة.
- migrations 0005 + 0006. اختبار Runtime 36/36.

## v0.1.1 — 2026-07-13 · موفر مجاني + جودة اللغة

- OpenRouter مجاني افتراضي (Allowlist عربي)، Language Guard، تسجيل النموذج الفعلي،
  حد يومي. migrations 0003 + 0004. Regression 23/23 + منصة 54/54.

## v0.1.0 — 2026-07-12 · MVP

- مصادقة كاملة، محادثة حقيقية بالبث والحفظ، RLS مُثبت، واجهة منسقة RTL/LTR داكن/فاتح،
  نظام المشاريع. migrations 0001 + 0002.
