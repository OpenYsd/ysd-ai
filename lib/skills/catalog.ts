/**
 * فهرس المهارات المدمجة — بيانات لا شيفرة.
 *
 * كل مهارةٍ هنا تعليماتٌ نصّية حقيقية يقرؤها المستخدم وينسخها إلى المحادثة. ما يعلن منها
 * صلاحيةً معطّلة (`files.read`، `web.fetch`) يظهر في الواجهة بحدّه: لا تعمل آليًّا بعد.
 * الفهرس يُتحقَّق منه عند البناء في `registry.ts`؛ ومصادره المدمجة وحدها.
 *
 * الوصف والتعليمات بلا أسماء مزوّدين ولا تفاصيل تشغيل — الواجهة سطحٌ عامّ.
 */

import type { SkillManifest } from "./manifest";

const V = 1 as const;

export const BUILT_IN_SKILLS: readonly SkillManifest[] = [
  {
    manifestVersion: V,
    id: "arabic-proofreader",
    version: "1.0.0",
    source: "builtin",
    category: "writing",
    name: { ar: "المدقّق اللغوي", en: "Arabic proofreader" },
    summary: {
      ar: "يصحّح الإملاء والنحو والهمزات وعلامات الترقيم مع الحفاظ على المعنى والأسلوب.",
      en: "Fixes spelling, grammar, hamza forms and punctuation while keeping meaning and voice.",
    },
    description: {
      ar: "تدقيقٌ لغويّ للنصوص العربية: الإملاء، والنحو، وهمزات الوصل والقطع، والتاء المربوطة والهاء، وعلامات الترقيم، وتناسق الأسلوب. لا يعيد الصياغة ولا يغيّر المعنى، ويعرض التصويبات بشكلٍ يسهل مراجعته.",
      en: "Proofreading for Arabic text: spelling, grammar, hamza forms, taa marbuta vs haa, punctuation and consistency of style. It does not rewrite or change meaning, and it presents corrections in a reviewable form.",
    },
    instructions: {
      ar: "أنت مدقّق لغويّ عربيّ. دقّق النصّ التالي دون تغيير معناه أو أسلوب كاتبه:\n1. صحّح الإملاء والهمزات (وصل/قطع) والتاء المربوطة والهاء والألف المقصورة.\n2. صحّح النحو والصرف وعلامات الترقيم وتناسق المصطلحات.\n3. لا تعد الصياغة ولا تحذف جملًا ولا تضف معلومات.\n4. اعرض أولًا النصّ المصحّح كاملًا، ثم جدولًا بثلاثة أعمدة: الخطأ، التصويب، السبب باختصار.\n5. إن كان الموضع صحيحًا ولك فيه اقتراحٌ أسلوبي، ضعه في قسمٍ منفصل بعنوان «اقتراحات اختيارية».\n\nالنصّ:",
      en: "You are an Arabic proofreader. Proofread the following text without changing its meaning or the author's voice:\n1. Fix spelling, hamza forms, taa marbuta vs haa, and alif maqsura.\n2. Fix grammar, morphology, punctuation and terminology consistency.\n3. Do not rewrite, delete sentences or add information.\n4. First show the full corrected text, then a three-column table: error, correction, brief reason.\n5. If something is correct but you have a stylistic suggestion, put it in a separate section titled \"Optional suggestions\".\n\nText:",
    },
    capabilities: ["prompt.template"],
    tags: ["arabic", "grammar", "spelling"],
    examples: [
      { ar: "دقّق هذا البريد قبل إرساله إلى العميل.", en: "Proofread this email before sending it to the client." },
      { ar: "راجع الفقرة الثانية من المقال وصحّح الهمزات.", en: "Review the second paragraph of the article and fix the hamzas." },
    ],
  },
  {
    manifestVersion: V,
    id: "summarize-text",
    version: "1.0.0",
    source: "builtin",
    category: "writing",
    name: { ar: "الملخِّص", en: "Summarizer" },
    summary: {
      ar: "يلخّص نصًّا طويلًا في نقاطٍ واضحة مع أهمّ الأرقام والقرارات، بطول تختاره.",
      en: "Condenses a long text into clear points with the key numbers and decisions, at a length you choose.",
    },
    description: {
      ar: "تلخيصٌ أمين: يحتفظ بالحقائق والأرقام والأسماء كما وردت، ويفصل بين ما قاله النصّ وما يُستنتج منه، ويبدأ بجملةٍ واحدة تلخّص الفكرة الرئيسية ثم نقاطٍ مرتّبة بالأهمية.",
      en: "Faithful summarization: it keeps facts, numbers and names as stated, separates what the text says from what can be inferred, and opens with a one-sentence main idea followed by points ordered by importance.",
    },
    instructions: {
      ar: "لخّص النصّ التالي:\n- ابدأ بجملةٍ واحدة تحمل الفكرة الرئيسية.\n- ثم 3 إلى 7 نقاط مرتّبة بالأهمية، تحتفظ بالأرقام والأسماء والتواريخ كما وردت.\n- لا تضف معلوماتٍ من خارج النصّ، ولا تُبدِ رأيًا.\n- إن وُجد قرارٌ أو طلبٌ أو موعد، اذكره في قسمٍ أخير بعنوان «ما يجب الانتباه إليه».\n- الطول: ___ (قصير / متوسط / مفصّل).\n\nالنصّ:",
      en: "Summarize the following text:\n- Start with one sentence carrying the main idea.\n- Then 3 to 7 points ordered by importance, keeping numbers, names and dates as stated.\n- Do not add outside information and do not give opinions.\n- If there is a decision, a request or a deadline, list it in a final section titled \"Things to note\".\n- Length: ___ (short / medium / detailed).\n\nText:",
    },
    capabilities: ["prompt.template"],
    tags: ["summary", "reading"],
    examples: [
      { ar: "لخّص هذا التقرير في خمس نقاط.", en: "Summarize this report in five points." },
      { ar: "ما الفكرة الرئيسية في هذا المقال؟", en: "What is the main idea of this article?" },
    ],
  },
  {
    manifestVersion: V,
    id: "translate-ar-en",
    version: "1.0.0",
    source: "builtin",
    category: "writing",
    name: { ar: "المترجم عربي ↔ إنجليزي", en: "Arabic ↔ English translator" },
    summary: {
      ar: "ترجمةٌ دقيقة بين العربية والإنجليزية تراعي السياق والمستوى اللغوي والمصطلحات.",
      en: "Accurate translation between Arabic and English that respects context, register and terminology.",
    },
    description: {
      ar: "يترجم في الاتجاهين مع اختيار المستوى المناسب (رسمي، تقني، يومي)، ويحافظ على المصطلحات الثابتة، ويشرح الخيارات المحتملة للكلمات التي تحتمل أكثر من معنى بدل اختيارٍ صامت.",
      en: "Translates both ways with the appropriate register (formal, technical, everyday), keeps fixed terminology, and explains the options for words with more than one plausible meaning instead of choosing silently.",
    },
    instructions: {
      ar: "ترجم النصّ التالي إلى ___ (العربية / الإنجليزية):\n- المستوى اللغوي: ___ (رسمي / تقني / يومي).\n- حافظ على المصطلحات والأسماء والأرقام كما هي، وضع المصطلح الأصلي بين قوسين عند أول ورود إن كان تقنيًّا.\n- لا تلخّص ولا تضف ولا تحذف.\n- إن احتملت عبارةٌ أكثر من معنى، اختر الأرجح من السياق واذكر البدائل في ملاحظةٍ قصيرة بعد الترجمة.\n\nالنصّ:",
      en: "Translate the following text into ___ (Arabic / English):\n- Register: ___ (formal / technical / everyday).\n- Keep terminology, names and numbers as they are; put the original term in parentheses at first mention if it is technical.\n- Do not summarize, add or omit anything.\n- If a phrase has more than one plausible meaning, pick the most likely from context and list the alternatives in a short note after the translation.\n\nText:",
    },
    capabilities: ["prompt.template"],
    tags: ["translation", "arabic", "english"],
    examples: [
      { ar: "ترجم هذا العقد إلى الإنجليزية بمستوى رسمي.", en: "Translate this contract into English in a formal register." },
      { ar: "ترجم هذه الرسالة إلى العربية بأسلوبٍ ودّي.", en: "Translate this message into Arabic in a friendly tone." },
    ],
  },
  {
    manifestVersion: V,
    id: "meeting-notes-actions",
    version: "1.0.0",
    source: "builtin",
    category: "productivity",
    name: { ar: "محضر الاجتماع", en: "Meeting notes to actions" },
    summary: {
      ar: "يحوّل ملاحظات اجتماعٍ مبعثرة إلى قرارات ومهامّ بمسؤولٍ وموعدٍ لكلٍّ منها.",
      en: "Turns scattered meeting notes into decisions and action items, each with an owner and a due date.",
    },
    description: {
      ar: "ينظّم ما كُتب أثناء الاجتماع: ما نوقش، وما تقرّر، وما تبقّى مفتوحًا، ثم جدول مهامّ (المهمة، المسؤول، الموعد، الحالة). ما لم يُذكر له مسؤولٌ أو موعد يُترك فارغًا بوضوح بدل التخمين.",
      en: "Organizes what was written during the meeting: what was discussed, what was decided and what remains open, then an action table (task, owner, due date, status). Anything without a stated owner or date is left visibly blank rather than guessed.",
    },
    instructions: {
      ar: "حوّل ملاحظات الاجتماع التالية إلى محضرٍ منظّم:\n1. العنوان والتاريخ والحضور إن ذُكروا.\n2. «ما نوقش»: نقاطٌ قصيرة.\n3. «القرارات»: كل قرارٍ في سطر.\n4. «المهامّ»: جدول بأعمدة (المهمة، المسؤول، الموعد، الحالة). إن لم يُذكر المسؤول أو الموعد فاكتب «غير محدّد» ولا تخمّن.\n5. «نقاط مفتوحة»: ما نوقش ولم يُحسم.\nلا تضف قراراتٍ لم تُذكر.\n\nالملاحظات:",
      en: "Turn the following meeting notes into structured minutes:\n1. Title, date and attendees if mentioned.\n2. \"Discussed\": short points.\n3. \"Decisions\": one per line.\n4. \"Action items\": a table with columns (task, owner, due date, status). If the owner or date was not mentioned, write \"not specified\" and do not guess.\n5. \"Open points\": discussed but not settled.\nDo not add decisions that were not mentioned.\n\nNotes:",
    },
    capabilities: ["prompt.template"],
    tags: ["meetings", "tasks", "planning"],
    examples: [
      { ar: "نظّم ملاحظات اجتماع الفريق اليوم في محضر.", en: "Organize today's team meeting notes into minutes." },
      { ar: "استخرج المهامّ والمسؤولين من هذه الملاحظات.", en: "Extract the tasks and owners from these notes." },
    ],
  },
  {
    manifestVersion: V,
    id: "explain-code",
    version: "1.0.0",
    source: "builtin",
    category: "code",
    name: { ar: "شارح الشيفرة", en: "Code explainer" },
    summary: {
      ar: "يشرح ما تفعله قطعةُ شيفرة خطوةً خطوة، ويذكر التعقيد والمزالق المحتملة.",
      en: "Explains what a piece of code does step by step, with its complexity and likely pitfalls.",
    },
    description: {
      ar: "شرحٌ للشيفرة الملصقة في المحادثة: الغرض العامّ، ثم سير التنفيذ، ثم الحالات الحدّية والأخطاء المحتملة، ثم التعقيد الزمني والمكاني حيث ينطبق. يشرح ولا يعدّل، ويقترح التحسينات في قسمٍ منفصل إن طُلبت.",
      en: "Explains code pasted into the chat: the overall purpose, then the execution flow, then edge cases and likely bugs, then time and space complexity where applicable. It explains without modifying, and lists improvements in a separate section if asked.",
    },
    instructions: {
      ar: "اشرح الشيفرة التالية:\n1. الغرض في جملةٍ واحدة.\n2. سير التنفيذ خطوةً خطوة بلغةٍ بسيطة، مع الإشارة إلى أرقام الأسطر إن أمكن.\n3. الحالات الحدّية والمدخلات التي قد تُفشلها.\n4. التعقيد الزمني والمكاني إن كان ذا معنى.\n5. لا تعدّل الشيفرة. إن رأيت تحسينًا، اذكره في قسمٍ أخير بعنوان «تحسينات مقترحة» بلا تطبيق.\n\nالشيفرة:",
      en: "Explain the following code:\n1. The purpose in one sentence.\n2. The execution flow step by step in plain language, referring to line numbers where possible.\n3. Edge cases and inputs that could break it.\n4. Time and space complexity where meaningful.\n5. Do not modify the code. If you see an improvement, list it in a final section titled \"Suggested improvements\" without applying it.\n\nCode:",
    },
    capabilities: ["prompt.template"],
    tags: ["code", "review", "learning"],
    examples: [
      { ar: "اشرح لي هذه الدالّة وما الحالات التي تفشل فيها.", en: "Explain this function and the cases where it fails." },
      { ar: "ما تعقيد هذا الاستعلام ولماذا؟", en: "What is the complexity of this query and why?" },
    ],
  },
  {
    manifestVersion: V,
    id: "study-questions",
    version: "1.0.0",
    source: "builtin",
    category: "learning",
    name: { ar: "مولّد أسئلة المراجعة", en: "Study question generator" },
    summary: {
      ar: "يستخرج من نصٍّ دراسي أسئلةَ مراجعةٍ متدرّجة الصعوبة مع إجاباتها ومواضعها في النصّ.",
      en: "Builds review questions of graded difficulty from study material, with answers and where they appear in the text.",
    },
    description: {
      ar: "من فصلٍ أو مقالٍ أو ملاحظات، ينتج أسئلةً بمستويات: تذكّر، فهم، تطبيق، مع إجابةٍ نموذجية لكلٍّ منها وإشارةٍ إلى الفقرة التي تستند إليها، كي يتحقّق الطالب بنفسه. يلتزم بما في النصّ ولا يضيف من خارجه.",
      en: "From a chapter, article or notes, it produces questions at levels: recall, understanding, application, each with a model answer and a pointer to the paragraph it rests on, so the learner can verify. It stays within the text and adds nothing external.",
    },
    instructions: {
      ar: "أنشئ أسئلة مراجعة من النصّ التالي:\n- 4 أسئلة تذكّر، و4 أسئلة فهم، و2 سؤال تطبيق.\n- لكل سؤال: الإجابة النموذجية باختصار، ثم «المصدر: الفقرة ___» من النصّ نفسه.\n- لا تسأل عمّا ليس في النصّ.\n- اختم بثلاث نقاط «الأفكار التي يجب ألّا تُنسى».\n\nالنصّ:",
      en: "Create review questions from the following text:\n- 4 recall questions, 4 understanding questions and 2 application questions.\n- For each question: a brief model answer, then \"Source: paragraph ___\" from the text itself.\n- Do not ask about anything not in the text.\n- End with three \"Ideas not to forget\" points.\n\nText:",
    },
    capabilities: ["prompt.template"],
    tags: ["study", "questions", "revision"],
    examples: [
      { ar: "اصنع أسئلة مراجعة من هذا الفصل.", en: "Make review questions from this chapter." },
      { ar: "أريد عشرة أسئلة مع إجاباتها عن هذه الملاحظات.", en: "I want ten questions with answers about these notes." },
    ],
  },
  {
    manifestVersion: V,
    id: "document-qa",
    version: "1.0.0",
    source: "builtin",
    category: "research",
    name: { ar: "سؤال وجواب عن المستندات", en: "Document Q&A" },
    summary: {
      ar: "يجيب عن أسئلةٍ من ملفات المكتبة مع الاستشهاد بالموضع — يحتاج قراءة الملفات.",
      en: "Answers questions from your library files with citations to the passage — needs file access.",
    },
    description: {
      ar: "يستعلم عن محتوى ملفات المكتبة ويجيب بالاستناد إلى مقاطعها مع ذكر الملف والموضع لكل إجابة، ويقول صراحةً حين لا يجد الإجابة في الملفات. يعتمد على صلاحية قراءة ملفات المكتبة، وهي غير مفعّلة في هذا الإصدار؛ ولذلك تبقى تعليماته للقراءة، ويمكن استخدام إرفاق الملفات في المحادثة حتى تُبنى.",
      en: "Queries the content of your library files and answers from their passages, naming the file and the passage for every answer, and says plainly when the answer is not in the files. It relies on the library file-read capability, which is not enabled in this version; its instructions remain readable, and attaching files in the chat covers the need until it is built.",
    },
    instructions: {
      ar: "أجب عن سؤالي اعتمادًا على المستندات المرفقة فقط:\n- لكل معلومة: اذكر اسم الملف والصفحة أو المقطع الذي أُخذت منه.\n- إن لم تجد الإجابة في المستندات فقل ذلك صراحةً ولا تخمّن.\n- إن تعارضت المستندات فاذكر التعارض بمواضعه.\n- أجب أولًا باختصار، ثم التفاصيل والاستشهادات.\n\nالسؤال:",
      en: "Answer my question using only the attached documents:\n- For every fact, name the file and the page or passage it came from.\n- If the answer is not in the documents, say so plainly and do not guess.\n- If the documents disagree, state the disagreement with its locations.\n- Answer briefly first, then the details and citations.\n\nQuestion:",
    },
    capabilities: ["prompt.template", "files.read"],
    tags: ["documents", "citations", "library"],
    examples: [
      { ar: "ما شروط الإلغاء المذكورة في العقد المرفق؟", en: "What cancellation terms does the attached contract state?" },
      { ar: "قارن الأرقام بين التقريرين المرفقين.", en: "Compare the figures between the two attached reports." },
    ],
  },
  {
    manifestVersion: V,
    id: "web-research-brief",
    version: "1.0.0",
    source: "builtin",
    category: "research",
    name: { ar: "موجز بحث من الويب", en: "Web research brief" },
    summary: {
      ar: "يجمع موجزًا عن موضوعٍ من مصادر الويب مع روابط وتواريخ — يحتاج الوصول إلى الويب.",
      en: "Compiles a brief on a topic from web sources with links and dates — needs web access.",
    },
    description: {
      ar: "موجز بحثٍ منظّم: تعريف الموضوع، وأهمّ ما نُشر عنه مع رابط وتاريخ لكل مصدر، والنقاط المتفق عليها والمختلف فيها. يعتمد على صلاحية الوصول إلى الويب، وهي غير مفعّلة في هذا الإصدار؛ فتبقى تعليماته للقراءة ليُستخدم حين تُبنى، أو بإلصاق المصادر في المحادثة.",
      en: "A structured research brief: a definition of the topic, the most relevant publications with a link and date per source, and the points of agreement and disagreement. It relies on the web-access capability, which is not enabled in this version; its instructions remain readable for when it is built, or for use with sources pasted into the chat.",
    },
    instructions: {
      ar: "اكتب موجز بحثٍ عن الموضوع التالي اعتمادًا على المصادر المتاحة لك:\n1. تعريفٌ في فقرة.\n2. أهمّ 5 نقاط مع ذكر المصدر (العنوان، الرابط، التاريخ) لكل نقطة.\n3. ما يتفق عليه معظم المصادر، وما يختلفون فيه.\n4. ما لم تجد له مصدرًا موثوقًا اذكره كـ«غير مؤكّد».\n5. لا تذكر رابطًا لم تطّلع عليه فعلًا.\n\nالموضوع:",
      en: "Write a research brief on the following topic using the sources available to you:\n1. A one-paragraph definition.\n2. The 5 most important points, each with its source (title, link, date).\n3. What most sources agree on, and where they differ.\n4. Mark anything without a reliable source as \"unverified\".\n5. Never cite a link you did not actually read.\n\nTopic:",
    },
    capabilities: ["prompt.template", "web.fetch"],
    tags: ["research", "sources", "web"],
    examples: [
      { ar: "اكتب موجزًا عن أحدث ما نُشر عن مكافحة التصحّر في المنطقة.", en: "Write a brief on the latest publications about desertification control in the region." },
      { ar: "ما أبرز الآراء حول هذا الموضوع، ومن يقول ماذا؟", en: "What are the main views on this topic, and who says what?" },
    ],
  },
];
