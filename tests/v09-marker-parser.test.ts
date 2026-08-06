/**
 * مُحلِّل علامات `[[n]]` (v0.9.0 — الإيداع الثاني).
 *
 * وحدة نقيّة، فالاختبارات سلوكية بلا تمويه: مدخل نصّي ⇒ مخرَج متوقَّع.
 *
 * وأخطر ما يُختبر هنا ليس ما يُحوَّل بل **ما لا يُحوَّل**: علامة داخل شيفرة،
 * وعلامة مهروبة، وعلامة مشوّهة. التساهل في أيٍّ منها يعني نسبةَ نصٍّ إلى مصدر
 * لم يقصده النموذج — وهو بالضبط ما جاء Evidence Mode ليمنعه.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_INPUT_CHARS,
  MAX_MARKER_CANDIDATES,
  parseEvidenceMarkers,
} from "../lib/evidence/marker-parser";

const p = parseEvidenceMarkers;

describe("★ العلامات الصحيحة", () => {
  it("★ عربي: علامة واحدة تُزال ويُستخرج رقمها", () => {
    const r = p("ارتفعت الإيرادات 12٪ في الربع الثالث [[1]].");
    expect(r.cleanText).toBe("ارتفعت الإيرادات 12٪ في الربع الثالث.");
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.requestedMarkers).toEqual([1]);
    expect(r.malformedCount).toBe(0);
  });

  it("★ إنجليزي", () => {
    const r = p("Revenue rose 12% in Q3 [[2]].");
    expect(r.cleanText).toBe("Revenue rose 12% in Q3.");
    expect(r.allRequestedMarkers).toEqual([2]);
  });

  it("★ نصّ مختلط RTL/LTR", () => {
    const r = p("حسب تقرير Q3 Revenue Report [[1]] بلغت النسبة 12٪ [[2]].");
    expect(r.cleanText).toBe("حسب تقرير Q3 Revenue Report بلغت النسبة 12٪.");
    expect(r.allRequestedMarkers).toEqual([1, 2]);
  });

  it("★ المدى المقبول 1..99 على الطرفين", () => {
    expect(p("أ [[1]]").allRequestedMarkers).toEqual([1]);
    expect(p("أ [[9]]").allRequestedMarkers).toEqual([9]);
    expect(p("أ [[10]]").allRequestedMarkers).toEqual([10]);
    expect(p("أ [[99]]").allRequestedMarkers).toEqual([99]);
  });

  it("★ العلامة في أول السطر وفي وسطه", () => {
    expect(p("[[1]] نصّ بعدها").cleanText).toBe("نصّ بعدها");
    expect(p("قبل [[1]] بعد").cleanText).toBe("قبل بعد");
  });
});

describe("★ العلامات المتلاصقة والمكرّرة", () => {
  it("★ متلاصقة بلا فراغ: [[1]][[2]]", () => {
    const r = p("جملة [[1]][[2]].");
    expect(r.cleanText).toBe("جملة.");
    expect(r.allRequestedMarkers).toEqual([1, 2]);
  });

  it("★ متلاصقة بفراغ: [[1]] [[2]]", () => {
    const r = p("جملة [[1]] [[2]].");
    expect(r.cleanText).toBe("جملة.");
    expect(r.allRequestedMarkers).toEqual([1, 2]);
  });

  it("★ تكرار الرقم في الفقرة نفسها ⇒ مرة واحدة في القائمة", () => {
    const r = p("أولًا [[1]] وثانيًا [[1]] وثالثًا [[1]].");
    expect(r.segments[0]!.requestedMarkers).toEqual([1]);
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.cleanText).toBe("أولًا وثانيًا وثالثًا.");
  });

  /** الترتيب حسب أول ظهور — لا ترتيب عددي ولا إعادة ترقيم */
  it("★ الترتيب حسب أول ظهور لا حسب القيمة", () => {
    const r = p("أ [[9]] ب [[3]] ج [[9]] د [[1]].");
    expect(r.allRequestedMarkers).toEqual([9, 3, 1]);
  });

  it("★ لا إعادة ترقيم: الأرقام تبقى كما كتبها النموذج", () => {
    const r = p("أ [[7]] ب [[42]].");
    expect(r.allRequestedMarkers).toEqual([7, 42]);
  });
});

describe("★ العلامات المشوّهة — تبقى نصًّا ولا تختفي", () => {
  const BAD = [
    "[[0]]",
    "[[100]]",
    "[[01]]",
    "[[-1]]",
    "[[1.5]]",
    "[[abc]]",
    "[[ 1 ]]",
    "[[1]",
    "[1]]",
    "[[]]",
    "[[1 ]]",
    "[[ 1]]",
  ];

  for (const bad of BAD) {
    it(`★ ${bad} لا يُحوَّل ويبقى ظاهرًا`, () => {
      const r = p(`نصّ ${bad} بعده`);
      expect(r.allRequestedMarkers).toEqual([]);
      expect(r.cleanText).toContain(bad);
    });
  }

  it("★ تُحصى المحاولات المشوّهة", () => {
    const r = p("أ [[0]] ب [[abc]] ج [[100]].");
    expect(r.malformedCount).toBe(3);
    expect(r.allRequestedMarkers).toEqual([]);
  });

  /** `[[` بلا إغلاق قريب ليست محاولةً أصلًا — نصّ عادي */
  it("★ [[ بلا إغلاق لا تُعدّ محاولة", () => {
    const r = p("مصفوفة [[ ثم نصّ طويل جدًّا بلا إغلاق قريب إطلاقًا هنا");
    expect(r.malformedCount).toBe(0);
    expect(r.cleanText).toContain("[[");
  });

  it("★ الصحيح والمشوّه معًا", () => {
    const r = p("صحيح [[1]] ومشوّه [[0]].");
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.malformedCount).toBe(1);
    expect(r.cleanText).toBe("صحيح ومشوّه [[0]].");
  });
});

describe("★ الشيفرة السطرية — لا علامات داخلها", () => {
  it("★ backtick واحد", () => {
    const r = p("استعمل `[[1]]` في الشيفرة.");
    expect(r.allRequestedMarkers).toEqual([]);
    expect(r.cleanText).toBe("استعمل `[[1]]` في الشيفرة.");
  });

  it("★ backtick مزدوج", () => {
    const r = p("انظر ``code [[2]] here`` هنا.");
    expect(r.allRequestedMarkers).toEqual([]);
    expect(r.cleanText).toContain("[[2]]");
  });

  it("★ داخل الشيفرة يُتجاهل وخارجها يُحوَّل — في السطر نفسه", () => {
    const r = p("خارج [[1]] و`داخل [[2]]` وخارج [[3]].");
    expect(r.allRequestedMarkers).toEqual([1, 3]);
    expect(r.cleanText).toBe("خارج و`داخل [[2]]` وخارج.");
  });

  it("★ backtick بلا إغلاق لا يبتلع بقية السطر", () => {
    const r = p("سعر ` غير مغلق [[1]] هنا");
    expect(r.allRequestedMarkers).toEqual([1]);
  });
});

describe("★ الأسوار — لا علامات داخلها", () => {
  it("★ سياج ``` يمنع التحويل", () => {
    const r = p("قبل [[1]]\n\n```js\nconst a = [[2]];\n```\n\nبعد [[3]].");
    expect(r.allRequestedMarkers).toEqual([1, 3]);
    expect(r.cleanText).toContain("const a = [[2]];");
  });

  it("★ سياج ~~~ كذلك", () => {
    const r = p("قبل [[1]]\n\n~~~\nنصّ [[2]] داخل\n~~~\n\nبعد [[3]].");
    expect(r.allRequestedMarkers).toEqual([1, 3]);
    expect(r.cleanText).toContain("نصّ [[2]] داخل");
  });

  /** السطر الفارغ داخل السياج لا يفصل فقرة — السياج وحدة واحدة */
  it("★ سطر فارغ داخل السياج لا يقسّم الفقرات", () => {
    const r = p("```\nسطر\n\nسطر آخر\n```");
    expect(r.segments).toHaveLength(1);
  });

  it("★ سياج غير مغلق: كل ما بعده شيفرة", () => {
    const r = p("قبل [[1]]\n\n```\nداخل [[2]]\nوأيضًا [[3]]");
    expect(r.allRequestedMarkers).toEqual([1]);
  });

  it("★ السياج بإزاحة حتى ثلاث مسافات", () => {
    const r = p("قبل [[1]]\n\n   ```\n   داخل [[2]]\n   ```");
    expect(r.allRequestedMarkers).toEqual([1]);
  });
});

describe("★ الهروب", () => {
  it("★ \\[[1]] لا يُحوَّل ويبقى كما هو", () => {
    const r = p("مهروب \\[[1]] هنا.");
    expect(r.allRequestedMarkers).toEqual([]);
    expect(r.cleanText).toBe("مهروب \\[[1]] هنا.");
  });

  it("★ المهروب والصحيح معًا", () => {
    const r = p("مهروب \\[[1]] وصحيح [[2]].");
    expect(r.allRequestedMarkers).toEqual([2]);
    expect(r.cleanText).toBe("مهروب \\[[1]] وصحيح.");
  });
});

describe("★ لا يفسد Markdown", () => {
  it("★ الروابط تبقى سليمة", () => {
    const src = "انظر [التقرير](https://example.com/a_b-c?x=1) [[1]].";
    const r = p(src);
    expect(r.cleanText).toBe("انظر [التقرير](https://example.com/a_b-c?x=1).");
    expect(r.allRequestedMarkers).toEqual([1]);
  });

  it("★ مرجع الرابط [1]: url لا يُلتبس بعلامة", () => {
    const r = p("[1]: https://example.com");
    expect(r.allRequestedMarkers).toEqual([]);
    expect(r.cleanText).toBe("[1]: https://example.com");
  });

  it("★ الجداول تبقى بمحاذاتها", () => {
    const src = "| العمود | القيمة |\n|---|---|\n| أ [[1]] | ب |";
    const r = p(src);
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.cleanText).toBe("| العمود | القيمة |\n|---|---|\n| أ | ب |");
  });

  it("★ القوائم تبقى بإزاحتها", () => {
    const src = "- أول [[1]]\n- ثانٍ [[2]]\n  - متداخل [[3]]";
    const r = p(src);
    expect(r.allRequestedMarkers).toEqual([1, 2, 3]);
    expect(r.cleanText).toBe("- أول\n- ثانٍ\n  - متداخل");
  });

  it("★ العناوين والاقتباسات", () => {
    const r = p("## عنوان [[1]]\n\n> اقتباس [[2]]");
    expect(r.allRequestedMarkers).toEqual([1, 2]);
    expect(r.cleanText).toBe("## عنوان\n\n> اقتباس");
  });

  it("★ HTML مضمّن لا يتأثّر", () => {
    const r = p('<div class="x">محتوى [[1]]</div>');
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.cleanText).toBe('<div class="x">محتوى</div>');
  });
});

describe("★ الفراغ والترقيم بعد الإزالة", () => {
  it("★ فراغ من الجانبين ⇒ فراغ واحد", () => {
    expect(p("أ [[1]] ب").cleanText).toBe("أ ب");
  });

  it("★ فراغ قبل وترقيم بعد ⇒ لا فراغ معلّق", () => {
    for (const [src, want] of [
      ["أ [[1]].", "أ."],
      ["أ [[1]],", "أ,"],
      ["أ [[1]]،", "أ،"],
      ["أ [[1]]؟", "أ؟"],
      ["أ [[1]])", "أ)"],
    ] as const) {
      expect(p(src).cleanText, src).toBe(want);
    }
  });

  it("★ ملتصقة بالكلمة تبقى ملتصقة", () => {
    expect(p("كلمة[[1]] بعد").cleanText).toBe("كلمة بعد");
  });

  it("★ في آخر السطر لا تترك فراغًا", () => {
    expect(p("جملة كاملة [[1]]").cleanText).toBe("جملة كاملة");
  });
});

describe("★ تقسيم الفقرات", () => {
  it("★ السطر الفارغ يفصل", () => {
    const r = p("الأولى [[1]].\n\nالثانية [[2]].\n\nالثالثة بلا مرجع.");
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.requestedMarkers).toEqual([1]);
    expect(r.segments[1]!.requestedMarkers).toEqual([2]);
    expect(r.segments[2]!.requestedMarkers).toEqual([]);
    expect(r.segments.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
  });

  it("★ عدة أسطر فارغة لا تُنتج فقرات فارغة", () => {
    const r = p("أ [[1]].\n\n\n\nب [[2]].");
    expect(r.segments).toHaveLength(2);
  });

  it("★ الأسطر المتتالية فقرة واحدة", () => {
    const r = p("سطر أول [[1]]\nسطر ثانٍ [[2]]");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.requestedMarkers).toEqual([1, 2]);
  });

  /** فقرةٌ صارت فارغة بعد الإزالة لا تُخرَج، وعلامتها تلحق بالسابقة */
  it("★ علامة وحدها في فقرة ⇒ لا فقرة فارغة، والرقم يلحق بالسابقة", () => {
    const r = p("الفقرة الأولى.\n\n[[1]]\n\nالفقرة الثالثة.");
    expect(r.segments).toHaveLength(2);
    for (const s of r.segments) expect(s.cleanText.trim().length).toBeGreaterThan(0);
    expect(r.segments[0]!.requestedMarkers).toEqual([1]);
    expect(r.allRequestedMarkers).toEqual([1]);
  });

  it("★ علامة وحدها بلا فقرة سابقة ⇒ لا فقرة، والرقم مطلوب", () => {
    const r = p("[[1]]\n\nنصّ بعدها.");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.cleanText).toBe("نصّ بعدها.");
    expect(r.allRequestedMarkers).toEqual([1]);
  });

  it("★ rawText يحفظ العلامات وcleanText يزيلها", () => {
    const r = p("جملة [[1]] هنا.");
    expect(r.segments[0]!.rawText).toBe("جملة [[1]] هنا.");
    expect(r.segments[0]!.cleanText).toBe("جملة هنا.");
  });

  it("★ cleanText الكامل يحفظ الأسطر الفارغة الفاصلة", () => {
    const r = p("أ [[1]].\n\nب [[2]].");
    expect(r.cleanText).toBe("أ.\n\nب.");
  });
});

describe("★ حدود الأمان", () => {
  it("★ مدخل فارغ أو غير نصّي", () => {
    expect(p("").segments).toEqual([]);
    expect(p("").allRequestedMarkers).toEqual([]);
    expect(p(undefined as unknown as string).cleanText).toBe("");
  });

  it("★ مدخل قريب من الحد يُحلَّل", () => {
    const filler = "ن".repeat(MAX_INPUT_CHARS - 200);
    const r = p(`${filler} [[1]].`);
    expect(r.allRequestedMarkers).toEqual([1]);
    expect(r.cleanText.endsWith(".")).toBe(true);
  });

  /** فوق الحد: لا مسح إطلاقًا — النص كما هو وفقرة واحدة */
  it("★ فوق الحد ⇒ يُعاد كما هو بلا علامات", () => {
    const huge = `${"ن".repeat(MAX_INPUT_CHARS + 10)} [[1]].`;
    const r = p(huge);
    expect(r.cleanText).toBe(huge);
    expect(r.allRequestedMarkers).toEqual([]);
    expect(r.segments).toHaveLength(1);
  });

  it("★ أكثر من 99 مرشّحًا: ما بعد السقف يبقى نصًّا", () => {
    // 120 علامة صحيحة، كلها [[1]]
    const src = Array.from({ length: 120 }, () => "ن [[1]]").join(" ");
    const r = p(src);
    expect(r.allRequestedMarkers).toEqual([1]);
    // العلامات فوق السقف بقيت ظاهرة في النص
    const remaining = r.cleanText.split("[[1]]").length - 1;
    expect(remaining).toBe(120 - MAX_MARKER_CANDIDATES);
  });

  /**
   * لا ReDoS: الماسح حرفي، فمدخلٌ مصنوع مليء بـ`[[` لا يجعله أُسّيًا.
   * القياس تحفّظي — الغرض إثبات الخطّية لا قياس الأداء.
   */
  it("★ مدخل عدائي مليء بالأقواس يبقى سريعًا", () => {
    const evil = "[".repeat(40_000) + "1]]".repeat(1_000);
    const t0 = Date.now();
    const r = p(evil);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(r.allRequestedMarkers).toEqual([]);
  });

  /**
   * الحارس على **الاستعمال** لا على وجود التعبير في تعليق: الشرح يذكر نمطًا
   * خطِرًا كمثال، وعدُّه خرقًا إنذارٌ كاذب. ما يهمّ هو ما يُطبَّق على نصّ
   * المستخدم فعلًا.
   */
  it("★ لا تعبير نمطي يُطبَّق على نصّ المستخدم إلا تقسيم الأسطر", () => {
    const src = fs.readFileSync(path.resolve("lib/evidence/marker-parser.ts"), "utf8");
    const uses =
      src.match(/\.(?:split|match|replace|replaceAll|test|exec|search|matchAll)\(\/[^\n]*/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain("split(/\\r?\\n/)");
    // ولا بناء ديناميكي لتعبير من نصّ المستخدم
    expect(src).not.toMatch(/new RegExp/);
  });

  it("★ لا تسجيل إطلاقًا في الوحدة", () => {
    const src = fs.readFileSync(path.resolve("lib/evidence/marker-parser.ts"), "utf8");
    expect(src).not.toMatch(/console\./);
  });
});

describe("★ عزل الإيداع — لا تكامل بعد", () => {
  it("★ الوحدة نقيّة بلا استيراد", () => {
    const src = fs.readFileSync(path.resolve("lib/evidence/marker-parser.ts"), "utf8");
    expect(src).not.toMatch(/^import /m);
    // الشرح يذكر server-only لينفيه؛ المقصود ألّا تستوردها الوحدة
    expect(src).not.toMatch(/import "server-only"/);
    expect(src).not.toMatch(/from "server-only"/);
  });

  /**
   * ★ المستهلك الوحيد هو حلّ الأدلة (الإيداع الخامس).
   *
   * كان الشرط «لا أحد يستعملها» حين كان الإيداع تمهيديًا. وبقاؤه مثبَّتًا على
   * مستهلك واحد يحفظ الغرض: استخراج العلامات يمرّ بمكان واحد، فلا يظهر مسارٌ
   * ثانٍ يفسّر `[[n]]` بقواعد أخرى.
   */
  it("★ لا يستعملها إلا وحدات الأدلة", () => {
    // مستهلكوها المقصودون: الحلّ، والغلاف، ومرشّح البثّ — لا شيء غيرها
    const ALLOWED = ["resolve-evidence.ts", "evidence-envelope.ts", "evidence-stream.ts"];
    const roots = ["app", "components", "lib"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if ([".next", "node_modules"].includes(e.name)) continue;
          walk(full);
        } else if (
          /\.(ts|tsx)$/.test(e.name) &&
          !full.includes("marker-parser") &&
          !ALLOWED.some((a) => full.endsWith(a))
        ) {
          if (fs.readFileSync(full, "utf8").includes("marker-parser")) hits.push(full);
        }
      }
    };
    for (const r of roots) walk(path.resolve(r));
    expect(hits).toEqual([]);
  });
});
