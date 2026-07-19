/**
 * حارس عدم اليقين (v0.6.5 RC2) — يمنع تمرير تفاصيل متخصصة غير مؤكدة.
 * اختبارات نقية بلا شبكة.
 */
import { describe, expect, it } from "vitest";
import {
  UNCERTAINTY_FALLBACK_MESSAGE,
  hasSpecificDetails,
  needsVerifiedMode,
  questionWantsSpecifics,
  replyIsHedged,
  violatesUncertainty,
} from "../lib/ai/uncertainty-guard";

// سؤال يطلب مكانًا/خطوات دقيقة (مثال المختبِر: القناع الأبيض)
const SPECIFIC_Q =
  "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟";
// سؤال عام لا يطلب تفاصيل دقيقة
const GENERAL_Q = "ما رأيك في لعبة الدن رينق بشكل عام؟";

describe("لبنات الحارس", () => {
  it("يكتشف السؤال المتخصّص (مكان/خطوات/اسم)", () => {
    expect(questionWantsSpecifics(SPECIFIC_Q)).toBe(true);
    expect(questionWantsSpecifics("كيف أحصل على السلاح الأسطوري؟")).toBe(true);
    expect(questionWantsSpecifics("أين يوجد هذا العنصر؟")).toBe(true);
    expect(questionWantsSpecifics("كم عدد المراحل في اللعبة بالضبط؟")).toBe(true);
  });

  it("لا يعدّ السؤال العام متخصّصًا", () => {
    expect(questionWantsSpecifics(GENERAL_Q)).toBe(false);
  });

  it("يكتشف التحفّظ في الرد", () => {
    expect(replyIsHedged("بعض المصادر تشير إلى ذلك")).toBe(true);
    expect(replyIsHedged("على الأغلب يقع هناك")).toBe(true);
    expect(replyIsHedged("لست متأكدًا من ذلك")).toBe(true);
    expect(replyIsHedged("هذا هو الموقع بالتأكيد")).toBe(false);
  });

  it("يكتشف التفاصيل المحددة بمؤشرات عامة (لا نمط مفصّل على مثال بعينه)", () => {
    expect(hasSpecificDetails("اذهب إلى الشمال ثم اتجه غربًا")).toBe(true); // أفعال توجيه + اتجاه
    expect(hasSpecificDetails("توجد قرب «كنيسة إيلله»")).toBe(true); // اسم بين علامات اقتباس
    expect(hasSpecificDetails("ستجده في منطقة الجبال البعيدة")).toBe(true); // منطقة
    expect(hasSpecificDetails("1. افتح الباب\n2. اهزم الحارس")).toBe(true); // خطوات مرقّمة
    expect(hasSpecificDetails("تحتاج إلى 30 ثانية لإتمامها")).toBe(true); // أرقام ومدد
    expect(hasSpecificDetails("لا أعرف مكانه الدقيق للأسف")).toBe(false);
  });
});

describe("★ متطلّب المختبِر — رد متحفّظ بخطوات دقيقة لا يمر", () => {
  it("«بعض المصادر» + خطوات ومواقع محددة → مخالفة", () => {
    const reply =
      "القناع الأبيض موجود في منطقة Mountaintops of the Giants. اذهب إلى موقع النعمة القريب ثم " +
      "اتجه شمالًا. بعض المصادر تشير إلى أنه قد يكون قرب «كنيسة إيلله».";
    const v = violatesUncertainty(SPECIFIC_Q, reply);
    expect(v.violated).toBe(true);
    expect(v.reason).toBe("uncertain_specifics");
  });

  it("«على الأغلب» + قائمة خطوات مرقّمة → مخالفة", () => {
    const reply =
      "على الأغلب تحصل عليه هكذا:\n1. اذهب إلى القلعة\n2. اتجه شرقًا نحو البوابة\n3. اهزم الحارس هناك.";
    expect(violatesUncertainty("كيف أحصل على القناع؟", reply).violated).toBe(true);
  });
});

describe("★ متطلّب المختبِر — اعتراف آمن بعدم التأكد يمر", () => {
  it("تحفّظ بلا اختراع مواقع → لا مخالفة (هو المطلوب)", () => {
    const reply =
      "لست متأكد من الخطوات الدقيقة للحصول على القناع الأبيض، ولا أريد أن أعطيك معلومة غير " +
      "موثوقة. أنصحك بمراجعة دليل موثوق للعبة.";
    expect(violatesUncertainty(SPECIFIC_Q, reply).violated).toBe(false);
  });

  it("رسالة عدم التأكد الآمنة نفسها لا تُوقف الحارس (idempotent)", () => {
    // وإلا لدخلنا حلقة: الرسالة البديلة تُرفض فتُستبدل بنفسها.
    expect(violatesUncertainty(SPECIFIC_Q, UNCERTAINTY_FALLBACK_MESSAGE).violated).toBe(false);
  });
});

describe("★ اختيار الوضع — المحمي للمتخصص فقط، والبثّ لكل ما عداه", () => {
  it("الأسئلة المتخصصة تدخل الوضع المحمي", () => {
    expect(needsVerifiedMode(SPECIFIC_Q)).toBe(true);
    expect(needsVerifiedMode("أين يوجد هذا السلاح؟")).toBe(true);
    expect(needsVerifiedMode("ما هي الخطوات الدقيقة للتثبيت؟")).toBe(true);
    expect(needsVerifiedMode("كم عدد المراحل بالضبط؟")).toBe(true);
  });

  it("المحادثة العامة تبقى على البثّ الفوري بلا تحقق", () => {
    // كتابة إبداعية
    expect(
      needsVerifiedMode(
        "اكتب مشهد معركة قصير في رواية خيالية: فارس يواجه تنينًا وينفث النار عليه.",
      ),
    ).toBe(false);
    expect(needsVerifiedMode("كيف حالك اليوم؟")).toBe(false); // محادثة يومية
    expect(needsVerifiedMode("لخّص لي هذا النص من فضلك.")).toBe(false); // تلخيص
    expect(needsVerifiedMode("اشرح لي مفهوم الجاذبية بشكل مبسّط.")).toBe(false); // شرح عام
    expect(needsVerifiedMode("ما هي عاصمة السعودية؟")).toBe(false); // سؤال بسيط
  });

  it("لا يخلط الكلمات العامية داخل كلمات أخرى (تكوين/تدوين)", () => {
    expect(needsVerifiedMode("ما هو تكوين المشروع؟")).toBe(false);
    expect(needsVerifiedMode("اشرح لي تدوين الملاحظات.")).toBe(false);
  });
});

describe("حدود الحارس — لا يمنع الردود المشروعة", () => {
  it("رد واثق بتفاصيل بلا تحفّظ لا يُمنع", () => {
    const reply = "اذهب إلى الشمال ثم اتجه غربًا؛ ستجد العنصر هناك بالتأكيد.";
    expect(violatesUncertainty("أين أجد العنصر؟", reply).violated).toBe(false);
  });

  it("سؤال عام + تحفّظ لا يُمنع (لا يطلب تفاصيل دقيقة)", () => {
    const reply = "ربما تكون من أفضل الألعاب، لكن الأمر يعتمد على ذوقك الشخصي.";
    expect(violatesUncertainty(GENERAL_Q, reply).violated).toBe(false);
  });
});
