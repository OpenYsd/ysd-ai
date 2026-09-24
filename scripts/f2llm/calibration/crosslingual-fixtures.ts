/** Bilingual long documents + questions for crosslingual-eval.ts (synthetic; no real person or organization). */

const CV = [
  "RASHED AL-QAMARI - CURRICULUM VITAE",
  "Riyadh, Saudi Arabia | rashed.alqamari@example.test | +966 50 000 0000",
  "",
  "PROFESSIONAL SUMMARY",
  "Senior platform engineer with twelve years of experience building reliable cloud systems for healthcare and",
  "logistics. Comfortable leading small teams, owning on-call rotations, and translating clinical requirements into",
  "operational software. Known for pragmatic migrations and for writing runbooks that other teams actually use.",
  "",
  "EXPERIENCE",
  "Lead Platform Engineer, Najd Health Network, Riyadh (2020 - present)",
  "- Designed the multi-region Kubernetes platform that hosts forty clinical applications.",
  "- In 2021 he led Project Blue Heron, which cut outpatient waiting times by 37 percent across six hospitals.",
  "- Introduced service-level objectives and an incident review process adopted by three departments.",
  "- Mentored seven engineers, four of whom were promoted within two years.",
  "Senior DevOps Engineer, Gulf Freight Systems, Dammam (2016 - 2020)",
  "- Migrated the container tracking platform from on-premise servers to a managed cloud provider.",
  "- Reduced monthly infrastructure spending by roughly a quarter through rightsizing and reserved capacity.",
  "- Built the internal deployment tool that shortened releases from two days to under an hour.",
  "Systems Administrator, Eastern Province University, Dhahran (2012 - 2016)",
  "- Maintained the student information system and the campus identity service.",
  "- Automated account provisioning for eleven thousand students with a small set of scripts.",
  "",
  "EDUCATION",
  "Master of Science in Computer Engineering, King Fahd University (2014)",
  "Thesis: adaptive triage queues for emergency departments under variable load.",
  "Bachelor of Science in Computer Science, King Saud University (2011)",
  "",
  "CERTIFICATIONS",
  "Certified Kubernetes Administrator (CKA) since March 2019.",
  "Professional Cloud Architect, renewed in 2023.",
  "Information security foundations, 2017.",
  "",
  "SKILLS",
  "Kubernetes, Terraform, Go, Python, PostgreSQL, observability with Prometheus and Grafana, incident command,",
  "capacity planning, disaster recovery testing, technical writing, stakeholder communication.",
  "",
  "LANGUAGES",
  "Arabic (native), English (fluent), Turkish (basic).",
  "",
  "EMPLOYMENT DETAILS",
  "Employee badge number: QX-7741-ZETA. Notice period: sixty days. Available for relocation within the GCC.",
  "",
  "VOLUNTEERING",
  "Teaches an evening course on Linux fundamentals at a community center in Riyadh.",
  "Organizes a yearly hackathon focused on accessibility tools for Arabic speakers.",
  "",
  "REFERENCES",
  "Available on request.",
];
const CITIES = ["Jeddah", "Abha", "Tabuk", "Hail", "Jazan", "Najran", "Qassim", "Madinah", "Taif", "Khobar", "Yanbu", "Sakaka"];
const APPENDIX: string[] = [];
CITIES.forEach((city, i) => {
  APPENDIX.push(
    "",
    `APPENDIX PROJECT ${i + 1}: ${city} clinic network rollout`,
    `The ${city} rollout connected ${8 + i} clinics to the regional scheduling platform over ${3 + (i % 5)} months.`,
    "The team migrated legacy appointment records, trained front-desk staff, and ran two failover drills.",
    "Budget and staffing followed the standard regional template; no major incidents were recorded.",
    "Lessons learned focused on network links in remote sites and on printing patient labels offline.",
  );
});
APPENDIX.splice(40, 0, "", "APPENDIX NOTE: the Tabuk data center lease was renegotiated in 2022 and the final annual rent is 1,284,000 riyals.");
export const EN_DOC = [...CV, ...APPENDIX].join("\n");

const BRANCHES = ["الهفوف", "المبرز", "القطيف", "الجبيل", "الخفجي", "بقيق", "العيون", "الجفر", "الطرف", "القارة", "الشقيق", "المنيزلة"];
const AR_HEAD = [
  "التقرير السنوي لجمعية البر الأهلية لعام ١٤٤٥هـ",
  "",
  "مقدمة",
  "يسرّ الجمعية أن تقدّم تقريرها السنوي الذي يستعرض البرامج والمشاريع التي نُفّذت خلال العام، والتحديات التي واجهتها، وخطط العام المقبل.",
  "وقد حرصت الجمعية على توسيع خدماتها في المدن والقرى، وتحسين جودة الإجراءات، وتعزيز الشفافية مع المانحين والمستفيدين.",
  "",
  "مجلس الإدارة",
  "ترأست مجلس الإدارة هذا العام الدكتورة نورة بنت سعد الشهري، وعقد المجلس تسعة اجتماعات دورية واجتماعين استثنائيين.",
  "واعتمد المجلس لائحة جديدة لتضارب المصالح، وشكّل لجنة للمراجعة الداخلية تتبع المجلس مباشرة.",
  "",
  "برنامج الإسكان الميسّر",
  "بلغ عدد الأسر المستفيدة من برنامج الإسكان الميسّر 4318 أسرة، أغلبها من الأسر التي تعولها نساء.",
  "وشمل البرنامج ترميم المساكن القديمة وتأثيثها، ودفع جزء من الإيجارات المتأخرة للأسر الأشد حاجة.",
  "",
  "مشروع تحلية المياه",
  "أنجزت الجمعية محطة صغيرة لتحلية المياه في القرية الشمالية، وبلغت كلفتها الإجمالية 2.7 مليون ريال بتمويل مشترك مع أحد البنوك.",
  "وتنتج المحطة ما يكفي حاجة ثلاثمائة منزل، وتُدار بعقد صيانة مدته خمس سنوات.",
  "",
  "التدريب المهني",
  "افتُتح مركز التدريب المهني في حي الروضة في شهر رجب، ويقدّم دورات في الكهرباء والسباكة والتصميم الرقمي.",
  "وتخرّج من الدفعة الأولى مئة وأربعون متدربًا حصل أغلبهم على فرص عمل خلال ثلاثة أشهر.",
  "",
  "الحوكمة والشفافية",
  "رمز الاعتماد الداخلي لهذا التقرير هو ع-٩٠٤-نخيل، ويُذكر في جميع المراسلات مع الجهات الرقابية.",
  "وبلغت نسبة الإنفاق الإداري 11 بالمئة من إجمالي المصروفات، وهي أدنى نسبة منذ تأسيس الجمعية.",
  "",
  "التطوع",
  "شارك 612 متطوعًا في حملة الشتاء لتوزيع البطانيات والمدافئ على الأسر في القرى البعيدة.",
  "",
];
const AR_BRANCHES: string[] = [];
BRANCHES.forEach((b, i) => {
  AR_BRANCHES.push(
    `فرع ${b}`,
    `قدّم فرع ${b} خدماته إلى ${150 + i * 17} أسرة خلال العام، وتنوّعت الخدمات بين السلال الغذائية والكسوة والدعم المدرسي.`,
    "وعقد الفرع لقاءات دورية مع المتطوعين، وحدّث قاعدة بيانات المستفيدين، ونسّق مع المدارس والمراكز الصحية القريبة.",
    "ولم تُسجَّل ملاحظات جوهرية في المراجعة الداخلية للفرع، وأوصت اللجنة بتوسيع ساعات العمل في موسم الشتاء.",
    "",
  );
});
export const AR_DOC = [...AR_HEAD, ...AR_BRANCHES].join("\n");

export interface Q {
  group: "ar>en" | "en>ar" | "en>en" | "ar>ar";
  doc: "en" | "ar";
  q: string;
  goldSubstring: string;
  /** ترجمةٌ يدويّة إلى لغة المستند — للحدّ الأعلى لاستراتيجيّة الترجمة */
  translation: string;
}

export const QUESTIONS: Q[] = [
  // Arabic questions about the long English document
  { group: "ar>en", doc: "en", q: "كم خفّض المشروع الذي قاده عام 2021 أوقات الانتظار؟", goldSubstring: "Blue Heron", translation: "By how much did the project he led in 2021 reduce waiting times?" },
  { group: "ar>en", doc: "en", q: "ما رقم الشارة الوظيفية؟", goldSubstring: "QX-7741-ZETA", translation: "What is the employee badge number?" },
  { group: "ar>en", doc: "en", q: "ما الإيجار السنوي النهائي لمركز بيانات تبوك؟", goldSubstring: "1,284,000", translation: "What is the final annual rent of the Tabuk data center?" },
  { group: "ar>en", doc: "en", q: "كم عيادة ربط مشروع حائل؟", goldSubstring: "Hail rollout connected 11", translation: "How many clinics did the Hail rollout connect?" },
  { group: "ar>en", doc: "en", q: "متى حصل على شهادة مسؤول كوبرنيتس المعتمد؟", goldSubstring: "(CKA) since March 2019", translation: "When did he get the Certified Kubernetes Administrator certificate?" },
  { group: "ar>en", doc: "en", q: "ما موضوع رسالة الماجستير؟", goldSubstring: "adaptive triage queues", translation: "What was the topic of his master's thesis?" },
  { group: "ar>en", doc: "en", q: "كم مهندسًا أشرف على تدريبهم؟", goldSubstring: "Mentored seven engineers", translation: "How many engineers did he mentor?" },
  { group: "ar>en", doc: "en", q: "ما مدة فترة الإشعار قبل ترك العمل؟", goldSubstring: "Notice period: sixty days", translation: "How long is his notice period?" },
  { group: "ar>en", doc: "en", q: "أين يقدّم دورة أساسيات لينكس المسائية؟", goldSubstring: "Linux fundamentals", translation: "Where does he teach the evening Linux fundamentals course?" },
  { group: "ar>en", doc: "en", q: "بكم خفّض الإنفاق الشهري على البنية التحتية؟", goldSubstring: "roughly a quarter", translation: "By how much did he reduce monthly infrastructure spending?" },
  { group: "ar>en", doc: "en", q: "ما اللغات التي يتحدثها؟", goldSubstring: "Turkish (basic)", translation: "What languages does he speak?" },
  // English questions about the long Arabic document
  { group: "en>ar", doc: "ar", q: "How many families benefited from the affordable housing program?", goldSubstring: "4318", translation: "كم عدد الأسر المستفيدة من برنامج الإسكان الميسّر؟" },
  { group: "en>ar", doc: "ar", q: "Who chaired the board of directors this year?", goldSubstring: "نورة بنت سعد الشهري", translation: "من ترأس مجلس الإدارة هذا العام؟" },
  { group: "en>ar", doc: "ar", q: "How much did the desalination plant in the northern village cost?", goldSubstring: "2.7 مليون", translation: "كم كلفة محطة تحلية المياه في القرية الشمالية؟" },
  { group: "en>ar", doc: "ar", q: "What is the internal accreditation code of this report?", goldSubstring: "ع-٩٠٤-نخيل", translation: "ما رمز الاعتماد الداخلي لهذا التقرير؟" },
  { group: "en>ar", doc: "ar", q: "What percentage of total expenses was administrative spending?", goldSubstring: "11 بالمئة", translation: "ما نسبة الإنفاق الإداري من إجمالي المصروفات؟" },
  { group: "en>ar", doc: "ar", q: "How many volunteers took part in the winter campaign?", goldSubstring: "612 متطوعًا", translation: "كم متطوعًا شارك في حملة الشتاء؟" },
  { group: "en>ar", doc: "ar", q: "In which neighborhood was the vocational training center opened?", goldSubstring: "حي الروضة", translation: "في أي حي افتُتح مركز التدريب المهني؟" },
  { group: "en>ar", doc: "ar", q: "How many families did the Qatif branch serve?", goldSubstring: "قدّم فرع القطيف خدماته إلى 184", translation: "كم أسرة خدم فرع القطيف؟" },
  // Same-language controls
  { group: "en>en", doc: "en", q: "By how much did the project he led in 2021 reduce waiting times?", goldSubstring: "Blue Heron", translation: "By how much did the project he led in 2021 reduce waiting times?" },
  { group: "en>en", doc: "en", q: "What is the topic of his master's thesis?", goldSubstring: "adaptive triage queues", translation: "What is the topic of his master's thesis?" },
  { group: "en>en", doc: "en", q: "How long is his notice period?", goldSubstring: "Notice period: sixty days", translation: "How long is his notice period?" },
  { group: "en>en", doc: "en", q: "How many engineers did he mentor?", goldSubstring: "Mentored seven engineers", translation: "How many engineers did he mentor?" },
  { group: "ar>ar", doc: "ar", q: "كم عدد الأسر المستفيدة من برنامج الإسكان الميسّر؟", goldSubstring: "4318", translation: "كم عدد الأسر المستفيدة من برنامج الإسكان الميسّر؟" },
  { group: "ar>ar", doc: "ar", q: "من ترأس مجلس الإدارة هذا العام؟", goldSubstring: "نورة بنت سعد الشهري", translation: "من ترأس مجلس الإدارة هذا العام؟" },
  { group: "ar>ar", doc: "ar", q: "ما رمز الاعتماد الداخلي للتقرير؟", goldSubstring: "ع-٩٠٤-نخيل", translation: "ما رمز الاعتماد الداخلي للتقرير؟" },
  { group: "ar>ar", doc: "ar", q: "كم متطوعًا شارك في حملة الشتاء؟", goldSubstring: "612 متطوعًا", translation: "كم متطوعًا شارك في حملة الشتاء؟" },
];
