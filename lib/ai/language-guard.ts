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
  // كلمات محجوزة وشائعة في البرمجة (v0.7.0 RC7): تَرِد داخل نثر عربي عند شرح
  // الكود («استخدم const بدل let»)، وليست تسريبًا لغويًا. الكود داخل الأسيجة
  // يُجرَّد أصلًا قبل الفحص؛ هذه للحالات النثرية وحدها.
  "const", "let", "var", "function", "return", "class", "interface", "type", "enum",
  "import", "export", "from", "default", "extends", "implements", "public", "private",
  "protected", "static", "readonly", "new", "this", "super", "try", "catch", "finally",
  "throw", "for", "while", "break", "continue", "switch", "case", "else", "elif",
  "def", "lambda", "pass", "yield", "with", "and", "not", "none", "self", "print",
  "select", "insert", "update", "delete", "where", "join", "group", "order", "limit",
  "table", "index", "primary", "foreign", "unique", "constraint", "schema", "query",
  "props", "state", "hook", "component", "render", "props", "params", "args", "kwargs",
  "string", "number", "boolean", "float", "array", "object", "list", "dict", "tuple",
  "promise", "callback", "error", "exception", "warning", "debug", "trace", "stack",
  "commit", "branch", "merge", "rebase", "clone", "push", "pull", "fetch", "checkout",
  "build", "test", "lint", "deploy", "server", "client", "route", "router", "handler",
  "config", "module", "package", "install", "run", "start", "stop", "restart", "log",
]);

/**
 * يستخرج الكلمات اللاتينية الصغيرة الدخيلة في نص (كلها أحرف صغيرة، طولها ≥3،
 * ليست اختصارًا/مصطلحًا معروفًا). يُجرَّد الكود والروابط والبريد أولًا،
 * وأي رمز فيه حرف كبير يُعدّ اسم علم أو اختصارًا فيُتجاوز.
 */
export function findStrayLatinWords(
  text: string,
  /**
   * مفردات لاتينية **مسنَدة إلى المصدر**: مستخرَجة من المقاطع التي دخلت
   * الموجّه فعلًا. ما ورد في ملف المستخدم ليس تسريبًا لغويًا.
   */
  sourceVocabulary?: ReadonlySet<string>,
): string[] {
  const stripped = stripNonProse(text);
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z.\-'’]*[A-Za-z]|[A-Za-z]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const raw = m[0];
    if (/[A-Z]/.test(raw)) continue; // فيه حرف كبير → اسم علم/اختصار مسموح (White Mask, RAG)
    const word = raw.replace(/[.\-'’]/g, "").toLowerCase();
    if (word.length < 3) continue; // رموز قصيرة (js, id, ok) تُتجاهل
    if (LATIN_ALLOW.has(word)) continue; // اختصار/مصطلح معروف
    if (sourceVocabulary?.has(word)) continue; // ★ ورد في مقاطع المستخدم
    out.push(raw);
  }
  return out;
}

/**
 * تجريد ما ليس نثرًا: الشيفرة والروابط والبريد — **وغلاف الأدلة الآلي**.
 *
 * ── لماذا الغلاف هنا ──
 *
 * `<<<YSD_EVIDENCE_V1>>>{"quotes":[{"marker":1,…}]}` بروتوكولٌ بين النموذج
 * والخادم، لا كلامٌ موجَّه للقارئ. وهو ASCII صغير بالكامل: `quotes` و`marker`
 * و`quote` كلمات لاتينية ليست في قائمة السماح، فيقرأها حارس اللغة **نثرًا
 * دخيلًا** ويقطع ردًّا عربيًا سليمًا.
 *
 * وقع هذا حيًّا (رسالة efa22e00…): ردّ عربي بالكامل صُنّف
 * `incomplete_guard / stray_latin`، فقُطع الغلاف معه، فوصل المستخرِج تالفًا،
 * فحُفظت الرسالة بصفر مصادر. والأسماء اللاتينية لم تكن السبب — هي بحرف كبير
 * فتمرّ أصلًا.
 *
 * التجريد هنا لا في المستدعي: كل فاحص لغة يمرّ بهذه الدالة، فلا يبقى مسار
 * يقرأ الغلاف نثرًا.
 */
function stripNonProse(text: string): string {
  return text
    // الغلاف أولًا: قد يحوي ``` داخل الاقتباس فيربك تجريد الأسيجة
    .replace(/<<<YSD_EVIDENCE_V1>>>[\s\S]*?(?:<<<END_YSD_EVIDENCE_V1>>>|$)/g, " ")
    // وسنتينل يتيم أو مبتور — يبقى بروتوكولًا لا نثرًا
    .replace(/<<<END_YSD_EVIDENCE_V1>>>/g, " ")
    .replace(/<<<YSD_EVIDENCE_V1>>>/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, " ");
}

/**
 * أقصى عدد كلمات لاتينية متتالية يُسمح به في نثر عربي **مهما كان مصدرها**.
 *
 * السماح المسنَد إلى المصدر يفتح ثغرة: ردٌّ إنجليزي كامل مبنيّ من مفردات وردت
 * كلها في الملف يمرّ كلمةً كلمة. والسقف يغلقها — عبارة مقتبسة تمرّ، وفقرة
 * إنجليزية لا.
 */
export const MAX_LATIN_WORD_RUN = 8;

/**
 * أطول تسلسل كلمات لاتينية متتالية في النثر — بلا استثناء لأي قائمة سماح.
 *
 * يعمل حتى حين تكون كل كلمة مشروعة بمفردها: المقصود شكل النصّ لا مفرداته.
 */
export function longestLatinWordRun(text: string): number {
  const stripped = stripNonProse(text);
  let best = 0;
  let run = 0;
  // أي مقطع عربي يكسر التسلسل؛ الترقيم والأرقام لا تكسره
  for (const token of stripped.split(/\s+/)) {
    if (token === "") continue;
    if (/[؀-ۿ]/.test(token)) {
      run = 0;
      continue;
    }
    if (/[A-Za-z]{2,}/.test(token)) {
      run++;
      if (run > best) best = run;
    }
  }
  return best;
}

/**
 * تجريد الكود من **وحدة بثّ** مع معرفة حالة السياج عند بدايتها (v0.7.0 RC7).
 *
 * السبب الجذري الذي عالجه هذا: أثناء البثّ تُفحص كل جملة على حدة، وسطر الكود
 * الواحد لا يحمل سياجه معه — فكان `const x = getUser()` يصل إلى فاحص النثر
 * فيُقرأ كأنه عربية مخلوطة بكلمات دخيلة، فيُقطع الرد البرمجي السليم.
 *
 * الحل: تتبّع حالة السياج عبر البثّ كله، وتجريد ما هو **داخل** الكود قبل
 * الفحص. النثر العربي خارج الكود يبقى مفحوصًا بالكامل بلا أي تخفيف.
 */
export function stripCodeAware(
  unit: string,
  startsInsideCode: boolean,
): { prose: string; endsInsideCode: boolean } {
  let inside = startsInsideCode;
  let prose = "";
  // نقسم على سياج ``` مع الاحتفاظ بالفواصل لتتبّع التبديل بدقّة
  const parts = unit.split(/(```)/);
  for (const part of parts) {
    if (part === "```") {
      inside = !inside;
      continue;
    }
    if (!inside) prose += part;
    else prose += " "; // داخل الكود → لا يُفحص كنثر
  }
  // الكود المضمّن `...` داخل النثر يُجرَّد أيضًا
  prose = prose.replace(/`[^`\n]*`/g, " ");
  return { prose, endsInsideCode: inside };
}

/**
 * هل هذا **طلب برمجي**؟ (v0.7.0 RC7 — بوابة Bash)
 *
 * تصنيف عام لا يرتبط بلغة بعينها: الطلب برمجي إن ذُكر فعل برمجي، أو اسم لغة/
 * إطار/صدفة، أو ورد سياج أو كود مضمّن، أو امتداد ملف، أو أمر طرفية أو خطأ
 * مترجم. الغرض الوحيد: توسيع ما يُقبل من **مصطلحات تقنية مفردة** في النثر
 * العربي المرافق للكود — لا تعطيل أي حارس.
 */
export function isCodeRequest(userText: string): boolean {
  const t = userText.toLowerCase();
  if (/```|`[^`\n]+`/.test(userText)) return true; // سياج أو كود مضمّن
  if (/\.(ts|tsx|js|jsx|py|sql|sh|bash|json|ya?ml|css|html|rs|go|java|rb|php|c|cpp)\b/.test(t))
    return true; // امتداد ملف
  if (/\b(ts\d{4}|error\s+[a-z]+\d+|traceback|stack\s*trace|exception|segmentation fault)\b/.test(t))
    return true; // خطأ مترجم أو أثر مكدس
  if (/(^|\s)(sudo|npm|npx|pip|git|docker|curl|chmod|grep|awk|sed|kubectl|yarn|pnpm)\s/.test(t))
    return true; // أمر طرفية
  const langs =
    /\b(typescript|javascript|python|java|kotlin|swift|rust|golang|php|ruby|scala|sql|bash|shell|zsh|powershell|react|vue|angular|svelte|next\.?js|node\.?js|django|flask|laravel|express|docker|kubernetes|postgres|postgresql|mysql|mongodb|redis|regex|api|json|yaml|html|css|tailwind)\b/;
  const verbs =
    /(اكتب|أكتب|اشرح|صحّح|صحح|راجع|عدّل|عدل|حسّن|أصلح|اصلح|نفّذ|برمج|كود|سكربت|دالة|استعلام|مكوّن|مكون|أمر|سطر أوامر|خطأ|debug|refactor|implement|write|explain|fix|review)/;
  return langs.test(t) && verbs.test(userText);
}

/**
 * هل هذا الرمز اللاتيني **مصطلح تقني** لا كلمة لغة طبيعية؟
 *
 * يُقبل حين يحمل شكلًا برمجيًا لا يظهر في النثر الطبيعي: مسار، امتداد، راية،
 * نقطة/شرطة سفلية/شرطة داخلية، camelCase، أقواس نداء، أو رمز حالة. هذا يفصل
 * `package.json` و`src/app/page.tsx` و`--force` و`useState()` عن `bajo`.
 */
export function looksTechnical(token: string): boolean {
  if (/^--?[a-z][a-z0-9-]*$/i.test(token)) return true; // راية: --force
  if (/[/\\]/.test(token)) return true; // مسار: src/app/page.tsx
  if (/\.[a-z0-9]{1,5}$/i.test(token)) return true; // امتداد: package.json
  if (/[_.]/.test(token)) return true; // snake_case أو نقطة داخلية
  if (/[a-z][A-Z]/.test(token)) return true; // camelCase: useState
  if (/\(\)$/.test(token)) return true; // نداء دالة
  if (/\d/.test(token)) return true; // رمز/إصدار: TS2345، ES2022
  return false;
}

/** هل ينتهي النص بسياج كود مفتوح؟ (عدد ``` فردي) */
export function endsInsideCodeFence(text: string): boolean {
  return (text.match(/```/g) ?? []).length % 2 === 1;
}

/**
 * أطول تسلسل من كلمات لاتينية دخيلة **متجاورة** في النص (v0.7.0 RC7).
 *
 * الفكرة الفاصلة: الكلمة التقنية المفردة تعيش داخل نثر عربي («استخدم gzip
 * لضغط الملفات») فيقطعها حرف عربي من الجانبين، بينما الجملة الأجنبية تأتي
 * ككتلة متصلة («bajo el sol»، «hola amigo»). فنعدّ التجاور: أي حرف عربي بين
 * كلمتين دخيلتين يكسر التسلسل.
 *
 * هكذا نسمح بالمصطلح التقني المفرد بلا أن نفتح الباب لجملة أجنبية كاملة.
 */
export function longestStrayLatinRun(
  text: string,
  sourceVocabulary?: ReadonlySet<string>,
): number {
  const stripped = stripNonProse(text);

  const re = /[A-Za-z][A-Za-z.\-'’/\\_()]*[A-Za-z)]|[A-Za-z]/g;
  let m: RegExpExecArray | null;
  let best = 0;
  let run = 0;
  let prevEnd = -1;

  while ((m = re.exec(stripped)) !== null) {
    const raw = m[0];
    const bare = raw.replace(/[.\-'’/\\_()]/g, "").toLowerCase();
    const isStray =
      !/[A-Z]/.test(raw) &&
      bare.length >= 3 &&
      !LATIN_ALLOW.has(bare) &&
      !sourceVocabulary?.has(bare) && // ★ ورد في مقاطع المستخدم
      !looksTechnical(raw);

    if (!isStray) {
      // رمز معروف/تقني/كبير الحرف لا يُعدّ دخيلًا ولا يكسر التسلسل بذاته
      prevEnd = re.lastIndex;
      continue;
    }
    // هل يفصل بينها وبين سابقتها حرف عربي؟ → تسلسل جديد
    const between = prevEnd >= 0 ? stripped.slice(prevEnd, m.index) : "";
    run = prevEnd >= 0 && !/[؀-ۿ]/.test(between) ? run + 1 : 1;
    best = Math.max(best, run);
    prevEnd = re.lastIndex;
  }
  return best;
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
  sourceVocabulary?: ReadonlySet<string>,
): { violated: boolean; reason?: string } {
  /**
   * النسب تُحسب على **النثر** لا على النصّ الخام.
   *
   * غلاف الأدلة ASCII بالكامل، فردٌّ عربي قصير معه غلاف كبير كان يبدو «لاتينيًا
   * غالبًا» فيسقط في `wrong_language` — عطبٌ من نفس الجذر الذي أسقط
   * `stray_latin`، ولا يظهر إلا على الردود القصيرة.
   */
  const prose = stripNonProse(reply);
  const r = scriptRatios(prose);

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
    if (findStrayLatinWords(reply, sourceVocabulary).length > 0) {
      return { violated: true, reason: "stray_latin" };
    }
    /**
     * ★ السقف يغلق ثغرة السماح المسنَد: فقرةٌ إنجليزية كاملة قد تكون كل
     * مفرداتها واردة في الملف، فتمرّ كلمةً كلمة وهي ليست جوابًا عربيًا.
     * المقصود هنا شكل النصّ لا مفرداته.
     */
    if (longestLatinWordRun(reply) > MAX_LATIN_WORD_RUN) {
      return { violated: true, reason: "wrong_language" };
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
  /** حالة سياج الكود عند بداية الوحدة (v0.7.0 RC7) — الكود لا يُفحص كنثر */
  startsInsideCode = false,
  sourceVocabulary?: ReadonlySet<string>,
): { violated: boolean; reason?: string } {
  // نفحص النثر وحده: ما كان داخل ``` أو `…` يخرج من الحساب كليًا
  const { prose } = stripCodeAware(unit, startsInsideCode);
  if (prose.trim() === "") return { violated: false };
  unit = prose;
  const r = scriptRatios(unit);
  const unwanted =
    (userUsesScript(userText, "cyrillic") ? 0 : r.cyrillic) +
    (userUsesScript(userText, "cjk") ? 0 : r.cjk) +
    r.otherUnwanted;

  if (expected === "ar") {
    // الأنظمة الكتابية غير المطلوبة (سيريلي/صيني/ياباني/يوناني) تبقى بتحمّل صفري
    // في كل الأوضاع — البرمجة لا تُرخّص شيئًا منها.
    if (unwanted > 0) return { violated: true, reason: "unwanted_scripts" };

    // في الإجابة البرمجية: المصطلح التقني المفرد خارج السياج مقبول («استخدم
    // gzip لضغط الملفات»)، أما تسلسل كلمتين طبيعيتين فأجنبيّة تُمنع كما كانت.
    if (isCodeRequest(userText)) {
      if (longestStrayLatinRun(unit, sourceVocabulary) >= 2) {
        return { violated: true, reason: "stray_latin" };
      }
      return { violated: false };
    }

    if (findStrayLatinWords(unit, sourceVocabulary).length > 0) {
      return { violated: true, reason: "stray_latin" };
    }
    // السقف يبقى مطبَّقًا ولو كانت كل المفردات مسنَدة إلى المصدر
    if (longestLatinWordRun(unit) > MAX_LATIN_WORD_RUN) {
      return { violated: true, reason: "wrong_language" };
    }
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

/**
 * لاحقة الرد غير المكتمل مع إغلاق آمن للسياج (v0.7.0 RC8).
 *
 * رُصد حيًّا: رد انقطع داخل كتلة كود فأُلحقت العبارة **داخل** السياج المفتوح،
 * فظهرت للمستخدم كأنها سطر كود، وبقي السياج فرديًا فانكسر عرض Markdown كله.
 *
 * هنا نغلق السياج **للعرض فقط** — لا نخترع بقية الكود ولا نكمله — ثم نضع
 * التنبيه في فقرة مستقلة خارج الكتلة.
 */
export function buildIncompleteSuffix(emitted: string): string {
  const closeFence = endsInsideCodeFence(emitted) ? "\n```" : "";
  return `${closeFence}${TRUNCATED_NOTICE}`;
}

/** تنبيه الرد الناقص الموحّد — يُعرض خارج الكود دائمًا */
export const INCOMPLETE_NOTICE_TEXT = "لم يكتمل هذا الرد. يمكنك إعادة التوليد.";

/**
 * يُنهي نصًّا جزئيًا بعقد Markdown آمن (v0.7.0 RC8).
 *
 * يُغلق السياج المفتوح **للعرض والحفظ معًا** فيبقى عدد الأسيجة زوجيًا، ثم
 * يضع التنبيه في فقرة مستقلة بعده. لا يُكمل الكود ولا يخترع محتوى.
 *
 * **idempotent**: استدعاؤه مرتين لا يكرّر السياج ولا التنبيه — فمسارات
 * الإنهاء متعددة (مهلة/مزوّد/حارس) وقد تتلاقى.
 */
export function finalizeIncompleteText(text: string): string {
  let out = text.replace(/\s+$/, "");
  if (endsInsideCodeFence(out)) out += "\n```";
  const hasNotice =
    out.includes(INCOMPLETE_NOTICE_TEXT) || out.includes(TRUNCATED_NOTICE.trim());
  if (!hasNotice) out += `\n\n${INCOMPLETE_NOTICE_TEXT}`;
  return out;
}

/** هل ينتهي النص بجملة عربية مكتملة؟ (علامة نهاية، وبلا تمهيد معلّق) */
export function endsWithCompleteSentence(text: string): boolean {
  const t = text.replace(/\s+$/, "");
  if (!t) return false;
  if (endsWithDanglingPreamble(t)) return false;
  // كتلة كود مغلقة نهايةٌ مكتملة تمامًا (v0.7.0 RC7): الرد البرمجي السليم ينتهي
  // بسياج ``` لا بنقطة، وكان ذلك يُصنَّف «مبتورًا» فتُلحق به عبارة الجودة.
  // الشرط: عدد الأسيجة زوجي (كل ما فُتح أُغلق) وآخر ما في النص سياج مغلق.
  if (/```\s*$/.test(t) && !endsInsideCodeFence(t)) return true;
  // علامة نهاية جملة، ويُسمح بعدها بعلامات إغلاق (اقتباس/قوس)
  return /[.!?؟…][»"'’”)\]]*$/.test(t);
}

/** أقل عدد كلمات يجعل النص إجابةً مفيدة لا مجرد بادئة */
const USEFUL_MIN_WORDS = 12;

/** هل ما عُرض إجابة مفيدة قائمة بذاتها؟ */
export function isUsefulReply(text: string): boolean {
  // كتلة كود مغلقة ذات محتوى = إجابة قائمة بذاتها (v0.7.0 RC7). عدّ الكلمات
  // وحده كان يَعدّ ردًّا برمجيًا صحيحًا وقصيرًا «غير مفيد» فتُلحق به عبارة
  // الجودة، مع أن استعلام SQL من سطر واحد إجابة كاملة تمامًا.
  const closedCode = /```[^\n]*\n([\s\S]*?)\n?```/.exec(text);
  if (closedCode && (closedCode[1] ?? "").trim().length >= 10) return true;
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length >= USEFUL_MIN_WORDS;
}

/**
 * هل نختم بعبارة الجودة؟ (v0.6.6 RC2)
 * لا: إن كان المعروض إجابة مفيدة تنتهي بجملة مكتملة — نُنهي بصمت، فالعبارة
 * حينها ضجيج يوحي بعطل بينما الرد سليم تمامًا.
 * نعم: حين لا يوجد نص مفيد، أو حين تكون البنية ناقصة فعلًا (جملة مبتورة أو
 * تمهيد معلّق) — فالمستخدم يستحق أن يعرف أن الرد لم يكتمل.
 */
export function shouldAppendTruncatedNotice(emitted: string): boolean {
  if (!isUsefulReply(emitted)) return true;
  return !endsWithCompleteSentence(emitted);
}

/** رسالة فشل كل النماذج — تُعرض للمستخدم */
export const GUARD_FAILURE_MESSAGE =
  "تعذر الحصول على رد عربي بجودة مناسبة حاليًا. رسالتك محفوظة، حاول إعادة التوليد.";

/** ملحق صارم لموجه النظام عند إعادة المحاولة */
export const STRICT_LANGUAGE_SUFFIX =
  "\n\nتنبيه صارم: أجب حصريًا بلغة رسالة المستخدم الأخيرة. إن كانت بالعربية فاكتب بالعربية الفصحى فقط، ويُمنع منعًا باتًا إدراج أي كلمات أو جمل من لغات أخرى (إسبانية، روسية، صينية، يابانية…) باستثناء أسماء التقنيات والأكواد.";

/**
 * يبني مفردات لاتينية **مسنَدة إلى المصدر** من المقاطع التي دخلت الموجّه.
 *
 * ── لماذا المصدر يُرخّص ──
 *
 * حارس اللغة يفترض أن كل كلمة لاتينية صغيرة في ردّ عربي تسريبٌ من النموذج.
 * والافتراض صحيح إلا حين يكون المستخدم نفسه قد رفع ملفًا فيه تلك الكلمة:
 * «pgvector» في تقريره ليست تسريبًا، ونقلُها إليه هو الجواب الصحيح.
 *
 * والسماح **محصور بما ورد فعلًا**: لا قائمة عامة تتوسّع، بل مفردات هذا الطلب
 * وحده. وما ليس في ملفه يبقى مرفوضًا كما كان.
 *
 * التطبيع محافظ: خفض الحالة وتجريد الترقيم الملاصق — بلا جذوع ولا تقريب،
 * فلا تتسرّب كلمة قريبة الشكل من كلمة موجودة.
 */
export function buildSourceVocabulary(
  snippets: readonly { content: string; fileName?: string }[],
  /** سقف الحجم — يمنع ملفًا ضخمًا من بناء قاموس بلا حدّ */
  maxWords = 5_000,
): ReadonlySet<string> {
  const vocab = new Set<string>();
  for (const s of snippets) {
    if (vocab.size >= maxWords) break;
    for (const field of [s.content, s.fileName ?? ""]) {
      if (typeof field !== "string" || field.length === 0) continue;
      const re = /[A-Za-z][A-Za-z.\-'’_]*[A-Za-z]|[A-Za-z]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(field)) !== null) {
        if (vocab.size >= maxWords) break;
        const bare = m[0].replace(/[.\-'’_]/g, "").toLowerCase();
        if (bare.length >= 3) vocab.add(bare);
      }
    }
  }
  return vocab;
}
