/**
 * v133 — رسائلُ الفشل في التوليد المحلّيّ (المرحلة 3C، §8).
 *
 * ★ والمقياسُ الأهمّ هنا: ألّا يقترح أيُّ فشلٍ بديلًا مدفوعًا.
 *
 * فلحظةُ العطب هي أكثرُ اللحظات إغراءً بـ«جرّبها عبر السحابة»: المستخدمُ
 * ينتظر ولا شيءَ يعمل. وقبولُ ذلك يخرق قاعدةَ الكلفة الصفريّة من حيث لا
 * يُنتبَه — ولا يظهر إلا في الفاتورة.
 */

import { describe, expect, it } from "vitest";

import { messageForError } from "@/lib/local-image/client";

/** كلُّ ما يدلّ على مخرجٍ مدفوع أو سحابيّ */
const PAID_OR_CLOUD = /cloud|upgrade|paid|premium|subscri|credit|api key|openai|replicate|fal\.ai|runpod|stability|deepl|google translate/i;

describe("v133 — كلُّ رمزِ خطأ يُترجم إلى إرشادٍ محلّيّ", () => {
  const cases: Array<[string, RegExp]> = [
    ["hardware_profile_unverified", /not verified/i],
    ["insufficient_local_resources", /not enough free gpu memory/i],
    ["resolution_not_calibrated", /not been calibrated/i],
    ["resource_probe_failed", /could not read/i],
    ["busy", /already running/i],
    ["cancelled", /cancelled/i],
    ["timeout", /too long/i],
  ];

  it.each(cases)("%s → رسالةٌ مفهومة", (code, pattern) => {
    expect(messageForError(code)).toMatch(pattern);
  });

  /**
   * ★ ضيقُ الذاكرة نوعان، وعلاجُهما مختلف.
   *
   * ذاكرةُ البطاقة تُفرَّج بإغلاق لعبةٍ أو متصفّح، وذاكرةُ النظام تُفرَّج
   * بإغلاق تطبيقاتٍ أخرى. ورسالةٌ واحدة لهما تُرسل نصفَ المستخدمين إلى
   * طريقٍ لا يحلّ مشكلتهم.
   */
  it("يُفرَّق بين ذاكرة البطاقة وذاكرة النظام", () => {
    const gpu = messageForError("insufficient_local_resources", "free_vram");
    const ram = messageForError("insufficient_local_resources", "free_system_ram");
    expect(gpu).toMatch(/gpu/i);
    expect(ram).toMatch(/system memory/i);
    expect(gpu).not.toBe(ram);
  });

  it("والمجهولُ يُعطى رسالةً محلّيّة كذلك", () => {
    expect(messageForError(undefined)).toMatch(/could not complete/i);
    expect(messageForError("something_new_and_unknown")).toMatch(/could not complete/i);
  });
});

describe("v133 — لا بديلَ مدفوعًا في أيّ مسارِ فشل", () => {
  const allCodes = [
    "hardware_profile_unverified",
    "insufficient_local_resources",
    "resolution_not_calibrated",
    "resource_probe_failed",
    "busy",
    "cancelled",
    "timeout",
    "local_translation_model_not_installed",
    "local_prompt_translation_failed",
    "engine_unreachable",
    "image_unreadable",
    undefined,
  ];

  it.each(allCodes.map((c) => [String(c)]))("%s لا يقترح سحابةً ولا دفعًا", (code) => {
    const msg = messageForError(code === "undefined" ? undefined : code);
    expect(msg).not.toMatch(PAID_OR_CLOUD);
  });

  /** ولا يُسرَّب مسارٌ مطلق في رسالةٍ تُعرض للمستخدم */
  it.each(allCodes.map((c) => [String(c)]))("%s لا يكشف مسارًا في نظام الملفّات", (code) => {
    const msg = messageForError(code === "undefined" ? undefined : code);
    expect(msg).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });
});

describe("v133 — رمزا الترجمة متمايزان", () => {
  /**
   * ★ «غيرُ مثبَّت» و«فشلت الترجمة» لا يجوز خلطُهما.
   *
   * الأوّلُ يُعالَج بالتنزيل، والثاني بالإصلاح. ورمزٌ واحد لهما يجعل
   * المستخدمَ يُعيد تنزيلَ ملفّاتٍ موجودةٍ أصلًا ولا ينحلّ شيء.
   */
  it("لكلٍّ رمزُه المستقلّ ورسالتُه", () => {
    const missing = messageForError("local_translation_model_not_installed");
    const failed = messageForError("local_prompt_translation_failed");
    expect(missing).not.toBe(failed);
    expect(missing).toMatch(/not installed/i);
    expect(failed).toMatch(/could not process/i);
    /** ولا يُقال لمن ملفّاتُه سليمة: نزّلْه — فذلك إرشادٌ لا ينفعه */
    expect(failed).not.toMatch(/^The local Arabic translator is not installed/);
  });

  /** ★ ولا تُقترح ترجمةٌ عبر خادم YSD — الوصفُ يبقى على الجهاز */
  it("ولا يُقترح إرسالُ الوصف إلى خادمٍ لترجمته", () => {
    for (const code of ["local_translation_model_not_installed", "local_prompt_translation_failed"]) {
      expect(messageForError(code)).not.toMatch(/send|upload|server|ysd cloud|online/i);
    }
  });

  it("وكلاهما يبقى محلّيًّا في رسالته", () => {
    for (const code of ["local_translation_model_not_installed", "local_prompt_translation_failed"]) {
      expect(messageForError(code)).not.toMatch(PAID_OR_CLOUD);
    }
  });
});
