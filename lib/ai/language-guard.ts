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
      (c >= 0x3040 && c <= 0x30ff) || // ياباني (هيراغانا/كاتاكانا)
      (c >= 0x3400 && c <= 0x4dbf)
    )
      r.cjk++;
    else if (
      (c >= 0xac00 && c <= 0xd7af) || // هانغل (كوري)
      (c >= 0x0e00 && c <= 0x0e7f) || // تايلندي
      (c >= 0x0370 && c <= 0x03ff) || // يوناني
      (c >= 0x1f00 && c <= 0x1fff) // يوناني ممتد
    )
      r.otherUnwanted++;
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
 * اختصارات ومصطلحات تقنية لاتينية تُكتب داخل نص عربي بلا حرف كبير — مسموحة.
 * ما عداها من كلمة لاتينية صغيرة (كلها أحرف صغيرة) يُعدّ دخيلًا (loot، bajo…).
 * أسماء العلم الواضحة تُكتب بحرف كبير فتمرّ تلقائيًا، والأكواد والروابط تُجرَّد.
 */
const LATIN_ALLOW = new Set([
  "ai", "pdf", "rag", "api", "uri", "url", "css", "html", "http", "https", "www", "ssl",
  "tls", "sql", "json", "xml", "yaml", "yml", "csv", "png", "jpg", "jpeg", "gif", "svg",
  "webp", "ico", "mp3", "mp4", "wav", "doc", "docx", "xls", "xlsx", "ppt", "zip", "txt",
  "sdk", "cli", "seo", "faq", "cpu", "gpu", "ram", "ssd", "hdd", "usb", "dns", "cdn",
  "vpn", "npm", "pip", "git", "ssh", "ftp", "smtp", "imap", "jwt", "orm", "crud", "saas",
  "paas", "iaas", "gpt", "llm", "nlp", "rls", "env", "dev", "prod", "app", "web", "pro",
  "react", "nodejs", "node", "nextjs", "next", "vue", "angular", "svelte", "django",
  "flask", "laravel", "express", "docker", "kubernetes", "linux", "ubuntu", "windows",
  "macos", "android", "ios", "python", "java", "javascript", "typescript", "kotlin",
  "swift", "rust", "golang", "github", "gitlab", "google", "microsoft", "apple",
  "amazon", "openai", "claude", "anthropic", "supabase", "postgres", "postgresql",
  "mysql", "mongodb", "redis", "sqlite", "firebase", "email", "username", "password",
  "token", "admin", "user", "true", "false", "null", "void", "async", "await",
]);

/**
 * يستخرج الكلمات اللاتينية الصغيرة الدخيلة في نص (كلها أحرف صغيرة، طولها ≥3،
 * ليست اختصارًا/مصطلحًا معروفًا). يُجرَّد الكود والروابط والبريد أولًا،
 * وأي رمز فيه حرف كبير يُعدّ اسم علم أو اختصارًا فيُتجاوز.
 */
export function findStrayLatinWords(text: string): string[] {
  const stripped = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, " ");
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z.\-'’]*[A-Za-z]|[A-Za-z]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const raw = m[0];
    if (/[A-Z]/.test(raw)) continue; // فيه حرف كبير → اسم علم/اختصار مسموح (White Mask, RAG)
    const word = raw.replace(/[.\-'’]/g, "").toLowerCase();
    if (word.length < 3) continue; // رموز قصيرة (js, id, ok) تُتجاهل
    if (LATIN_ALLOW.has(word)) continue; // اختصار/مصطلح معروف
    out.push(raw);
  }
  return out;
}

/**
 * فحص مخالفة اللغة على الرد الكامل (v0.6.5 RC2: بعد تجميع الرد لا على نافذة).
 * - رد عربي متوقّع: أي حرف سيريلي/CJK/كوري/يوناني/تايلندي = مخالفة (تحمّل صفري)،
 *   ما لم يكتب المستخدم بذلك النظام صراحةً.
 * - رد بلغة خاطئة كليًا (عربي متوقّع لكن الرد لاتيني بالكامل تقريبًا) = مخالفة.
 * - كلمة لاتينية صغيرة دخيلة (loot، bajo) داخل رد عربي = مخالفة.
 * - رد بلغة أخرى (other): أنظمة غير مطلوبة فوق 5٪ = مخالفة.
 */
export function violatesLanguage(
  reply: string,
  expected: ExpectedLanguage,
  userText: string,
): { violated: boolean; reason?: string } {
  const r = scriptRatios(reply);

  const unwanted =
    (userUsesScript(userText, "cyrillic") ? 0 : r.cyrillic) +
    (userUsesScript(userText, "cjk") ? 0 : r.cjk) +
    r.otherUnwanted;

  if (expected === "ar") {
    // تحمّل صفري لأي نظام كتابة غير مطلوب داخل رد عربي
    if (unwanted > 0) return { violated: true, reason: "unwanted_scripts" };
  } else if (r.totalLetters >= 30 && unwanted / r.totalLetters > 0.05) {
    return { violated: true, reason: "unwanted_scripts" };
  }

  // رد لاتيني بالكامل تقريبًا على سؤال عربي — لغة خاطئة (أشمل من كلمة دخيلة)
  if (
    expected === "ar" &&
    r.totalLetters >= 80 &&
    r.arabic / r.totalLetters < 0.25 &&
    r.latin / r.totalLetters > 0.65
  ) {
    return { violated: true, reason: "wrong_language" };
  }

  // كلمات لاتينية صغيرة دخيلة داخل رد عربي غالبه عربي
  if (expected === "ar" && r.totalLetters >= 15) {
    if (findStrayLatinWords(reply).length > 0) {
      return { violated: true, reason: "stray_latin" };
    }
  }

  return { violated: false };
}

/** حجم نافذة الفحص الأولى بالأحرف (~100-150 token) — تحدد زمن أول token */
export const GUARD_WINDOW_CHARS = 400;

/**
 * حجم المقاطع التالية أثناء البثّ: أصغر بكثير ليبقى العرض سلسًا، وكافٍ لفحص
 * تسريبات الأنظمة الكتابية والكلمات الدخيلة. لا يؤثر في زمن أول token.
 */
export const GUARD_TAIL_CHARS = 120;

/** تداخل الفحص بالأحرف — يمنع نجاة كلمة دخيلة انقسمت بين مقطعين */
export const GUARD_OVERLAP_CHARS = 24;

/** رسالة فشل كل النماذج — تُعرض للمستخدم */
export const GUARD_FAILURE_MESSAGE =
  "تعذر الحصول على رد عربي بجودة مناسبة حاليًا. رسالتك محفوظة، حاول إعادة التوليد.";

/** ملحق صارم لموجه النظام عند إعادة المحاولة */
export const STRICT_LANGUAGE_SUFFIX =
  "\n\nتنبيه صارم: أجب حصريًا بلغة رسالة المستخدم الأخيرة. إن كانت بالعربية فاكتب بالعربية الفصحى فقط، ويُمنع منعًا باتًا إدراج أي كلمات أو جمل من لغات أخرى (إسبانية، روسية، صينية، يابانية…) باستثناء أسماء التقنيات والأكواد.";
