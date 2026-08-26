/**
 * كشفُ نيّةِ توليد صورة — حتميٌّ، بلا نموذجٍ ولا نداءٍ مدفوع.
 *
 * ── لماذا لا مصنّف ──
 *
 * مصنّفٌ لغويّ يكلّف نداءً لكلِّ رسالة، وهذه ميزةٌ قاعدتُها ألّا تكلّف
 * شيئًا. والقواعدُ الصريحة تُقرأ وتُراجَع وتُختبر، والنموذجُ يُصيب ويُخطئ
 * بلا تفسير.
 *
 * ── والقاعدةُ الحاكمة: الصمتُ عند الشكّ ──
 *
 * ★ الخطأُ هنا ليس متماثلًا.
 *
 * أن تفوتَنا نيّةٌ صحيحة ⇒ يكتب المستخدمُ طلبَه بصيغةٍ أوضح. مقبول.
 * أن نختطفَ سؤالًا عاديًّا ⇒ يسأل عن صورةٍ فنعرض عليه توليدَ صورة، فيبدو
 * المنتجُ كأنه لا يفهم. غيرُ مقبول.
 *
 * فحين لا يتّضح المرادُ يبقى السلوكُ الطبيعيّ للمحادثة. ولا «ربما».
 */

/**
 * أفعالُ الطلب — ما يدلّ على **إنشاءِ** صورةٍ لا الحديثِ عنها.
 *
 * ولا يكفي ذكرُ «صورة»: أكثرُ ما يُكتب فيه اللفظُ أسئلةٌ عنها.
 */
const AR_VERBS = [
  "ولد", "ولّد", "وَلِّد", "أنشئ", "انشئ", "أنشىء",
  "صمم", "صمّم", "ارسم", "إرسم", "اصنع", "إصنع",
  "اعمل", "إعمل", "جهز", "جهّز",
];

const EN_VERBS = ["generate", "create", "make", "draw", "render", "design"];

/** أسماءُ المُنتَج — صورةٌ أو ما يقوم مقامها */
const AR_NOUNS = ["صورة", "صوره", "رسمة", "رسمه", "تصميم", "لوحة", "شعار", "بوستر"];
const EN_NOUNS = ["image", "picture", "photo", "illustration", "drawing", "artwork", "logo", "poster"];

/**
 * ★ ما يقلب الطلبَ إلى سؤالٍ عن صورة.
 *
 * «ما هي أفضل صورة…» و«كيف أنشئ صورة في برنامج…» و«اشرح لي هذه الصورة»:
 * كلُّها تحوي الفعلَ والاسمَ معًا، وليست طلبَ توليد.
 *
 * فوجودُ أيٍّ من هذه في مقدّمة الرسالة يمنع الكشفَ صراحةً.
 */
const AR_QUESTION_MARKERS = [
  "ما هي", "ما هو", "ماهي", "ماهو", "كيف", "لماذا", "لماذَا", "هل", "متى", "أين", "اين",
  "اشرح", "إشرح", "وضح", "وضّح", "علمني", "علّمني", "ما الفرق", "أفضل", "افضل",
];
const EN_QUESTION_MARKERS = [
  "what", "how", "why", "when", "where", "which", "who",
  "explain", "describe", "tell me about", "difference between", "best way",
];

/**
 * ما يدلّ على أنّ الحديثَ عن صورةٍ **قائمةٍ** لا مطلوبة.
 * «هذه الصورة» و«الصورة المرفقة» و«في الصورة أعلاه».
 */
const AR_REFERENTIAL = ["هذه الصورة", "هذه الصوره", "الصورة المرفقة", "الصورة أعلاه", "الصورة التي", "في الصورة"];
const EN_REFERENTIAL = ["this image", "the image above", "attached image", "the picture above", "in the image", "uploaded image"];

export interface ImageIntent {
  /** أنُعرض التوليدَ المحلّيّ؟ */
  detected: boolean;
  /** ما يُمرَّر إلى المحرّك بعد نزع فعل الطلب */
  prompt: string;
  /** سببُ القرار — يُعين على المراجعة ولا يُعرض للمستخدم */
  reason: string;
}

const NO: (reason: string) => ImageIntent = (reason) => ({ detected: false, prompt: "", reason });

/**
 * يُطبّع النصَّ للمطابقة: تُوحَّد الألفُ والياءُ والتاءُ المربوطة،
 * وتُنزع التشكيلُ والتطويل.
 *
 * ★ وبلا هذا تفوت «أنشئ» من كتب «انشئ»، وهي كتابةٌ شائعةٌ جدًّا.
 */
function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function normalize(text: string): string {
  return normalizeArabic(text.toLowerCase().trim()).replace(/\s+/g, " ");
}

/**
 * يكشف نيّةَ التوليد.
 *
 * والشرطُ مركّب: فعلُ طلبٍ **و** اسمُ صورة **و** غيابُ علاماتِ السؤال
 * والإحالة. وثلاثتُها معًا — فأيُّ واحدٍ وحده يُنتج اختطافًا.
 */
export function detectImageIntent(raw: string): ImageIntent {
  if (typeof raw !== "string") return NO("not_a_string");
  const text = raw.trim();
  if (text.length === 0) return NO("empty");
  /** رسالةٌ طويلة جدًّا غالبًا سياقٌ لا أمر */
  if (text.length > 1200) return NO("too_long");

  const norm = normalize(text);

  /** ★ السؤالُ يُفحص أوّلًا — فهو المانعُ الأقوى */
  const head = norm.slice(0, 40);
  for (const m of [...AR_QUESTION_MARKERS, ...EN_QUESTION_MARKERS]) {
    if (head.includes(normalize(m))) return NO(`question_marker:${m}`);
  }
  if (norm.includes("؟") || text.includes("?")) return NO("interrogative");

  for (const r of [...AR_REFERENTIAL, ...EN_REFERENTIAL]) {
    if (norm.includes(normalize(r))) return NO(`referential:${r}`);
  }

  const hasNoun = [...AR_NOUNS, ...EN_NOUNS].some((n) => norm.includes(normalize(n)));
  if (!hasNoun) return NO("no_image_noun");

  const verb = [...AR_VERBS, ...EN_VERBS].find((v) => {
    const nv = normalize(v);
    /**
     * ★ الفعلُ يُطلب في مقدّمة الرسالة.
     *
     * فـ«أخبرني عن برنامجٍ يصمم صورًا» يحوي الفعلَ والاسمَ، لكنّ الفعلَ
     * في وسط الكلام وصفًا لبرنامجٍ آخر لا أمرًا لنا.
     */
    return norm.slice(0, 30).includes(nv);
  });
  if (!verb) return NO("no_request_verb_at_start");

  /** يُنزع فعلُ الطلب وما يتبعه من أدوات كي يبقى الوصفُ وحده */
  const stripped = text.trim()
    .replace(/^(ولّد|ولد|أنشئ|انشئ|صمّم|صمم|ارسم|إرسم|اصنع|إصنع|اعمل|إعمل|جهّز|جهز)\s*/iu, "")
    .replace(/^(generate|create|make|draw|render|design)\s+/i, "")
    .replace(/^(لي|لنا|me|us)\s*/iu, "")
    .replace(/^(صورة|صوره|رسمة|رسمه|تصميم|an?|the)\s*/iu, "")
    .replace(/^(image|picture|photo|illustration|drawing)\s*/i, "")
    .replace(/^(of|عن|ل)\s*/iu, "")
    .trim();

  /**
   * ★ ما بقي بعد النزع هو الوصف — وإن لم يبقَ شيءٌ فلا وصف.
   *
   * كنتُ أسقط عند قصرِ الباقي إلى النصِّ الأصليّ كاملًا، فيمرّ «ولد صورة»
   * بوصفٍ هو الأمرُ نفسه. فيُطلب من النموذج أن يرسم عبارةَ «ولد صورة» —
   * وهو ليس وصفًا لشيء.
   *
   * والصوابُ أن يُترك للمحادثة: من قال «ولد صورة» ولم يقل ماذا، جوابُه
   * سؤالٌ عمّا يريد، لا صورةٌ عشوائية.
   */
  if (stripped.length < 3) return NO("no_description_after_verb");

  return { detected: true, prompt: stripped, reason: `verb:${verb}` };
}
