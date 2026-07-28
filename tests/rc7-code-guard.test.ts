import { describe, it, expect } from "vitest";
import {
  violatesStreamUnit,
  violatesLanguage,
  stripCodeAware,
  endsInsideCodeFence,
  endsWithCompleteSentence,
  shouldAppendTruncatedNotice,
  isCodeRequest,
} from "../lib/ai/language-guard";

/**
 * v0.7.0 RC7 — حارس اللغة لا يفحص الكود كأنه نثر عربي.
 *
 * السبب الجذري المُثبت قبل الإصلاح: أثناء البثّ تُفحص كل جملة على حدة، وسطر
 * الكود لا يحمل سياجه معه، فكان `const [count, setCount] = useState(0);`
 * يُقرأ نثرًا عربيًا فيه كلمات لاتينية دخيلة → stray_latin → قطع الرد.
 * وثانيًا: الرد المنتهي بسياج ``` لم يكن «جملة مكتملة» فتُلحق به عبارة الجودة.
 */

const CODE_UNITS = [
  "export function calculateTotal(items: CartItem[]): number {",
  "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
  "def fetch_user(user_id: str) -> dict:",
  "    response.raise_for_status()",
  "select user_id, count(*) as total from messages group by user_id;",
  "  const [count, setCount] = useState(0);",
  "for f in *.log; do gzip \"$f\"; done",
  '  "compilerOptions": { "strict": true, "target": "ES2022" }',
  "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
];

describe("★ RC7: الكود داخل السياج لا يُفحص كنثر", () => {
  for (const unit of CODE_UNITS) {
    it(`لا مخالفة: ${unit.trim().slice(0, 46)}`, () => {
      const v = violatesStreamUnit(unit, "ar", "اكتب لي كودًا", true);
      expect(v.violated).toBe(false);
    });
  }

  it("★ سطر كود خارج السياج مع الحالة المتتبَّعة لا يُقطع", () => {
    // الوحدة تفتح السياج ثم تحوي كودًا — الحالة تتقدّم داخل الوحدة نفسها
    const unit = "```ts\nconst greeting = buildGreeting(user);";
    expect(violatesStreamUnit(unit, "ar", "اكتب كودًا", false).violated).toBe(false);
  });
});

describe("★ RC7: تتبّع حالة السياج", () => {
  it("يكشف السياج المفتوح", () => {
    expect(endsInsideCodeFence("نص\n```ts\nconst a = 1;")).toBe(true);
    expect(endsInsideCodeFence("نص\n```ts\nconst a = 1;\n```")).toBe(false);
  });

  it("يجرّد ما بداخل السياج ويُبقي النثر", () => {
    const { prose, endsInsideCode } = stripCodeAware(
      "الشرح هنا\n```js\nconst bajo = 1;\n```\nوخاتمة عربية.",
      false,
    );
    expect(prose).toContain("الشرح هنا");
    expect(prose).toContain("وخاتمة عربية.");
    expect(prose).not.toContain("bajo");
    expect(endsInsideCode).toBe(false);
  });

  it("يجرّد الكود المضمّن `…` أيضًا", () => {
    const { prose } = stripCodeAware("استخدم `npm run build` هنا.", false);
    expect(prose).not.toContain("npm run build");
    expect(prose).toContain("استخدم");
  });
});

describe("★ RC7: التداخل لا يقلب حالة السياج مرتين", () => {
  /**
   * رُصد حيًّا: 3 من 8 طلبات كود ظلّت تُقطع بعد الإصلاح الأول. السبب أن الفحص
   * يُعيد تمرير ذيل ما عُرض (overlap) مع الوحدة الجديدة، فإن وقع السياج داخل
   * الذيل حُسب مرّة ثانية فانقلبت الحالة وصار جوف الكتلة «نثرًا».
   * الحالة الصحيحة تُشتقّ من النص السابق للتداخل.
   */
  it("★ سياج داخل التداخل: الحالة تبقى «داخل الكود»", () => {
    const emitted = "إليك السكربت:\n\n```bash\n";
    const overlap = emitted.slice(-24); // يحوي ```bash
    const beforeOverlap = emitted.slice(0, emitted.length - overlap.length);
    const insideAtOverlapStart = endsInsideCodeFence(beforeOverlap);
    const unit = "for f in *.log; do gzip \"$f\"; done";
    expect(
      violatesStreamUnit(overlap + unit, "ar", "اكتب سكربت", insideAtOverlapStart).violated,
    ).toBe(false);
  });

  it("★ الاشتقاق يعطي الحالة نفسها مهما وقع السياج", () => {
    // قبل التداخل لا سياج ⇒ خارج الكود؛ والسياج داخل التداخل ينقل إلى الداخل
    expect(endsInsideCodeFence("إليك السكربت:\n\n")).toBe(false);
    expect(endsInsideCodeFence("إليك السكربت:\n\n```bash\n")).toBe(true);
  });
});

describe("★ RC7 بوابة Bash: مصطلح تقني مفرد خارج السياج مقبول", () => {
  const ASK = "اكتب سكربت Bash يضغط ملفات .log";
  expect(isCodeRequest(ASK)).toBe(true);

  const TECH = [
    "gzip", "curl", "chmod", "grep", "awk", "sed", "docker", "npm", "pip",
    "TypeScript", "useState", "package.json", "src/app/page.tsx", "--force", "HTTP 429",
  ];
  for (const term of TECH) {
    it(`يمرّ: «${term}» داخل نثر عربي`, () => {
      const unit = `استخدم ${term} لتنفيذ المطلوب هنا.`;
      expect(violatesStreamUnit(unit, "ar", ASK, false).violated).toBe(false);
    });
  }

  it("★ مصطلحان تقنيان في جملتين لا يُعدّان تسلسلًا", () => {
    const unit = "نستخدم gzip للضغط ثم curl للرفع.";
    expect(violatesStreamUnit(unit, "ar", ASK, false).violated).toBe(false);
  });
});

describe("★ RC7 بوابة Bash: الجمل الأجنبية ما زالت تُمنع في الوضع البرمجي", () => {
  const ASK = "اكتب سكربت Bash يضغط ملفات .log";
  const BLOCKED: [string, string][] = [
    ["إسباني", "ثم قال bajo el sol وانتهى الأمر."],
    ["إسباني قصير", "وقال hola amigo في النهاية."],
    ["إنجليزي طبيعي", "ثم كتب this is an unrelated english sentence هنا."],
  ];
  for (const [name, text] of BLOCKED) {
    it(`★ يُمنع ${name} حتى في طلب برمجي`, () => {
      expect(violatesStreamUnit(text, "ar", ASK, false).violated).toBe(true);
    });
  }

  const SCRIPTS: [string, string][] = [
    ["سيريلي", "هذا شرح للموضوع привет كامل هنا."],
    ["صيني", "النتيجة كانت 你好 جيدة جدًا."],
    ["ياباني", "النتيجة كانت こんにちは جيدة."],
    ["يوناني", "الرمز هو Ω καλημέρα هنا."],
  ];
  for (const [name, text] of SCRIPTS) {
    it(`★ ${name} ممنوع بتحمّل صفري حتى في طلب برمجي`, () => {
      expect(violatesStreamUnit(text, "ar", ASK, false).violated).toBe(true);
    });
  }
});

describe("★ RC7: تصنيف طلب الكود عام لا خاص بلغة", () => {
  const YES = [
    "اكتب سكربت Bash يضغط ملفات .log",
    "اشرح لي هذا الخطأ TS2345",
    "راجع دالة Python التالية",
    "ما معنى `npm install` هنا؟",
    "صحح استعلام SQL هذا",
    "اكتب مكوّن React لعدّاد",
  ];
  for (const q of YES) {
    it(`برمجي: ${q.slice(0, 34)}`, () => expect(isCodeRequest(q)).toBe(true));
  }

  const NO = [
    "ما رأيك في الطقس اليوم؟",
    "احكِ لي قصة قصيرة عن البحر",
    "من هو بطل لعبة White Mask؟",
    "اشرح لي تاريخ الأندلس باختصار",
  ];
  for (const q of NO) {
    it(`غير برمجي: ${q.slice(0, 34)}`, () => expect(isCodeRequest(q)).toBe(false));
  }

  it("★ الوضع غير البرمجي لم يتغيّر سلوكه إطلاقًا", () => {
    // كلمة دخيلة مفردة تبقى مخالفة خارج سياق الكود
    expect(violatesStreamUnit("وقال loot في اللعبة.", "ar", "احكِ قصة", false).violated).toBe(
      true,
    );
  });
});

describe("★ RC7: الحراس اللغوية لم تضعف على النثر", () => {
  const leaks: [string, string][] = [
    ["إسباني", "صرخ الرجل bajo el sol وانطلق بعيدًا."],
    ["سيريلي", "هذا شرح مفصل للموضوع привет كامل هنا."],
    ["صيني", "النتيجة كانت جيدة 你好 جدًا في هذا الاختبار."],
  ];
  for (const [name, text] of leaks) {
    it(`★ ما زال يمنع التسريب ${name}`, () => {
      expect(violatesStreamUnit(text, "ar", "اشرح لي", false).violated).toBe(true);
    });
  }

  it("★ التسريب داخل نثر بعد كتلة كود مغلقة يُمنع", () => {
    const unit = "```js\nconst a = 1;\n```\nثم قال bajo el sol وانتهى.";
    expect(violatesStreamUnit(unit, "ar", "اكتب كودًا", false).violated).toBe(true);
  });

  it("النثر العربي السليم يمرّ", () => {
    expect(
      violatesStreamUnit("هذا شرح عربي سليم تمامًا بلا أي تسريب.", "ar", "اشرح", false).violated,
    ).toBe(false);
  });

  it("شرح الكود بالعربية مع كلمة محجوزة يمرّ", () => {
    expect(
      violatesStreamUnit("استخدم const بدل let لأن القيمة ثابتة.", "ar", "اشرح", false).violated,
    ).toBe(false);
  });
});

describe("★ RC7: عبارة الجودة لا تُلحق برد برمجي سليم", () => {
  const SQL = "الاستعلام المطلوب:\n\n```sql\nselect id from messages;\n```";
  const REACT =
    "مكوّن React:\n\n```tsx\nexport default function C() { return <b>1</b>; }\n```";

  it("الرد المنتهي بسياج مغلق = جملة مكتملة", () => {
    expect(endsWithCompleteSentence(SQL)).toBe(true);
    expect(endsWithCompleteSentence(REACT)).toBe(true);
  });

  it("★ بلا عبارة «توقفت هنا للحفاظ على جودة الرد»", () => {
    expect(shouldAppendTruncatedNotice(SQL)).toBe(false);
    expect(shouldAppendTruncatedNotice(REACT)).toBe(false);
  });

  it("السياج المفتوح (رد مبتور فعلًا) ما زال يستحق العبارة", () => {
    const cut = "إليك الحل:\n\n```ts\nexport function calc(items: Item[]): number {";
    expect(endsWithCompleteSentence(cut)).toBe(false);
    expect(shouldAppendTruncatedNotice(cut)).toBe(true);
  });

  it("النثر المبتور ما زال يستحق العبارة", () => {
    const cut = "هذا شرح طويل ومفيد جدًا عن الموضوع المطلوب لكنه انقطع فجأة عند";
    expect(shouldAppendTruncatedNotice(cut)).toBe(true);
  });
});

describe("★ RC7: الرد الكامل البرمجي لا يخالف اللغة", () => {
  it("رد TypeScript كامل", () => {
    const reply =
      "إليك الدالة:\n\n```ts\nexport function total(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n```\n\nتُرجع المجموع.";
    expect(violatesLanguage(reply, "ar", "اكتب دالة TypeScript").violated).toBe(false);
  });
});
