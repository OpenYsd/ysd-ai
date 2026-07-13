/**
 * اختبارات حارس اللغة — تمنع رجوع خليط Cyrillic/CJK في إجابة عربية.
 * تعمل دائمًا ضمن npm test (لا تحتاج شبكة).
 */
import { describe, it, expect } from "vitest";
import {
  detectExpectedLanguage,
  scriptRatios,
  violatesLanguage,
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
