/**
 * v133 — كشفُ نيّة توليد الصورة.
 *
 * ★ والاختبارُ الأهمّ هنا هو النفي لا الإثبات.
 *
 * كشفٌ يُصيب الطلباتِ كلَّها ويختطف الأسئلةَ أسوأُ من كشفٍ يفوته بعضُها:
 * الأوّلُ يجعل المنتجَ يبدو أبلهَ في كلِّ سؤالٍ فيه لفظُ «صورة»، والثاني
 * يُحلّ بإعادةِ صياغةٍ واحدة.
 */

import { describe, expect, it } from "vitest";

import { detectImageIntent } from "@/lib/local-image/intent";

describe("v133 — يُكشف الطلبُ الصريح", () => {
  const yes = [
    "ولد لي صورة مختبر ذكاء اصطناعي مستقبلي باللون البنفسجي، بدون أشخاص وبدون نص",
    "ولّد صورة قطة سوداء",
    "أنشئ صورة لمدينة ليلية",
    "انشئ صوره غروب على البحر",
    "صمم لي صورة شعار لمقهى",
    "ارسم صورة جبال في الشتاء",
    "اصنع تصميم بوستر لحفلة",
    "generate an image of a purple laboratory",
    "create an image of a mountain lake",
    "make a picture of a red car",
    "draw an illustration of a robot",
  ];
  it.each(yes)("يكشف: %s", (text) => {
    const r = detectImageIntent(text);
    expect(r.detected).toBe(true);
    expect(r.prompt.length).toBeGreaterThanOrEqual(3);
  });

  it("ينزع فعلَ الطلب ويُبقي الوصف", () => {
    const r = detectImageIntent("ولد لي صورة مختبر بنفسجي");
    expect(r.detected).toBe(true);
    expect(r.prompt).not.toMatch(/^ولد/);
    expect(r.prompt).toContain("مختبر");
  });

  it("ويُبقي الوصفَ الإنجليزيّ كاملًا", () => {
    const r = detectImageIntent("generate an image of a purple AI laboratory, no people");
    expect(r.detected).toBe(true);
    expect(r.prompt).toContain("purple AI laboratory");
    expect(r.prompt.toLowerCase()).not.toMatch(/^generate/);
  });
});

describe("v133 — ولا يُختطف السؤالُ عن الصور", () => {
  /**
   * كلُّ هذه تحوي لفظَ «صورة» أو image، وبعضُها يحوي فعلَ الطلب أيضًا.
   * ولا واحدةٌ منها طلبُ توليد.
   */
  const no = [
    "ما هي أفضل صورة للملف الشخصي؟",
    "كيف أنشئ صورة في فوتوشوب",
    "اشرح لي هذه الصورة",
    "هل الصورة المرفقة واضحة",
    "ما الفرق بين صورة PNG وصورة JPG",
    "لماذا حجم الصورة كبير",
    "وضح لي معنى الصورة في الشعر العربي",
    "what is the best image format?",
    "how do I create an image in Figma",
    "explain this image to me",
    "describe the picture above",
    "tell me about image compression",
    "which image format should I use",
  ];
  it.each(no)("لا يختطف: %s", (text) => {
    expect(detectImageIntent(text).detected).toBe(false);
  });

  it("ولا يختطف رسالةً بلا لفظِ صورة أصلًا", () => {
    expect(detectImageIntent("اكتب لي مقالًا عن التعليم").detected).toBe(false);
    expect(detectImageIntent("summarize this article").detected).toBe(false);
  });

  /**
   * ★ الفعلُ في وسط الكلام وصفٌ لا أمر.
   *
   * «أخبرني عن برنامجٍ يصمم صورًا» فعلُها «يصمم» لكنه صفةٌ لبرنامجٍ آخر،
   * والأمرُ الحقيقيّ «أخبرني».
   */
  it("لا يختطف فعلًا واقعًا في وسط الجملة", () => {
    expect(detectImageIntent("أخبرني عن برنامج يصمم صورًا احترافية").detected).toBe(false);
  });

  it("ولا الرسائلَ الفارغة أو المفرطة الطول", () => {
    expect(detectImageIntent("").detected).toBe(false);
    expect(detectImageIntent("   ").detected).toBe(false);
    expect(detectImageIntent("ولد لي صورة " + "ط".repeat(1300)).detected).toBe(false);
  });

  it("ولا ما ليس نصًّا", () => {
    // @ts-expect-error اختبارُ مدخلٍ خاطئ عمدًا
    expect(detectImageIntent(null).detected).toBe(false);
    // @ts-expect-error اختبارُ مدخلٍ خاطئ عمدًا
    expect(detectImageIntent(undefined).detected).toBe(false);
  });
});

describe("v133 — الشكُّ يُبقي المحادثةَ على حالها", () => {
  it("علامةُ الاستفهام وحدها تمنع الكشف", () => {
    expect(detectImageIntent("ولد لي صورة؟").detected).toBe(false);
    expect(detectImageIntent("generate an image?").detected).toBe(false);
  });

  it("والوصفُ الأقصرُ من ثلاثةِ أحرفٍ لا يُمرَّر", () => {
    expect(detectImageIntent("ولد صورة").detected).toBe(false);
    expect(detectImageIntent("generate an image").detected).toBe(false);
  });

  /** السببُ يُسجَّل دائمًا — فمراجعةُ قرارٍ بلا سببٍ تخمين */
  it("يُرفق سببُ القرار في الحالين", () => {
    expect(detectImageIntent("ما هي الصورة").reason).toBeTruthy();
    expect(detectImageIntent("ولد لي صورة قطة").reason).toBeTruthy();
  });
});
