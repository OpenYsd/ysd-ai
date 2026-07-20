/**
 * اختبارات حارس اللغة — تمنع رجوع خليط Cyrillic/CJK في إجابة عربية.
 * تعمل دائمًا ضمن npm test (لا تحتاج شبكة).
 */
import { describe, it, expect } from "vitest";
import {
  dedupeContinuation,
  detectExpectedLanguage,
  findStrayLatinWords,
  scriptRatios,
  stripRepeatedPrefix,
  takeCompleteUnits,
  violatesLanguage,
  violatesStreamUnit,
} from "../lib/ai/language-guard";

const AR_Q = "اشرح الفرق بين API وقاعدة البيانات بالعربية.";
const EN_Q = "Write a short introduction in English.";

describe("detectExpectedLanguage", () => {
  it("يكتشف العربية", () => {
    expect(detectExpectedLanguage(AR_Q)).toBe("ar");
  });
  it("يكتشف غير العربية", () => {
    expect(detectExpectedLanguage(EN_Q)).toBe("other");
  });
});

describe("violatesLanguage — إجابة عربية", () => {
  const cleanArabic =
    "الواجهة البرمجية API هي وسيط يسمح للتطبيقات بالتواصل فيما بينها، بينما قاعدة البيانات هي مخزن منظم للبيانات. تستخدم التطبيقات الواجهة البرمجية للوصول إلى البيانات المخزنة في قاعدة البيانات بطريقة آمنة ومنظمة، دون كشف التفاصيل الداخلية للتخزين.";

  it("عربية نظيفة تمر", () => {
    expect(violatesLanguage(cleanArabic, "ar", AR_Q).violated).toBe(false);
  });

  it("خليط عربي وروسي يُرفض", () => {
    const mixed =
      "الواجهة البرمجية Иван Петрович Сидоров является программистом هي وسيط بين التطبيقات Создание базы данных требует планирования и анализа требований для системы.";
    const v = violatesLanguage(mixed, "ar", AR_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unwanted_scripts");
  });

  it("خليط عربي وصيني يُرفض", () => {
    const mixed =
      "قاعدة البيانات 数据库是存储数据的系统，它可以帮助我们管理信息 هي مخزن منظم 应用程序接口允许不同的软件系统相互通信和交换数据。";
    const v = violatesLanguage(mixed, "ar", AR_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unwanted_scripts");
  });

  it("رد إسباني/لاتيني بالكامل على سؤال عربي يُرفض", () => {
    const spanish =
      "Una API es una interfaz de programación de aplicaciones que permite la comunicación entre sistemas, mientras que una base de datos es un almacén organizado de información estructurada para las aplicaciones modernas.";
    const v = violatesLanguage(spanish, "ar", AR_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("wrong_language");
  });

  it("عربية مع مصطلحات تقنية لاتينية تمر", () => {
    const withTech =
      "لبناء تطبيق حديث نستخدم Next.js مع TypeScript وقاعدة بيانات PostgreSQL عبر Supabase، وتُدار الجلسات بواسطة Auth مع سياسات RLS لحماية البيانات، وهذا النمط شائع في تطبيقات الويب الحديثة.";
    expect(violatesLanguage(withTech, "ar", AR_Q).violated).toBe(false);
  });

  it("عربية تبدأ بكتلة كود لا تُرفض", () => {
    const withCode =
      "```js\nconst db = require('pg');\nconst client = new db.Client();\nawait client.connect();\n```\nهذا مثال على الاتصال بقاعدة البيانات من خلال مكتبة جاهزة، حيث ننشئ عميلًا ثم نفتح الاتصال.";
    expect(violatesLanguage(withCode, "ar", AR_Q).violated).toBe(false);
  });
});

describe("violatesLanguage — إجابة إنجليزية", () => {
  it("إنجليزية نظيفة تمر", () => {
    const clean =
      "An API is an application programming interface that allows systems to communicate, while a database is an organized store of structured information used by modern applications every day.";
    expect(violatesLanguage(clean, "other", EN_Q).violated).toBe(false);
  });

  it("إنجليزية مع CJK تُرفض", () => {
    const mixed =
      "An API is an interface 应用程序接口是软件系统之间通信的桥梁，它定义了交互规则 while a database stores data 数据库用于存储和管理大量结构化信息。";
    const v = violatesLanguage(mixed, "other", EN_Q);
    expect(v.violated).toBe(true);
  });

  it("لو كتب المستخدم بالروسية فالسيريلية مسموحة", () => {
    const ruQ = "Объясни разницу между API и базой данных.";
    const ruA =
      "API это интерфейс программирования приложений который позволяет системам обмениваться данными, а база данных это организованное хранилище структурированной информации для приложений.";
    expect(violatesLanguage(ruA, "other", ruQ).violated).toBe(false);
  });
});

describe("scriptRatios", () => {
  it("يستثني الأكواد من الإحصاء", () => {
    const text = "مرحبا `const x = 1;` بالعالم";
    const r = scriptRatios(text);
    expect(r.latin).toBe(0);
    expect(r.arabic).toBeGreaterThan(0);
  });
});

// ── v0.6.5 RC2: تشديد حارس اللغة على الرد العربي ──────────────────────────
const AR_STORY_Q = "اكتب مشهد معركة قصير في رواية خيالية عن فارس وتنين.";

describe("★ RC2 — تحمّل صفري لأنظمة الكتابة غير المطلوبة داخل رد عربي", () => {
  it("كلمة يابانية واحدة داخل رد عربي تُكتشف (كانت تنجو من عتبة 5٪)", () => {
    const reply =
      "في قلب الوادي رفع الفارس 目を سيفه اللامع وواجه التنين بشجاعة نادرة في أرض المعركة الواسعة.";
    const v = violatesLanguage(reply, "ar", AR_STORY_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unwanted_scripts");
  });

  it("كلمة سيريلية واحدة داخل رد عربي تُكتشف", () => {
    const reply =
      "صمد الفارس словно الأسد أمام نيران التنين المتقدة في تلك المعركة الطويلة الحاسمة الفاصلة.";
    const v = violatesLanguage(reply, "ar", AR_STORY_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unwanted_scripts");
  });

  it("حرف يوناني داخل رد عربي يُكتشف", () => {
    const reply =
      "قيمة الزاوية تساوي π تقريبًا في هذه المعادلة الرياضية الطويلة المعقدة التي نناقشها الآن بالتفصيل.";
    const v = violatesLanguage(reply, "ar", "اشرح لي المعادلة بالعربية.");
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("unwanted_scripts");
  });
});

describe("★ RC2 — كشف الكلمات اللاتينية الصغيرة الدخيلة (loot، bajo)", () => {
  it("كلمة إسبانية صغيرة (bajo) داخل رد عربي تُكتشف", () => {
    const reply =
      "صرخ الفارس bajo هدير اللهب لكنه صمد وواصل القتال حتى النهاية المريرة في تلك الليلة الطويلة.";
    const v = violatesLanguage(reply, "ar", AR_STORY_Q);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("stray_latin");
  });

  it("كلمة إنجليزية صغيرة ملتصقة (كغرضloot) تُكتشف", () => {
    const reply =
      "عند موت العدو سيُسقط القناع الأبيض كغرضloot يمكنك التقاطه بسهولة تامة ثم تجهيزه في خانة الدرع.";
    const v = violatesLanguage(reply, "ar", "كيف أحصل على القناع؟");
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("stray_latin");
  });
});

describe("★ RC3 — وحدات الجمل وفحصها", () => {
  it("takeCompleteUnits: يقتطع حتى نهاية الجملة ويحفظ الباقي", () => {
    const r = takeCompleteUnits("وقف الفارس. لمع سيفه تحت");
    expect(r.ready).toBe("وقف الفارس. ");
    expect(r.rest).toBe("لمع سيفه تحت");
    expect(r.ready + r.rest).toBe("وقف الفارس. لمع سيفه تحت"); // بلا فقد حرف
  });

  it("takeCompleteUnits: بلا نهاية جملة ودون الحد الآمن → لا شيء جاهز", () => {
    expect(takeCompleteUnits("نص قصير بلا نهاية").ready).toBe("");
  });

  it("★ جملة قصيرة فيها كلمة دخيلة تُكتشف (الحدّ الأدنى كان يُنجيها)", () => {
    const unit = "صرخ bajo هناك.";
    // الفحص الكامل يتجاهلها لقصرها، وفحص الوحدة يمسكها
    expect(violatesLanguage(unit, "ar", "اكتب قصة").violated).toBe(false);
    const v = violatesStreamUnit(unit, "ar", "اكتب قصة");
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("stray_latin");
  });

  it("★ جملة قصيرة نظيفة فيها اسم علم إنجليزي تمرّ", () => {
    expect(violatesStreamUnit("جرّب White Mask.", "ar", "سؤال").violated).toBe(false);
    expect(violatesStreamUnit("افتح ملف PDF.", "ar", "سؤال").violated).toBe(false);
  });

  it("stripRepeatedPrefix: يزيل ما أُعيد من النص المعروض", () => {
    const emitted = "وقف الفارس أمام التنين. لمع سيفه تحت ضوء الفجر. ";
    expect(stripRepeatedPrefix(emitted, "لمع سيفه تحت ضوء الفجر. ثم صمد أمام اللهب الحارق.")).toBe(
      "ثم صمد أمام اللهب الحارق.",
    );
    // بلا تكرار يبقى كما هو
    expect(stripRepeatedPrefix(emitted, "ثم صمد أمام اللهب الحارق.")).toBe(
      "ثم صمد أمام اللهب الحارق.",
    );
  });
});

// ── v0.6.5 RC4: تنقية التكملة على مستوى الكلمات ───────────────────────────
describe("★ RC4 — dedupeContinuation يمنع تكرار المتابعة", () => {
  const EMITTED =
    "وقف الفارس أمام التنين الضخم. لمع سيفه تحت ضوء الفجر الباهت.\n\n" +
    "اندفع نحو الوحش وضرب الحراشف الصلبة بكل قوته.\n\n";
  const NEW_PART = "ثم سقط التنين أرضًا وساد الصمت في الوادي.";

  it("★ إعادة النص كاملًا حرفيًا ثم تكملة → يبقى الجديد فقط", () => {
    const d = dedupeContinuation(EMITTED, EMITTED + NEW_PART);
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ إعادة النص كاملًا باختلاف المسافات والأسطر → يبقى الجديد فقط", () => {
    const messy = EMITTED.replace(/\s+/g, " ").replace(/\. /g, ".\n") + NEW_PART;
    const d = dedupeContinuation(EMITTED, messy);
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ إعادة البداية باختلاف علامات الترقيم والتشكيل → يبقى الجديد فقط", () => {
    const repunct =
      "وقفَ الفارس أمام التنين الضخم، لمع سيفه تحت ضوء الفجر الباهت! " +
      "اندفع نحو الوحش وضرب الحراشف الصلبة بكل قوته… " +
      NEW_PART;
    const d = dedupeContinuation(EMITTED, repunct);
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ إعادة آخر فقرة فقط → تُقتطع ويبقى الجديد", () => {
    const d = dedupeContinuation(
      EMITTED,
      "اندفع نحو الوحش وضرب الحراشف الصلبة بكل قوته. " + NEW_PART,
    );
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ تداخل آخر جملة مع بداية التكملة → يُقتطع التداخل", () => {
    const d = dedupeContinuation(EMITTED, "وضرب الحراشف الصلبة بكل قوته. " + NEW_PART);
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ تكملة جديدة صحيحة لا تُحذف", () => {
    const d = dedupeContinuation(EMITTED, NEW_PART);
    expect(d.ok).toBe(true);
    expect(d.text).toBe(NEW_PART);
  });

  it("★ تكملة مكررة بالكامل بلا جديد → تُرفض", () => {
    const d = dedupeContinuation(EMITTED, EMITTED);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("no_new");
    expect(d.text).toBe("");
  });

  it("★ تكملة أغلبها تكرار مبعثر → تُرفض بشبكة الأمان", () => {
    // لا تبدأ بإعادة صريحة، لكنها تعيد فقرة كاملة من المعروض
    const d = dedupeContinuation(EMITTED, "وبعد لحظة، اندفع نحو الوحش وضرب الحراشف الصلبة بكل قوته.");
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("duplicate");
  });

  it("لا يتكرر أي مقطع في الناتج النهائي", () => {
    const d = dedupeContinuation(EMITTED, EMITTED + NEW_PART);
    const finalText = EMITTED + d.text;
    const countOf = (h: string, n: string) => h.split(n).length - 1;
    expect(countOf(finalText, "وقف الفارس أمام التنين")).toBe(1);
    expect(countOf(finalText, "اندفع نحو الوحش")).toBe(1);
    expect(countOf(finalText, "لمع سيفه")).toBe(1);
  });
});

describe("★ RC2 — أسماء العلم والاختصارات لا تُرفض", () => {
  it("White Mask وElden Ring داخل رد عربي تمرّ", () => {
    const reply =
      "القناع الأبيض White Mask في لعبة Elden Ring يمنحك ضررًا إضافيًا عند تراكم النزف الذاتي، وهو درع رأس مفيد لبنية النزف.";
    expect(violatesLanguage(reply, "ar", "أخبرني عن القناع الأبيض في اللعبة.").violated).toBe(false);
  });

  it("اختصارات AI وPDF وRAG داخل رد عربي تمرّ", () => {
    const reply =
      "يستخدم النظام تقنيات AI لتحليل ملفات PDF عبر خط أنابيب RAG، ثم يعرض النتائج للمستخدم بشكل منظم وواضح.";
    expect(violatesLanguage(reply, "ar", "اشرح كيف يعمل النظام.").violated).toBe(false);
  });

  it("findStrayLatinWords: يلتقط الدخيل ويترك أسماء العلم والاختصارات", () => {
    expect(findStrayLatinWords("نص فيه loot و bajo دخيلان")).toEqual(["loot", "bajo"]);
    expect(findStrayLatinWords("White Mask و Elden Ring و PostgreSQL")).toEqual([]);
    expect(findStrayLatinWords("نستخدم AI و PDF و RAG هنا")).toEqual([]);
    expect(findStrayLatinWords("رابط https://example.com/loot ليس دخيلًا")).toEqual([]);
  });
});
