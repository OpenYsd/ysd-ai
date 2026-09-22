/**
 * Repo-document retrieval set (labels are objective and model-independent).
 *
 * answerable:   [query, [regex sources a relevant chunk must ALL match]]
 * unanswerable: [query, [regex sources of which NONE may appear in any chunk], group, isFromOldFixture?]
 *
 * Groups of unanswerable queries:
 *   general            — unrelated to the docs (capital cities, recipes, ...)
 *   near-technical     — technical topics adjacent to the docs (Kubernetes, Terraform, ...) but absent from them
 *   same-topic-absent  — the docs DO discuss the topic; the specific fact asked for is NOT in them (hardest negatives)
 */
export const answerable = [
  // ---- Arabic ----
  ["كم أعلى استهلاك للذاكرة عند معالجة خمسة ملفات متزامنة؟", ["1\\.9\\s*GB"]],
  ["ما الحد الأقصى لطول الاقتباس في وضع الأدلة؟", ["240 حرفًا"]],
  ["كم مدة صلاحية رمز الجلسة في الاقتران بالمحرك المحلي؟", ["رمزُ الجلسة", "15 دقيقة"]],
  ["هل يغادر الصوت الخام جهاز المستخدم؟", ["(صوتٌ|صوتٍ|صوتًا) خام"]],
  ["كم رسالة يوميًا تُسمح في الباقة المجانية؟", ["50/يوم"]],
  ["كم تذكرة في الساعة تُسمح لكل دعوة؟", ["20 تذكرة"]],
  ["هل تدخل الصور في التجهيز الدلالي للملفات؟", ["بلا OCR"]],
  ["ماذا تعني الألوان الخضراء والصفراء والبيضاء في خارطة الطريق؟", ["🟢 مكتمل"]],
  ["ما عتبة الثقة في الاسترجاع وماذا يحدث عند عدم التطابق؟", ["0\\.80", "لم أجد"]],
  ["هل يشترك الإنتاج والتجريب في مشروع قاعدة بيانات واحد؟", ["مشروع Supabase واحدًا"]],
  ["لماذا يكسر نظام الملفات للقراءة فقط عملية التجهيز؟", ["للقراءة فقط", "RAG"]],
  ["ما هو الفحص الذي لا يلمس قاعدة البيانات ولا التخزين ولا النموذج؟", ["liveness"]],
  ["ما هي حالات بطاقة المرفق بالترتيب؟", ["selected", "uploading"]],
  ["بعد كم ثانية ينهي التطبيق الطلب المتأخر بنفسه؟", ["110 ثانية"]],
  // ---- English (over the Arabic-language docs: cross-lingual) ----
  ["How do I add a new AI provider to the system?", ["AIProviderAdapter"]],
  ["What does the YSD_LOW_MEMORY setting change?", ["YSD_LOW_MEMORY"]],
  ["How large is the faster-whisper small model download?", ["faster-whisper", "464"]],
  ["How do I verify the local image flag is baked into the browser bundle?", ["verify-local-image-flag"]],
  ["How are the database backups encrypted?", ["\\bage\\b"]],
  ["What is a SEV-3 incident?", ["SEV-3"]],
  ["How do I trigger the alert delivery test workflow?", ["force_alert_test"]],
  ["Which script must report 22/22 before launch?", ["rag-check", "22/22"]],
  ["What should I run before every commit?", ["npm run typecheck"]],
  ["Is there any Stripe payment integration?", ["Stripe"]],
  ["How does the RAG retry avoid duplicate chunks?", ["rag_content_hash|تكرار chunks"]],
  ["Why is the rate limiter only safe with a single instance?", ["rate-limit\\.ts"]],
  ["Which Supabase setting must be disabled for the sign-up tests?", ["Confirm email"]],
  ["Which unique constraint prevents duplicate chat requests?", ["chat_request_ids_unique"]],
  ["Why do SECURITY DEFINER functions pin the search_path?", ["search_path"]],
  ["Does the container run as a non-root user?", ["USER node|غير root"]],
  // ---- Mixed Arabic + English terms ----
  ["كيف أنشر التطبيق على Railway وما إعداد PORT؟", ["PORT", "Railway"]],
  ["لماذا يفشل الاتصال المباشر من GitHub Actions بقاعدة Supabase؟", ["IPv6"]],
  ["ما المنفذ 47615 الذي يستعمله المحرك المحلي؟", ["47615"]],
  ["كيف أعمل rollback لترحيل 0027 في Supabase؟", ["0027", "ai_models"]],
  ["ما أوامر التحقق قبل أي commit في المشروع؟", ["npm run typecheck"]],
  ["أي migrations يجب تطبيقها في SQL Editor من 0001 إلى 0008؟", ["0001", "0008", "SQL Editor"]],
  ["هل يمكن تعطيل RAG على الصور بدون OCR؟", ["OCR"]],
  ["ما معنى SEV-3 في تصنيف الحوادث؟", ["SEV-3"]],
  ["كيف أشغّل workflow لاختبار وصول التنبيهات باستخدام force_alert_test؟", ["force_alert_test"]],
  ["كيف يُستأنف job المتوقفة في شريط الكتابة؟", ["عقد الإيجار"]],
  ["ما حد حجم الملف الفعلي بين حد الباقة وسقف مزود storage؟", ["سقف مزود التخزين"]],
  ["كم ميغابايت يحتاج تنزيل نموذج faster-whisper small؟", ["faster-whisper", "464"]],
  ["كيف تُحمى جداول distributed_rate_limits عبر RLS؟", ["distributed_rate_limits", "row level security"]],
  ["ما الفرق بين liveness وباقي فحوص health؟", ["liveness"]],
  ["ما دور age في تشفير النسخ الاحتياطية قبل الرفع؟", ["\\bage\\b"]],
];

export const unanswerable = [
  // general knowledge, Arabic (the first six are the app's calibration fixture "unrelated" questions)
  ["ما هي عاصمة اليابان؟", ["اليابان"], "ar-general", true],
  ["كيف أطبخ الأرز البسمتي؟", ["البسمتي"], "ar-general", true],
  ["من فاز بكأس العالم عام 2022؟", ["كأس العالم"], "ar-general", true],
  ["ما هو قانون الجاذبية لنيوتن؟", ["نيوتن"], "ar-general", true],
  ["كم عدد أيام السنة الكبيسة؟", ["الكبيسة"], "ar-general", true],
  ["ما أفضل وقت لزيارة باريس؟", ["باريس"], "ar-general", true],
  ["ما هي أعراض الأنفلونزا الموسمية؟", ["الأنفلونزا"], "ar-general"],
  ["كيف أتعلم العزف على الجيتار؟", ["الجيتار"], "ar-general"],
  ["ما هي أطول سلسلة جبال في العالم؟", ["سلسلة جبال"], "ar-general"],
  ["كيف تتكوّن الأمطار الرعدية؟", ["الرعدية"], "ar-general"],
  // general knowledge, English
  ["What is the capital of Australia?", ["Australia"], "en-general"],
  ["How do I bake sourdough bread?", ["sourdough"], "en-general"],
  ["Who painted the Mona Lisa?", ["Mona Lisa"], "en-general"],
  ["What is the boiling point of water at high altitude?", ["boiling"], "en-general"],
  ["How many moons does Jupiter have?", ["Jupiter"], "en-general"],
  ["What is the best time to visit Kyoto?", ["Kyoto"], "en-general"],
  ["What are the symptoms of the seasonal flu?", ["influenza"], "en-general"],
  ["How do volcanoes form?", ["volcano"], "en-general"],
  // general, mixed
  ["ما هي أفضل programming language لتعلم الذكاء الاصطناعي؟", ["programming language"], "mixed-general"],
  ["ما هي وصفة الكبسة السعودية مع chicken؟", ["الكبسة"], "mixed-general"],
  ["كيف أبدأ workout routine للمبتدئين؟", ["workout"], "mixed-general"],
  ["ما أفضل smartphone للتصوير الليلي؟", ["smartphone"], "mixed-general"],
  ["كيف أحجز flight رخيصة إلى إسطنبول؟", ["إسطنبول"], "mixed-general"],
  // near-domain (technical topics adjacent to the docs but absent from them)
  ["How do I configure Kubernetes horizontal pod autoscaling?", ["Kubernetes"], "en-near"],
  ["How do I write a Terraform module for an AWS network?", ["Terraform"], "en-near"],
  ["How do I migrate a MySQL database to MongoDB?", ["MySQL", "MongoDB"], "en-near"],
  ["How do I write a GraphQL subscription resolver?", ["GraphQL"], "en-near"],
  ["How do I tune Elasticsearch shard allocation?", ["Elasticsearch"], "en-near"],
  ["How do I set up Prometheus and Grafana dashboards?", ["Prometheus", "Grafana"], "en-near"],
  ["كيف أضبط Kubernetes للتوسع التلقائي للحاويات؟", ["Kubernetes"], "mixed-near"],
  ["كيف أكتب Terraform module لإنشاء شبكة سحابية؟", ["Terraform"], "mixed-near"],
  ["كيف أنقل قاعدة MySQL إلى MongoDB؟", ["MySQL", "MongoDB"], "mixed-near"],
  ["كيف أستهلك رسائل Kafka بمجموعات المستهلكين؟", ["Kafka"], "mixed-near"],
  ["كيف أبني لوحات Grafana لمراقبة الخادم؟", ["Grafana"], "mixed-near"],
];

/**
 * Added for the F2LLM calibration gate (beyond the original set). Same tuple shape as `unanswerable`; the
 * `absent` list uses ANY-semantics here (a chunk matching any pattern means the topic is present ⇒ query rejected
 * by the builder), which is stricter than the older entries.
 */
export const unanswerableHard = [
  // ---- same-topic-absent: the docs discuss the topic, this specific fact is not in them ----
  ["كم يبلغ حد الرسائل اليومية في باقة Enterprise؟", ["Enterprise"], "same-topic-absent"],
  ["ما مدة صلاحية رمز الجلسة عند الاقتران عبر الهاتف المحمول؟", ["الهاتف المحمول"], "same-topic-absent"],
  ["كم عدد المستخدمين المسموح لهم في الفريق الواحد؟", ["الفريق الواحد"], "same-topic-absent"],
  ["ما سعر الاشتراك الشهري في الباقة المتقدمة؟", ["الاشتراك الشهري", "الباقة المتقدمة"], "same-topic-absent"],
  ["هل يدعم التطبيق تصدير المحادثات إلى ملف؟", ["تصدير المحادثات", "تصدير محادثة"], "same-topic-absent"],
  ["ما اسم مزوّد خدمة البريد الإلكتروني المستخدم لإرسال الدعوات؟", ["SendGrid", "Mailgun", "SMTP", "Postmark"], "same-topic-absent"],
  ["هل يدعم المحرك المحلي التعرف على الكلام بالهندية؟", ["الهندية", "Hindi"], "same-topic-absent"],
  ["ما الحد الأقصى لحجم الملف في باقة Pro؟", ["\bPro\b"], "same-topic-absent"],
  ["ما لون شارة الحالة عند فشل التجهيز في بطاقة المرفق؟", ["شارة"], "same-topic-absent"],
  ["كم عدد النسخ الاحتياطية التي يُحتفظ بها قبل الحذف التلقائي؟", ["الحذف التلقائي", "الاحتفاظ بآخر"], "same-topic-absent"],
  ["ما اسم المنطقة السحابية التي تستضيف قاعدة البيانات؟", ["المنطقة السحابية", "region"], "same-topic-absent"],
  ["What is the SLA response time for a SEV-1 incident?", ["SEV-1"], "same-topic-absent"],
  ["Which cloud region hosts the Supabase database?", ["region", "المنطقة السحابية"], "same-topic-absent"],
  ["How many replicas does the Railway service run?", ["replica", "نسخ متعددة"], "same-topic-absent"],
  ["Does the app support single sign-on with SAML?", ["SAML", "SSO"], "same-topic-absent"],
  ["What is the monthly price of the Pro plan?", ["\bPro\b"], "same-topic-absent"],
  ["What TLS version does the health endpoint require?", ["TLS"], "same-topic-absent"],
  ["How do I enable dark mode in the settings?", ["dark mode", "الوضع الداكن"], "same-topic-absent"],
  ["Which Redis version is used for rate limiting?", ["Redis"], "same-topic-absent"],
  ["How do I configure webhooks for incident alerts?", ["webhook"], "same-topic-absent"],
  ["What is the maximum audio length for transcription?", ["audio length", "مدة الصوت", "طول المقطع الصوتي"], "same-topic-absent"],
  ["How do I rotate the age encryption key for backups?", ["rotate", "تدوير"], "same-topic-absent"],
  ["كيف أضبط SAML SSO للمؤسسة؟", ["SAML", "SSO"], "same-topic-absent"],
  ["ما سعر Pro plan الشهري؟", ["\bPro\b"], "same-topic-absent"],
  ["كيف أفعّل dark mode في إعدادات التطبيق؟", ["dark mode", "الوضع الداكن"], "same-topic-absent"],
  ["كيف أضبط Redis cluster للـ rate limiting؟", ["Redis"], "same-topic-absent"],
  ["ما عدد replicas لخدمة Railway؟", ["replica"], "same-topic-absent"],
  ["كيف أضيف webhook لتنبيهات الحوادث؟", ["webhook"], "same-topic-absent"],
  ["كيف أستخرج تقرير استهلاك الرسائل الشهري بصيغة CSV؟", ["CSV"], "same-topic-absent"],
  ["What is the maximum number of files a user can attach to one message?", ["files per message", "ملفات لكل رسالة"], "same-topic-absent"],
  // ---- more adjacent-technical: infrastructure/tooling topics near the docs, absent from them ----
  ["How do I set up an Nginx reverse proxy with SSL termination?", ["nginx"], "near-technical"],
  ["How do I implement the OAuth2 PKCE flow in a Next.js app?", ["PKCE", "OAuth"], "near-technical"],
  ["How do I use Redis Streams for job queues?", ["Redis"], "near-technical"],
  ["How do I write a GitHub Actions matrix build for several Node versions?", ["matrix"], "near-technical"],
  ["How do I profile memory leaks in a Node.js service with heap snapshots?", ["heap snapshot", "heapdump"], "near-technical"],
  ["How do I shard a PostgreSQL table with declarative partitioning?", ["partitioning", "تقسيم الجداول"], "near-technical"],
  ["كيف أضبط Nginx كوكيل عكسي مع شهادة SSL؟", ["nginx"], "near-technical"],
  ["كيف أنفّذ تدفق OAuth2 PKCE في تطبيق Next.js؟", ["PKCE", "OAuth"], "near-technical"],
  ["كيف أكتب GitHub Actions matrix لعدة إصدارات Node؟", ["matrix"], "near-technical"],
  ["كيف أحلل تسرّب الذاكرة في خدمة Node.js بلقطات heap؟", ["heap snapshot", "heapdump"], "near-technical"],
  // ---- more general, Arabic / English / mixed ----
  ["ما هي أكبر دولة في العالم من حيث المساحة؟", ["أكبر دولة"], "general"],
  ["كم تبلغ سرعة الضوء؟", ["سرعة الضوء"], "general"],
  ["من كتب رواية الحرب والسلام؟", ["الحرب والسلام"], "general"],
  ["What is the tallest mountain in the world?", ["tallest mountain", "Everest"], "general"],
  ["Who discovered penicillin?", ["penicillin"], "general"],
  ["How many bones are in the adult human body?", ["bones"], "general"],
  ["ما هي أفضل طريقة لتعلم الإنجليزية بسرعة with apps؟", ["تعلم الإنجليزية"], "general"],
  ["كيف أحسب BMI لشخص بالغ؟", ["BMI"], "general"],
];
