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

/**
 * فحص **وحدة بثّ** (جملة) قبل عرضها — بلا حدّ أدنى للطول.
 * الحدود الدنيا في violatesLanguage وُضعت لردّ كامل؛ تطبيقها على جملة قصيرة
 * كان يُنجي تسريبًا مثل «صرخ bajo.» (٧ أحرف فقط). هنا كلمة دخيلة واحدة تكفي.
 * قاعدة السماح نفسها: ما فيه حرف كبير اسم علم، والاختصارات والروابط والكود مستثناة.
 */
export function violatesStreamUnit(
  unit: string,
  expected: ExpectedLanguage,
  userText: string,
): { violated: boolean; reason?: string } {
  const r = scriptRatios(unit);
  const unwanted =
    (userUsesScript(userText, "cyrillic") ? 0 : r.cyrillic) +
    (userUsesScript(userText, "cjk") ? 0 : r.cjk) +
    r.otherUnwanted;

  if (expected === "ar") {
    if (unwanted > 0) return { violated: true, reason: "unwanted_scripts" };
    if (findStrayLatinWords(unit).length > 0) return { violated: true, reason: "stray_latin" };
    return { violated: false };
  }
  if (r.totalLetters >= 30 && unwanted / r.totalLetters > 0.05) {
    return { violated: true, reason: "unwanted_scripts" };
  }
  return { violated: false };
}

/** أقصى طول لوحدة بثّ بلا نهاية جملة — حدّ آمن يمنع الانتظار الطويل */
export const STREAM_UNIT_MAX_CHARS = 240;

/**
 * هل النقطة عند الموضع i نهاية جملة فعلية؟
 * ليست كذلك في حالتين شائعتين تُنتجان وحدات مبتورة:
 *   • مُعلّم قائمة مرقّمة في أول السطر: «1.» أو «2)» — النقطة جزء من المُعلّم.
 *   • رقم عشري: «3.5» — النقطة بين رقمين.
 */
function isSentenceEnd(buffer: string, i: number): boolean {
  const ch = buffer[i] ?? "";
  if (!/[.!?؟…\n؛]/.test(ch)) return false;
  if (ch !== ".") return true;

  const next = buffer[i + 1] ?? "";
  const prev = buffer[i - 1] ?? "";
  if (/\d/.test(prev) && /\d/.test(next)) return false; // رقم عشري

  if (/\d/.test(prev)) {
    // ابحث عن بداية الرقم ثم تحقّق أنه في أول السطر → مُعلّم قائمة
    let j = i - 1;
    while (j >= 0 && /\d/.test(buffer[j] ?? "")) j--;
    const before = buffer.slice(0, j + 1);
    if (/(^|\n)[ \t]*$/.test(before)) return false; // «1.» في أول السطر
  }
  return true;
}

/**
 * هل ينتهي النص بتمهيد معلّق بلا محتوى بعده؟
 * مثل «اتبع هذه الخطوات بدقة:» أو سطر فيه «1.» وحده — عرضه منفردًا يُنتج الرد
 * المبتور الذي رُصد حيًّا (عنوان ثم «1.» ثم عبارة الجودة).
 */
export function endsWithDanglingPreamble(text: string): boolean {
  const t = text.replace(/\s+$/, "");
  if (!t) return false;
  if (/[:：]$/.test(t)) return true; // عنوان/تمهيد ينتظر ما بعده
  const lastLine = (t.split("\n").pop() ?? "").trim();
  if (!lastLine) return false;
  // سطر لا يحمل إلا مُعلّم قائمة («1.» أو «2)» أو «-») بلا نص بعده
  return /^(?:\d+[.)]|[-*•])$/.test(lastLine);
}

/**
 * يقتطع من المخزن وحدات كاملة (تنتهي بعلامة نهاية جملة)، وإلا فعند حدّ آمن.
 * ready + rest = buffer دائمًا، فلا يضيع حرف من رد النموذج.
 *
 * v0.6.6: لا تُسلَّم وحدة تنتهي بتمهيد معلّق — يُتراجع إلى الحدّ الآمن السابق،
 * وإن لم يبقَ شيء يُحتجز كله حتى تصل خطوة كاملة. فلا يظهر عنوان ولا «1.» وحده.
 */
export function takeCompleteUnits(buffer: string): { ready: string; rest: string } {
  const ends: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    if (isSentenceEnd(buffer, i)) ends.push(i);
  }

  // جرّب أواخر الجمل من الأبعد إلى الأقرب، وتوقّف عند أول وحدة غير معلّقة
  for (let k = ends.length - 1; k >= 0; k--) {
    let e = (ends[k] ?? 0) + 1;
    while (e < buffer.length && /\s/.test(buffer[e] ?? "")) e++;
    const ready = buffer.slice(0, e);
    if (!endsWithDanglingPreamble(ready)) return { ready, rest: buffer.slice(e) };
  }

  if (buffer.length >= STREAM_UNIT_MAX_CHARS) {
    const cut = buffer.lastIndexOf(" ", STREAM_UNIT_MAX_CHARS);
    const at = cut > 40 ? cut + 1 : STREAM_UNIT_MAX_CHARS;
    const ready = buffer.slice(0, at);
    // حتى عند الحدّ الآمن: لا تُسلَّم بادئة معلّقة
    if (!endsWithDanglingPreamble(ready)) return { ready, rest: buffer.slice(at) };
  }
  return { ready: "", rest: buffer };
}

/**
 * تنقية التكملة (v0.6.5 RC4) — المقارنة على مستوى **الكلمات** لا الحروف.
 *
 * الإصدار السابق كان يطابق حرفيًا، فسقط حيًّا حين أعاد نموذج الاحتياط الردَّ من
 * أوله: ذيل المعروض ينتهي بفاصل فقرة لم يُعِده النموذج بنفس الصورة، ولا يوجد
 * تداخل بين ذيل المعروض وصدر التكملة — فلم يُقتطع شيء وظهر الرد مرتين.
 *
 * التطبيع يُهمل المسافات والأسطر المتكررة وعلامات الترقيم والاقتباس والتشكيل
 * والتطويل، ويوحّد صور الألف والياء والهاء — وكلّه للمقارنة فقط، والنص المعروض
 * يبقى كما ولّده النموذج.
 */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

function normalizeWord(w: string): string {
  return w
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

interface WordTok {
  w: string;
  start: number;
}

/** كلمات النص مع مواضعها — الترقيم والمسافات فواصل تُهمل تمامًا */
function tokenizeWords(s: string): WordTok[] {
  const out: WordTok[] = [];
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const w = normalizeWord(m[0]);
    if (w) out.push({ w, start: m.index });
  }
  return out;
}

/** أطول تطابق متصل بين متتاليتَي كلمات (لقياس نسبة التكرار) */
function longestCommonRun(a: WordTok[], b: WordTok[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = Math.min(a.length, 600);
  const B = Math.min(b.length, 600);
  let prev = new Array<number>(B + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= A; i++) {
    const cur = new Array<number>(B + 1).fill(0);
    for (let j = 1; j <= B; j++) {
      if (a[i - 1]!.w === b[j - 1]!.w) {
        const v = (prev[j - 1] ?? 0) + 1;
        cur[j] = v;
        if (v > best) best = v;
      }
    }
    prev = cur;
  }
  return best;
}

/** أقل تداخل يُعتدّ به عند نهاية المعروض */
const MIN_OVERLAP_WORDS = 4;
/** أقل بادئة تُعدّ «إعادة من البداية» */
const MIN_RESTART_WORDS = 5;
/** أقل نص جديد مفيد يستحق العرض */
const MIN_NEW_WORDS = 3;
/** فوق هذه النسبة من التكرار المتصل تُرفض التكملة */
const MAX_DUPLICATE_RATIO = 0.5;

export interface DedupeResult {
  text: string;
  /** هل تصلح التكملة للعرض؟ */
  ok: boolean;
  /** رمز القرار فقط — لا يحمل نصًا ولا كلمة مخالفة */
  reason: "ok" | "empty" | "no_new" | "duplicate";
}

/**
 * تُرجع الجزء الجديد فقط من تكملة نموذج الاحتياط، أو ترفضها كلها.
 * تكشف حالتين: إعادة الرد من بدايته، وتداخل ذيل المعروض مع صدر التكملة.
 */
export function dedupeContinuation(emitted: string, cont: string): DedupeResult {
  const c = cont.trim();
  if (!c) return { text: "", ok: false, reason: "empty" };
  if (!emitted.trim()) return { text: c, ok: true, reason: "ok" };

  const E = tokenizeWords(emitted);
  const C = tokenizeWords(c);
  if (C.length === 0) return { text: "", ok: false, reason: "empty" };

  // (١) إعادة من البداية: أطول بادئة مشتركة بين صدر التكملة وصدر المعروض
  let head = 0;
  while (head < C.length && head < E.length && C[head]!.w === E[head]!.w) head++;

  // (٢) تداخل: أطول L بحيث أول L كلمة من التكملة = آخر L كلمة من المعروض
  let overlap = 0;
  const maxL = Math.min(C.length, E.length, 400);
  for (let L = maxL; L >= MIN_OVERLAP_WORDS; L--) {
    let same = true;
    for (let i = 0; i < L; i++) {
      if (C[i]!.w !== E[E.length - L + i]!.w) {
        same = false;
        break;
      }
    }
    if (same) {
      overlap = L;
      break;
    }
  }

  const cut = Math.max(
    head >= MIN_RESTART_WORDS ? head : 0,
    overlap >= MIN_OVERLAP_WORDS ? overlap : 0,
  );

  if (C.length - cut < MIN_NEW_WORDS) return { text: "", ok: false, reason: "no_new" };

  const text = c
    .slice(C[cut]!.start)
    .replace(/^[\s\p{P}]+/u, "")
    .trim();
  if (!text) return { text: "", ok: false, reason: "no_new" };

  // (٣) شبكة أمان: ما تبقّى ما زال يكرّر المعروض بنسبة كبيرة → لا يُعرض
  const rest = tokenizeWords(text);
  if (rest.length < MIN_NEW_WORDS) return { text: "", ok: false, reason: "no_new" };
  if (longestCommonRun(rest, E) / rest.length >= MAX_DUPLICATE_RATIO) {
    return { text: "", ok: false, reason: "duplicate" };
  }

  return { text, ok: true, reason: "ok" };
}

/** غلاف نصّي مباشر فوق dedupeContinuation */
export function stripRepeatedPrefix(emitted: string, cont: string): string {
  return dedupeContinuation(emitted, cont).text;
}

/** يُلحق بالموجّه عند طلب متابعة الرد بعد تسريب — بلا إعادة بداية */
export const CONTINUATION_SUFFIX =
  "\n\nتنبيه: أكمل النص السابق من حيث انتهى تمامًا، بالعربية فقط. لا تُعِد أي جزء سبق، ولا تبدأ من جديد، ولا تكتب مقدمة ولا اعتذارًا — واصل مباشرة، ويُمنع إدراج أي كلمة من لغة أخرى.";

/** إنهاء لطيف عند آخر جملة نظيفة حين يتعذّر الإكمال — بلا رسالة خطأ */
export const TRUNCATED_NOTICE = "\n\nتوقفت هنا للحفاظ على جودة الرد.";

/** رسالة فشل كل النماذج — تُعرض للمستخدم */
export const GUARD_FAILURE_MESSAGE =
  "تعذر الحصول على رد عربي بجودة مناسبة حاليًا. رسالتك محفوظة، حاول إعادة التوليد.";

/** ملحق صارم لموجه النظام عند إعادة المحاولة */
export const STRICT_LANGUAGE_SUFFIX =
  "\n\nتنبيه صارم: أجب حصريًا بلغة رسالة المستخدم الأخيرة. إن كانت بالعربية فاكتب بالعربية الفصحى فقط، ويُمنع منعًا باتًا إدراج أي كلمات أو جمل من لغات أخرى (إسبانية، روسية، صينية، يابانية…) باستثناء أسماء التقنيات والأكواد.";
