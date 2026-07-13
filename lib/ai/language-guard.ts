/**
 * حارس اللغة — يمنع وصول ردود مختلطة اللغات للمستخدم.
 * يقيس نسب الأحرف حسب النظام الكتابي، ويكشف مخالفة لغة الرد المتوقعة
 * خلال نافذة التخزين المؤقت الأولى من البث.
 */

export interface ScriptRatios {
  totalLetters: number;
  arabic: number;
  latin: number;
  cyrillic: number;
  cjk: number;
  otherUnwanted: number; // هانغل/تايلندي وغيرها من الأنظمة غير المطلوبة
}

/** إحصاء الأحرف حسب النظام الكتابي — تُستثنى الأكواد داخل backticks لتفادي الإنذارات الخاطئة */
export function scriptRatios(text: string): ScriptRatios {
  const stripped = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const r: ScriptRatios = {
    totalLetters: 0,
    arabic: 0,
    latin: 0,
    cyrillic: 0,
    cjk: 0,
    otherUnwanted: 0,
  };
  for (const ch of stripped) {
    if (!/\p{L}/u.test(ch)) continue;
    const c = ch.codePointAt(0) ?? 0;
    r.totalLetters++;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x08ff)) r.arabic++;
    else if (c <= 0x024f) r.latin++;
    else if (c >= 0x0400 && c <= 0x04ff) r.cyrillic++;
    else if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK
      (c >= 0x3040 && c <= 0x30ff) || // ياباني
      (c >= 0x3400 && c <= 0x4dbf)
    )
      r.cjk++;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x0e00 && c <= 0x0e7f)) r.otherUnwanted++;
  }
  return r;
}

export type ExpectedLanguage = "ar" | "other";

/** لغة الرد المتوقعة من رسالة المستخدم */
export function detectExpectedLanguage(userText: string): ExpectedLanguage {
  const r = scriptRatios(userText);
  if (r.totalLetters === 0) return "other";
  return r.arabic / r.totalLetters >= 0.3 ? "ar" : "other";
}

/** هل يستخدم المستخدم نفسه أنظمة كتابة يُفترض منعها؟ (طلب صريح للغة أخرى) */
export function userUsesScript(userText: string, script: "cyrillic" | "cjk"): boolean {
  const r = scriptRatios(userText);
  return (script === "cyrillic" ? r.cyrillic : r.cjk) > 0;
}

/**
 * فحص مخالفة اللغة على نافذة الرد الأولى.
 * - أنظمة غير مطلوبة (سيريلي/CJK/...) فوق 5٪ → مخالفة (ما لم يستخدمها المستخدم).
 * - سؤال عربي ورد شبه خالٍ من العربية وأغلبه لاتيني → مخالفة (رد بلغة خاطئة).
 */
export function violatesLanguage(
  replyWindow: string,
  expected: ExpectedLanguage,
  userText: string,
): { violated: boolean; reason?: string } {
  const r = scriptRatios(replyWindow);
  if (r.totalLetters < 30) return { violated: false }; // نافذة أقصر من أن يُحكم عليها

  const unwanted =
    (userUsesScript(userText, "cyrillic") ? 0 : r.cyrillic) +
    (userUsesScript(userText, "cjk") ? 0 : r.cjk) +
    r.otherUnwanted;
  if (unwanted / r.totalLetters > 0.05) {
    return { violated: true, reason: "unwanted_scripts" };
  }

  if (
    expected === "ar" &&
    r.totalLetters >= 80 &&
    r.arabic / r.totalLetters < 0.25 &&
    r.latin / r.totalLetters > 0.65
  ) {
    return { violated: true, reason: "wrong_language" };
  }

  return { violated: false };
}

/** حجم نافذة الفحص بالأحرف (~100-150 token) */
export const GUARD_WINDOW_CHARS = 400;

/** رسالة فشل كل النماذج — تُعرض للمستخدم */
export const GUARD_FAILURE_MESSAGE =
  "تعذر الحصول على رد عربي بجودة مناسبة حاليًا. رسالتك محفوظة، حاول إعادة التوليد.";

/** ملحق صارم لموجه النظام عند إعادة المحاولة */
export const STRICT_LANGUAGE_SUFFIX =
  "\n\nتنبيه صارم: أجب حصريًا بلغة رسالة المستخدم الأخيرة. إن كانت بالعربية فاكتب بالعربية الفصحى فقط، ويُمنع منعًا باتًا إدراج أي كلمات أو جمل من لغات أخرى (إسبانية، روسية، صينية، يابانية…) باستثناء أسماء التقنيات والأكواد.";
