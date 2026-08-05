/**
 * التحقق من الاقتباس (v0.9.0 — الإيداع الثالث).
 *
 * ما يُختبر هنا نصفان غير متساويين في الخطر:
 *
 *   • **القبول** — أن يُقبل اقتباسٌ صحيح رغم فروق الرسم. فشله يعني استشهادًا
 *     مفقودًا، والفقرة تُوسم «غير مدعومة» فيعرف القارئ حدّ الدليل.
 *
 *   • **الرفض** — ألّا يُقبل ما لم يقله المقطع. فشله يعني استشهادًا **كاذبًا**:
 *     ثقةٌ بلا أساس، ولا شيء في الواجهة يكشفها.
 *
 * ولهذا حالات الرفض هنا أكثر عددًا وأدقّ تفصيلًا من حالات القبول.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_CHARS,
  MAX_OCCURRENCE_SCAN,
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  normalizeWithMap,
  verifyEvidenceQuote,
} from "../lib/evidence/quote-verifier";

const v = (candidateQuote: string, snippetContent: string) =>
  verifyEvidenceQuote({ candidateQuote, snippetContent });

/** يؤكّد النجاح ويُعيد النتيجة مضيَّقة النوع */
function ok(r: ReturnType<typeof v>) {
  expect(r.verified).toBe(true);
  if (!r.verified) throw new Error("unreachable");
  return r;
}

// ════════════════════════════════════════════════════════════
//  exact
// ════════════════════════════════════════════════════════════

describe("★ مطابقة حرفية", () => {
  it("★ عربي", () => {
    const content = "تشير البيانات إلى أن الإيرادات ارتفعت بنسبة اثني عشر بالمئة.";
    const r = ok(v("الإيرادات ارتفعت بنسبة اثني عشر بالمئة", content));
    expect(r.verification).toBe("exact");
    expect(r.quote).toBe("الإيرادات ارتفعت بنسبة اثني عشر بالمئة");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ إنجليزي", () => {
    const content = "The report states that revenue grew by twelve percent in Q3.";
    const r = ok(v("revenue grew by twelve percent", content));
    expect(r.verification).toBe("exact");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ نصّ مختلط", () => {
    const content = "حسب تقرير Q3 Revenue Report ارتفعت النسبة إلى 12٪ هذا العام.";
    const r = ok(v("تقرير Q3 Revenue Report ارتفعت", content));
    expect(r.verification).toBe("exact");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ أسطر متعددة", () => {
    const content = "المقدمة هنا.\nالسطر الثاني يحمل المعلومة المهمة.\nالخاتمة.";
    const r = ok(v("السطر الثاني يحمل المعلومة المهمة", content));
    expect(r.verification).toBe("exact");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ علامات ترقيم", () => {
    const content = 'قال المدير: «ارتفعت الأرباح، وتحسّن الأداء» — ثم أضاف تفاصيل.';
    const r = ok(v("«ارتفعت الأرباح، وتحسّن الأداء»", content));
    expect(r.verification).toBe("exact");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ الفراغ الخارجي يُزال من المرشّح وحده", () => {
    const content = "النصّ الكامل يحوي هذه الجملة المهمة داخله.";
    const r = ok(v("   هذه الجملة المهمة داخله   ", content));
    expect(r.verification).toBe("exact");
    expect(r.quote).toBe("هذه الجملة المهمة داخله");
  });
});

// ════════════════════════════════════════════════════════════
//  normalized
// ════════════════════════════════════════════════════════════

describe("★ مطابقة بعد التطبيع", () => {
  it("★ تشكيل عربي في المقطع", () => {
    const content = "وَارْتَفَعَتِ الإِيرَادَاتُ بِنِسْبَةٍ كَبِيرَةٍ هَذَا العَامَ.";
    const r = ok(v("وارتفعت الإيرادات بنسبة كبيرة هذا العام", content));
    expect(r.verification).toBe("normalized");
    // الشريحة من الأصل: تعود بتشكيلها كما في الملف
    expect(content.slice(r.start, r.end)).toBe(r.quote);
    expect(r.quote).toContain("َ"); // فتحة
  });

  it("★ تطويل ـ", () => {
    const content = "الإيــــرادات ارتفــعت بنسبــة كبيرة جدًا هنا.";
    const r = ok(v("الإيرادات ارتفعت بنسبة كبيرة جدا", content));
    expect(r.verification).toBe("normalized");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ أشكال الألف: أ إ آ ٱ ⇄ ا", () => {
    const content = "أعلنت الإدارة آنفًا عن ٱرتفاع ملحوظ في النتائج.";
    const r = ok(v("اعلنت الادارة انفا عن ارتفاع ملحوظ", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ ى ⇄ ي", () => {
    const content = "جرى الاجتماع على مستوى عالٍ من التنسيق الكامل.";
    const r = ok(v("جري الاجتماع علي مستوي عال", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ ی و ک الفارسيتان", () => {
    const content = "کتب المحرر یومًا عن نتائج الربع الأخير بالتفصيل.";
    const r = ok(v("كتب المحرر يوما عن نتائج الربع", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ الأرقام العربية-الهندية ٠-٩", () => {
    const content = "بلغت النسبة ١٢٪ خلال الربع الثالث من العام الجاري.";
    const r = ok(v("بلغت النسبة 12٪ خلال الربع الثالث", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ الأرقام الفارسية ۰-۹", () => {
    const content = "الرقم النهائي هو ۴۵۶ وحدة مسجلة في السجل الرسمي.";
    const r = ok(v("الرقم النهائي هو 456 وحدة مسجلة", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ اختلاف الفراغات والأسطر", () => {
    const content = "الجملة    الأولى\nمع\tفراغات   مختلفة تمامًا هنا.";
    const r = ok(v("الجملة الأولى مع فراغات مختلفة تماما", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ حالة الأحرف اللاتينية", () => {
    const content = "The QUARTERLY Revenue Report shows steady growth.";
    const r = ok(v("the quarterly revenue report shows", content));
    expect(r.verification).toBe("normalized");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
    expect(r.quote).toContain("QUARTERLY"); // الأصل لا المطبَّع
  });

  it("★ محارف صفرية العرض ومحارف اتجاه", () => {
    const content = "النتيجة​ النهائية‏ للتقرير‎ الفصلي معلنة رسميًا.";
    const r = ok(v("النتيجة النهائية للتقرير الفصلي معلنة", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ NFKC: أحرف كاملة العرض", () => {
    const content = "الكود ＲＥＶＥＮＵＥ مذكور في الجدول أعلاه بوضوح.";
    const r = ok(v("الكود REVENUE مذكور في الجدول", content));
    expect(r.verification).toBe("normalized");
  });

  it("★ NFKC: رباط لام-ألف يتمدّد بلا إفساد الخريطة", () => {
    const content = "قال المدير ﻻ شيء يمنع النمو في هذا الربع.";
    const r = ok(v("قال المدير لا شيء يمنع النمو", content));
    expect(r.verification).toBe("normalized");
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });
});

// ════════════════════════════════════════════════════════════
//  الرفض
// ════════════════════════════════════════════════════════════

describe("★ الرفض — حدود", () => {
  const content = "نصّ المقطع الكامل يحوي جملًا كثيرة ومفيدة للاختبار هنا.";

  it("★ فارغ", () => {
    expect(v("", content)).toEqual({ verified: false, reason: "empty" });
    expect(v("   \n\t ", content)).toEqual({ verified: false, reason: "empty" });
  });

  it("★ أقصر من الحد الأدنى بعد التطبيع", () => {
    const r = v("نصّ قصير", content);
    expect(r).toEqual({ verified: false, reason: "too_short" });
  });

  /** تشكيل كثيف يجعل نصًّا قصيرًا يبدو طويلًا — الحدّ يُقاس بعد التطبيع */
  it("★ الطول يُقاس بعد التطبيع لا قبله", () => {
    const heavy = "نَصٌّ";
    expect(heavy.length).toBeGreaterThan(MIN_QUOTE_CHARS - 8);
    expect(v(heavy, content)).toEqual({ verified: false, reason: "too_short" });
  });

  it("★ أطول من 240 ⇒ يُرفض ولا يُقصّ", () => {
    const long = "ن".repeat(MAX_QUOTE_CHARS + 1);
    expect(v(long, content)).toEqual({ verified: false, reason: "too_long" });
  });

  it("★ 240 بالضبط مقبول طولًا", () => {
    const exact240 = "ن".repeat(MAX_QUOTE_CHARS);
    const r = v(exact240, content);
    // ليس موجودًا في المقطع، لكن ليس too_long
    expect(r).toEqual({ verified: false, reason: "not_found" });
  });

  it("★ مقطع أكبر من الحد", () => {
    const huge = "ن".repeat(MAX_CONTENT_CHARS + 1);
    expect(v("جملة طويلة كافية للاختبار", huge)).toEqual({
      verified: false,
      reason: "content_too_large",
    });
  });

  it("★ غير موجود", () => {
    expect(v("جملة لا وجود لها إطلاقًا هنا", content)).toEqual({
      verified: false,
      reason: "not_found",
    });
  });
});

describe("★ الرفض — ما لا يجوز أن يُقبل", () => {
  const content = "ارتفعت الإيرادات بنسبة اثني عشر بالمئة خلال الربع الثالث.";

  it("★ تغيير ترتيب الكلمات", () => {
    expect(v("بنسبة ارتفعت الإيرادات اثني عشر", content).verified).toBe(false);
  });

  it("★ حذف كلمات من الوسط", () => {
    expect(v("ارتفعت الإيرادات خلال الربع الثالث", content).verified).toBe(false);
  });

  /**
   * ة/ه و ؤ/و و ئ/ي **فروق معنى لا رسم**. قبولها يعني نسبة جملة إلى مقطع
   * لا يحويها — وهذا بالضبط الاستشهاد الكاذب.
   */
  it("★ ة مقابل ه لا تُطبَّع", () => {
    const c = "أعلنت الشركة عن نتائج الحياة المهنية للموظفين الجدد.";
    expect(v("أعلنت الشركه عن نتائج الحياه المهنيه", c).verified).toBe(false);
  });

  it("★ ؤ مقابل و لا تُطبَّع", () => {
    const c = "المسؤول المباشر عن هذا القرار حاضر في الاجتماع اليوم.";
    expect(v("المسوول المباشر عن هذا القرار حاضر", c).verified).toBe(false);
  });

  it("★ ئ مقابل ي لا تُطبَّع", () => {
    const c = "النتائج النهائية للتقرير معروضة في الملحق الأخير هنا.";
    expect(v("النتايج النهايية للتقرير معروضة", c).verified).toBe(false);
  });

  it("★ اختلاف ترقيم جوهري", () => {
    const c = "بلغت النسبة 12.5 بالمئة في نهاية الربع الثالث تمامًا.";
    expect(v("بلغت النسبة 125 بالمئة في نهاية", c).verified).toBe(false);
  });

  /** نصّ متشابه من مقطع آخر: القرب ليس دليلًا */
  it("★ نصّ متشابه من مقطع مختلف", () => {
    const other = "ارتفعت الإيرادات بنسبة خمسة عشر بالمئة خلال الربع الرابع.";
    const r = v("ارتفعت الإيرادات بنسبة اثني عشر بالمئة", other);
    expect(r.verified).toBe(false);
  });

  it("★ لا مطابقة تقريبية ولا مسافة تحرير", () => {
    // حرف واحد مختلف داخل كلمة — يُرفض
    expect(v("ارتفعت الايرادت بنسبة اثني عشر", content).verified).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
//  الإزاحات
// ════════════════════════════════════════════════════════════

describe("★ الإزاحات والشريحة الأصلية", () => {
  it("★ start/end يعيدان النصّ الأصلي الصحيح", () => {
    const content = "مقدمة قصيرة. ثم الجملة المستشهد بها هنا. ثم خاتمة.";
    const r = ok(v("الجملة المستشهد بها هنا", content));
    expect(content.slice(r.start, r.end)).toBe(r.quote);
    expect(r.quote).toBe("الجملة المستشهد بها هنا");
  });

  it("★ التشكيل والتطويل لا يفسدان الإزاحات", () => {
    const content = "بداية. وَارْتَفَعَتِ الإيــرادات كَثِيرًا هذا العام. نهاية.";
    const r = ok(v("وارتفعت الإيرادات كثيرا هذا العام", content));
    expect(r.verification).toBe("normalized");
    // الشريحة تطابق الإزاحات، وتحمل التشكيل والتطويل كما في الأصل
    expect(content.slice(r.start, r.end)).toBe(r.quote);
    expect(r.quote).toContain("ــ");
    expect(r.quote.startsWith("وَ")).toBe(true);
  });

  it("★ تمدّد NFKC لا يفسد الخريطة", () => {
    const content = "قبل ﻻ بعد: الجملة المطلوبة موجودة هنا كاملة.";
    const r = ok(v("الجملة المطلوبة موجودة هنا كاملة", content));
    expect(content.slice(r.start, r.end)).toBe(r.quote);
  });

  it("★ الشريحة من المقطع لا من المرشّح", () => {
    // المرشّح بلا تشكيل، والمقطع مشكَّل: المُعاد هو المشكَّل
    const content = "النَّتِيجَةُ النِّهَائِيَّةُ مُعْلَنَةٌ رَسْمِيًّا اليوم.";
    const r = ok(v("النتيجة النهائية معلنة رسميا", content));
    expect(r.quote).not.toBe("النتيجة النهائية معلنة رسميا");
    expect(content.includes(r.quote)).toBe(true);
  });

  it("★ الإزاحات داخل حدود المقطع", () => {
    const content = "نصّ فيه جملة مستشهد بها في وسطه تمامًا هنا.";
    const r = ok(v("جملة مستشهد بها في وسطه", content));
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeLessThanOrEqual(content.length);
    expect(r.start).toBeLessThan(r.end);
  });
});

describe("★ التكرار", () => {
  it("★ التكرار يبقى متحقَّقًا مع عدّ صحيح", () => {
    const unit = "الجملة المكررة هنا. ";
    const content = unit + "فاصل. " + unit + "فاصل آخر. " + unit;
    const r = ok(v("الجملة المكررة هنا", content));
    expect(r.occurrenceCount).toBe(3);
    // البداية عند أول ظهور
    expect(r.start).toBe(content.indexOf("الجملة المكررة هنا"));
  });

  it("★ ظهور واحد ⇒ العدّ 1", () => {
    const r = ok(v("جملة فريدة تمامًا هنا", "نصّ فيه جملة فريدة تمامًا هنا مرة واحدة."));
    expect(r.occurrenceCount).toBe(1);
  });

  it("★ العدّ محدود بسقف داخلي", () => {
    const content = "تكرار مستمر هنا. ".repeat(MAX_OCCURRENCE_SCAN + 50);
    const r = ok(v("تكرار مستمر هنا", content));
    expect(r.occurrenceCount).toBeLessThanOrEqual(MAX_OCCURRENCE_SCAN);
  });
});

// ════════════════════════════════════════════════════════════
//  المتانة والعقد
// ════════════════════════════════════════════════════════════

describe("★ المتانة", () => {
  it("★ لا رمي على Unicode شاذّ أو بدائل يتيمة", () => {
    const weird = "\uD800 نصّ فيه بديل يتيم \uDFFF وأحرف تحكّم  هنا.";
    expect(() => v("نصّ فيه بديل يتيم", weird)).not.toThrow();
    expect(() => v(weird, weird)).not.toThrow();
    expect(() => normalizeWithMap(weird)).not.toThrow();
  });

  it("★ لا تعديل للمدخلات", () => {
    const cand = "  جملة للاختبار هنا  ";
    const content = "نصّ فيه جملة للاختبار هنا داخله.";
    const c1 = cand;
    const c2 = content;
    v(cand, content);
    expect(cand).toBe(c1);
    expect(content).toBe(c2);
  });

  it("★ مدخل عدائي يبقى سريعًا", () => {
    const content = "ن".repeat(50_000);
    const cand = "ن".repeat(200);
    const t0 = Date.now();
    const r = v(cand, content);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.verified).toBe(true);
  });

  it("★ الخريطة بطول النصّ المطبَّع", () => {
    const { normalized, srcStart, srcEnd } = normalizeWithMap("أبــجَد ١٢٣ Test​");
    expect(srcStart).toHaveLength(normalized.length);
    expect(srcEnd).toHaveLength(normalized.length);
    for (let i = 0; i < normalized.length; i++) {
      expect(srcStart[i]!).toBeLessThan(srcEnd[i]!);
    }
  });
});

describe("★ عقد الوحدة", () => {
  const src = fs.readFileSync(path.resolve("lib/evidence/quote-verifier.ts"), "utf8");

  it("★ نقيّة بلا استيراد", () => {
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/import "server-only"/);
  });

  it("★ لا تسجيل", () => {
    expect(src).not.toMatch(/console\./);
  });

  it("★ لا تعبير نمطي يُطبَّق على نصّ المستخدم", () => {
    const uses =
      src.match(/\.(?:split|match|replace|replaceAll|test|exec|search|matchAll)\(\/[^\n]*/g) ?? [];
    expect(uses).toEqual([]);
    expect(src).not.toMatch(/new RegExp/);
  });

  /** التطبيعات الممنوعة: وجودها في الشيفرة يعني قبول ما لا يجوز */
  it("★ لا يطبّع ة/ؤ/ئ", () => {
    for (const bad of ['["ة", "ه"]', '["ؤ", "و"]', '["ئ", "ي"]']) {
      expect(src).not.toContain(bad);
    }
  });

  it("★ لا مطابقة تقريبية", () => {
    expect(src).not.toMatch(/levenshtein|editDistance|fuzzy|similarity/i);
  });

  it("★ لا أحد يستعملها بعد — الإيداع تمهيدي", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if ([".next", "node_modules"].includes(e.name)) continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(e.name) && !full.includes("quote-verifier")) {
          if (fs.readFileSync(full, "utf8").includes("quote-verifier")) hits.push(full);
        }
      }
    };
    for (const r of ["app", "components", "lib"]) walk(path.resolve(r));
    expect(hits).toEqual([]);
  });
});
