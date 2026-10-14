/**
 * من Markdown إلى نصٍّ يُقرأ — دوالُّ محضة، بلا متصفّحٍ ولا حالة.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا لا يُقرأ ما في الصفحة
 *
 *  الصفحةُ تحمل ما ليس من الرد: أزرارَ الاستشهاد، وشارةَ «غير موثّق»،
 *  واسمَ لغةِ كتلة الكود، وزرَّ نسخها. فيُشتقّ المقروءُ من نصّ الرسالة
 *  الخام وحدَه — والمحرّكُ لا ينطق «نجمتان» ولا «شرطةٌ مائلة».
 *
 *  ★ وما يُترك عمدًا
 *
 *  كتلُ الكود المسيَّجة لا تُقرأ: سردُ الأقواس والفواصل المنقوطة ضجيجٌ
 *  لا يُفهم سماعًا. والروابطُ يُقرأ نصُّها لا عنوانُها. والجداولُ تُقرأ
 *  خلاياها بالترتيب. وكلُّ هذا موثَّقٌ في docs/browser-voice.md ومثبَّتٌ
 *  بالاختبار — فتغييرُه قرارٌ لا مصادفة.
 *
 *  ★ والخطأُ هنا يُسمع
 *
 *  ما يُحذف بغير حقّ كلامٌ لم يُقرأ، وما يبقى بغير حقّ ضجيجٌ يُنطق. و«2**3»
 *  التي تصير «23» رقمٌ ليس في الرد. فالنجمةُ بين رقمين ليست توكيدًا،
 *  والزاويةُ في `a<b` ليست وسمًا، و```x``` على سطرٍ واحد كودٌ سطريّ لا
 *  سياج، و«[المستخدم]: …» كلامٌ لا تعريفُ رابط — وكلٌّ منها محروسٌ باختبار.
 *
 *  ★ والكودُ السطريّ لا تمسّه قاعدة
 *
 *  يُستبدل برمزٍ معتمٍ قبل أيّ تحويل ويُعاد بعده: فلا يُحذف عنوانٌ فيه،
 *  ولا تُفكّ كياناتُه، ولا تُعدّ نجمتُه توكيدًا.
 *
 *  ★ ولا تعبيرَ يتراجع بلا حدّ
 *
 *  الدالّةُ تُحسب لكلّ ردٍّ مكتمل عند رسمه. فسطرٌ واحد من عشرات آلاف
 *  الفراغات أو الأقواس لا يصحّ أن يجمّد الصفحة: كلُّ تعبيرٍ هنا خطّيّ،
 *  وذلك مقيسٌ بالزمن.
 *
 *  ★ ولا حرفَ خفيًّا في المصدر
 *
 *  الرموزُ الحارسة والمحارفُ الصفريّة تُكتب بصيغة الهروب، لا حروفًا لا
 *  تُرى: ما لا يُرى لا يُراجَع.
 *
 *  ★ ولماذا يُقطَّع
 *
 *  بعضُ المتصفّحات يقطع العبارةَ الطويلة في منتصفها بلا خطأٍ ولا حدث.
 *  فيُسلَّم المحرّكُ جُمَلًا قصيرةً متتابعة، وتُختار لكلّ مقطعٍ لغتُه:
 *  فالردُّ العربيّ الذي فيه فقرةٌ إنجليزيّة يُقرأ كلٌّ منهما بصوته.
 * ══════════════════════════════════════════════════════════════════
 */

export type SpeechLanguage = "ar" | "en";

export interface SpeechChunk {
  text: string;
  lang: SpeechLanguage;
}

/** أقصى طولٍ لمقطعٍ واحد — يُبقي العبارةَ دون حدّ القطع الصامت في المتصفّحات */
export const MAX_CHUNK_CHARS = 180;

/** حروفٌ عربيّة لا أرقامٌ ولا علاماتُ ترقيم — فالفاصلةُ العربيّة لا تجعل السطرَ عربيًّا */
const ARABIC_LETTER =
  /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;
/** اللاتينيّةُ وموسَّعاتُها — إلا علامتَي الضرب (U+00D7) والقسمة (U+00F7): هما وسط المدى ورمزان لا حرفان */
const LATIN_LETTER = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/;
const ANY_LETTER = /\p{L}/u;

/** كم حرفًا من كلّ خطّ؟ — و`other` ما ليس عربيًّا ولا لاتينيًّا */
export function countScripts(text: string): { arabic: number; latin: number; other: number } {
  let arabic = 0;
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ARABIC_LETTER.test(ch)) arabic += 1;
    else if (LATIN_LETTER.test(ch)) latin += 1;
    else if (ANY_LETTER.test(ch)) other += 1;
  }
  return { arabic, latin, other };
}

/**
 * أيُّ لغةٍ تغلب على هذا النصّ؟
 *
 * @param fallback تُعاد عند التعادل أو غياب الحروف — فسطرُ أرقامٍ يرث لغةَ ما قبله.
 */
export function detectSpeechLanguage(text: string, fallback: SpeechLanguage = "ar"): SpeechLanguage {
  return languageOf(countScripts(text), fallback);
}

/** اللغةُ من عدّ الحروف — فمن عدَّ مرّةً لا يعدّ ثانية */
function languageOf(counts: { arabic: number; latin: number }, fallback: SpeechLanguage): SpeechLanguage {
  if (counts.arabic === counts.latin) return fallback;
  return counts.arabic > counts.latin ? "ar" : "en";
}

/**
 * أيُقرأ هذا النصُّ بصوتٍ عربيٍّ أو إنجليزيّ؟
 *
 * ردٌّ نصفُه أو أكثرُ خطٌّ ثالث (صينيّ، روسيّ…) لا صوتَ يصحّ له هنا: فلا
 * يُعرض زرٌّ يَعِد بقراءةٍ تخرج هذيانًا. والنصُّ بلا حروفٍ (أرقامٌ) يُقرأ.
 */
export function isSupportedSpeechLanguage(text: string): boolean {
  const { arabic, latin, other } = countScripts(text);
  return other === 0 || other < arabic + latin;
}

/** فاتحُ السياج: معلومةُ سياج النقرات لا تحمل نقرة — فـ```x``` على سطرٍ واحد كودٌ سطريّ لا سياج */
const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** غالقُ السياج: لا نصَّ بعده */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const QUOTE_PREFIX = /^\s*(?:>\s?)+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
/** سطرٌ يبدأ كتلةً أخرى: عنوانٌ أو بندُ قائمة — لا صفُّ جدول ولو حوى عمودًا */
const BLOCK_START = /^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s)/;
/** يُختبران على السطر بعد قصّ طرفيه — فلا فراغَ متجاورًا يتراجع فيه التعبير */
const TABLE_RULE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;
const HORIZONTAL_RULE = /^([-*_])(?:\s*\1){2,}$/;
const UNESCAPED_PIPE = /(?<!\\)\|/;
/**
 * تعريفُ مرجعِ رابط: `[ref]: https://… "عنوان"` — وجهةٌ واحدة وعنوانٌ اختياريّ
 * ولا شيءَ بعدهما. فـ«[المستخدم]: ما عاصمةُ فرنسا؟» كلامٌ يُقرأ لا تعريف.
 */
const LINK_DEFINITION = /^\[[^\[\]^][^\[\]]*\]:\s*(?:<[^<>]*>|[^\s<]\S*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?$/;
/** تعريفُ حاشية: `[^1]: نصّ` — يُقرأ نصُّها */
const FOOTNOTE_DEFINITION = /^\[\^[^\[\]]+\]:\s*/;
const ENDS_WITH_PAUSE = /[.!?؟…:؛;،,]["'”’»)\]]*$/;

/**
 * رموزٌ تصويريّة: المحرّكُ ينطق أسماءَها الإنجليزيّة وسطَ الجملة.
 *
 * ومعها ما يلتصق بها ولا يُرى وحدَه: درجاتُ لون البشرة، وحروفُ الأعلام،
 * ومحدِّدُ الشكل (U+FE0F)، والرابطُ الصفريّ (U+200D)، وإطارُ المفتاح (U+20E3).
 */
const PICTOGRAPH = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\u20E3]/gu;

/**
 * حروفٌ تُحفظ عن إزالة التنسيق ثم تُعاد.
 *
 * ما هُرب به (`\*`) ونجمةُ الضرب حروفٌ من الكلام لا علاماتُ تنسيق. فتُبدَّل
 * برموزٍ من المنطقة الخاصّة (U+E000…) إلى أن تنتهي الإزالة.
 */
const KEPT_STAR = "\uE000";
const KEPT_UNDERSCORE = "\uE001";
const KEPT_LT = "\uE002";
const KEPT_BRACKET = "\uE003";
const KEPT_TILDE = "\uE004";
const KEPT_CARET = "\uE005";
const KEPT_AMPERSAND = "\uE006";
/** حدّا موضعِ كودٍ سطريّ: بينهما رقمُه في القائمة */
const CODE_OPEN = "\uE010";
const CODE_CLOSE = "\uE011";
const CODE_SLOT = /\uE010(\d+)\uE011/g;
/** ما قد يحمله النصُّ الواردُ من المنطقة الخاصّة يُنزع أوّلًا: لا يلتبس بحارسٍ من هنا */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;

function keepLiteral(text: string): string {
  return text
    .replaceAll("*", KEPT_STAR)
    .replaceAll("_", KEPT_UNDERSCORE)
    .replaceAll("<", KEPT_LT)
    .replaceAll("[", KEPT_BRACKET)
    .replaceAll("~", KEPT_TILDE)
    .replaceAll("^", KEPT_CARET)
    .replaceAll("&", KEPT_AMPERSAND);
}

function restoreLiteral(text: string): string {
  return text
    .replaceAll(KEPT_STAR, "*")
    .replaceAll(KEPT_UNDERSCORE, "_")
    .replaceAll(KEPT_LT, "<")
    .replaceAll(KEPT_BRACKET, "[")
    .replaceAll(KEPT_TILDE, "~")
    .replaceAll(KEPT_CARET, "^")
    .replaceAll(KEPT_AMPERSAND, "&");
}

/**
 * وسومُ HTML المعروفة وحدَها تُزال — وخصائصُ الوسم `اسم=قيمة`.
 *
 * «كلُّ ما بين زاويتين وسم» يحذف `x<y و y>z` و`<YOUR_API_KEY>`. و«كلُّ ما
 * بدأ باسم وسم» يحذف `a<b then c>d`: فـ`b then c` ليست خصائصَ وسم. فلا
 * يُزال إلا وسمٌ عارٍ أو وسمٌ خصائصُه بصيغتها.
 */
const HTML_TAG =
  /<\/?(?:a|abbr|b|blockquote|br|center|code|del|details|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|small|span|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|u|ul)(?:\s+(?:[A-Za-z][\w:.-]*=(?:"[^"<>]*"|'[^'<>]*'|[^\s"'<>]+)|open))*\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
};

function decodeEntity(match: string, body: string): string {
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (Number.isInteger(code) && code > 31 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return " ";
      }
    }
    return " ";
  }
  return ENTITIES[body.toLowerCase()] ?? match;
}

/** ما في السطر من تنسيقٍ يُزال، ويبقى الكلام */
function plainInline(line: string): string {
  let s = line.replace(PRIVATE_USE, "");
  // الكودُ السطريّ أوّلًا: يُرفع من السطر كما هو ويُعاد في النهاية، فلا تمسّه قاعدة
  const code: string[] = [];
  s = s.replace(/`+([^`]*)`+/g, (_match, body: string) => {
    code.push(body);
    return `${CODE_OPEN}${code.length - 1}${CODE_CLOSE}`;
  });
  s = s.replace(/`/g, "");
  // الهروبُ بالشرطة المائلة: علامةُ ترقيمٍ ASCII هُربت حرفٌ يُقرأ لا علامةُ تنسيق،
  // والشرطةُ نفسُها لا تُنطق — ومنه «\$5» و«15\%» في ردٍّ يذكر سعرًا. وسبعةٌ منها
  // تُحفظ برمزٍ حتى تنتهي القواعد، فلا تدخل قاعدةً لاحقة: النجمة، والشرطةُ السفليّة،
  // والزاويةُ الفاتحة، والقوسُ المربّع الفاتح، والمدّة، و«^» (الحاشية)، و«&» (الكيان).
  // إلا النقرةَ المهروبة: الكودُ السطريّ رُفع قبل هذا السطر — حدٌّ موثَّق.
  s = s.replace(/\\([!-\/:-@\[-`{-~])/g, (_match, ch: string) => keepLiteral(ch));
  // نجمةُ الضرب ليست توكيدًا: بين فراغين، أو بين رقمين (ومنها الأرقامُ العربيّة)
  s = s.replace(/(\s)(\*{1,2})(?=\s)/g, (_match, pre: string, stars: string) => pre + KEPT_STAR.repeat(stars.length));
  s = s.replace(/(\p{Nd})(\*{1,2})(?=\p{Nd})/gu, (_match, pre: string, stars: string) => pre + KEPT_STAR.repeat(stars.length));
  // استشهادٌ بصيغة رابط — «[[1]](عنوان)» — يُحذف كلُّه
  s = s.replace(/\[\[\d{1,3}\]\]\((?:[^()]|\([^()]*\))*\)/g, "");
  // صورة: يبقى وصفُها. رابط: يبقى نصُّه. والعنوانُ لا يُقرأ — ولو حوى قوسين
  s = s.replace(/!\[([^\[\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  s = s.replace(/\[([^\[\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  // حواشٍ وأرقامُ مراجع — متجاورةً كانت أو مفردة — لا فهرسةُ مصفوفةٍ ملتصقةٌ بحرفٍ أو بقوسٍ قبلها
  s = s.replace(/\[\^[^\[\]]+\]/g, "");
  s = s.replace(/(?<![A-Za-z0-9_)\]])(?:\[\d{1,3}\])+/g, "");
  s = s.replace(/(?<![A-Za-z0-9_)\]])\[([^\[\]]+)\]\[[^\[\]]*\]/g, "$1");
  // رابطٌ بين زاويتين، ثم الوسومُ المعروفة، ثم العناوينُ العارية
  s = s.replace(/<https?:\/\/[^<>\s]+>/gi, " ");
  s = s.replace(HTML_TAG, " ");
  s = s.replace(/\bhttps?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+/gi, " ");
  s = s.replace(/\bwww\.(?:[^\s<>()]|\([^\s<>()]*\))+/gi, " ");
  // مربّعاتُ قوائم المهامّ
  s = s.replace(/^\s*\[[ xX]\]\s+/, "");
  /**
   * التوكيدُ أزواج: ما له قرينٌ يُزال، وما لا قرينَ له حرفٌ يبقى.
   *
   * والفاتحُ لا يلتصق بحرفٍ لاتينيٍّ أو رقمٍ أو قوسٍ قبله: فـ«x**2» و«pi*r»
   * و«m*c**2» حسابٌ يُقرأ كما هو، و«و*كلمة*» توكيدٌ يُزال.
   *
   * وجولتان: الزوجُ لا يمتدّ فوق نجمةٍ بين طرفيه، فـ«**غامقٌ فيه *مائلٌ* داخله**»
   * يُزال داخلُه في الأولى وخارجُه في الثانية.
   *
   * والغالقُ لا يكون بعد قوسٍ مغلقٍ وقبل حرفٍ أو رقم: فنجمةُ «len(a)*2» و«f(x)**2»
   * حسابٌ، ولا تُقرَن بنجمةٍ سائبةٍ سبقتها («*args»، «**kwargs») — ولا في الجولة
   * الثانية بعد أن أُزيل ما كان بينهما.
   */
  for (let round = 0; round < 2; round++) {
    s = s.replace(/(?<![A-Za-z0-9)*])\*\*\*(?!\*)(?=\S)([^*]+?)(?<=\S)\*\*\*(?!\*)(?!(?<=[)\]}]\*\*\*)[\p{L}\p{N}])/gu, "$1");
    s = s.replace(/(?<![A-Za-z0-9)*])\*\*(?!\*)(?=\S)([^*]+?)(?<=\S)\*\*(?!\*)(?!(?<=[)\]}]\*\*)[\p{L}\p{N}])/gu, "$1");
    s = s.replace(/(?<![A-Za-z0-9)*])\*(?!\*)(?=\S)([^*]+?)(?<=\S)\*(?!\*)(?!(?<=[)\]}]\*)[\p{L}\p{N}])/gu, "$1");
  }
  s = s.replace(/~~(?=\S)([^~]+?)(?<=\S)~~/g, "$1");
  s = s.replace(/(?<![A-Za-z0-9_])__(?=\S)([^_]+?)(?<=\S)__(?![A-Za-z0-9_])/g, "$1");
  s = s.replace(/(^|[\s(«"'])_+(?=\S)/g, "$1");
  s = s.replace(/([^\s_])_+(?=$|[\s.,،؛;:!?؟)»"'])/g, "$1");
  // الكيانات، ثم الرموزُ التصويريّة
  s = s.replace(/&(#[xX]?[0-9A-Fa-f]{1,7}|[A-Za-z]{2,8});/g, decodeEntity);
  s = s.replace(PICTOGRAPH, " ");
  s = restoreLiteral(s);
  // ما حُذف يترك فراغًا قبل علامة الوقف: «غامق .» تُقرأ بسكتةٍ في غير موضعها.
  // ولا يُمسّ «.gitignore» ولا «.NET»: النقطةُ هناك أوّلُ كلمةٍ لا آخرُ جملة.
  s = s.replace(/\s+/g, " ").replace(/ +([.,،؛;:!?؟…])(?=\s|$)/g, "$1");
  // والكودُ السطريّ يعود كما كان
  s = s.replace(CODE_SLOT, (_match, at: string) => code[Number(at)] ?? "");
  return s.replace(/\s+/g, " ").trim();
}

/** عرضُ بادئةٍ بالأعمدة: علامةُ الجدولة تبلغ مضاعفَ الأربعة التالي، كما يعدّها العارض */
function columnsOf(prefix: string): number {
  let column = 0;
  for (const ch of prefix) column += ch === "\t" ? 4 - (column % 4) : 1;
  return column;
}

/** إزاحةُ السطر بالأعمدة — الفراغُ والجدولةُ وحدَهما إزاحة */
function indentOf(line: string): number {
  return columnsOf(/^[ \t]*/.exec(line)?.[0] ?? "");
}

/**
 * نصُّ الرسالة الخام ⇒ أسطرٌ مقروءة، كلٌّ منها ينتهي بوقفة.
 *
 * يُعيد نصًّا فارغًا إن لم يكن في الرد ما يُقرأ (ردٌّ كلُّه كود مثلًا) —
 * وعندها لا يُعرض زرُّ الاستماع أصلًا.
 */
export function toSpeechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  /** أفُتح السياجُ داخل اقتباس؟ — فغالقُه يحمل علامةَ الاقتباس مثلَه، وينتهي بانتهاء الاقتباس */
  let fenceQuoted = false;
  /** إزاحةُ محتوى بند القائمة الذي فُتح فيه السياج — ينتهي السياجُ بسطرٍ أقلَّ إزاحةً منها */
  let fenceOffset: number | null = null;
  let inTable = false;
  /** أفي فقرةٍ مفتوحة؟ — تعريفُ المرجع لا يقطع فقرة: فما يشبهه داخلها كلامٌ يُعرض ويُقرأ */
  let inParagraph = false;
  let language: SpeechLanguage = "ar";

  const emit = (text: string): void => {
    if (!text) return;
    // لا شيءَ يُنطق في سطرٍ كلُّه ترقيم
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    language = detectSpeechLanguage(text, language);
    out.push(ENDS_WITH_PAUSE.test(text) ? text : `${text}.`);
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const unquoted = raw.replace(QUOTE_PREFIX, "");
    const continuesParagraph = inParagraph;
    inParagraph = false;

    if (fence !== null) {
      // يُغلق السياجُ بمثله أو أطول ولا نصَّ بعده
      const closed = FENCE_CLOSE.exec(fenceQuoted ? unquoted : raw);
      const marker = closed?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
        continue;
      }
      // وينتهي بانتهاء ما يحويه: اقتباسٌ انقطعت علامتُه، أو بندُ قائمةٍ خرج السطرُ عن إزاحته.
      // وغيرُ ذلك يبتلع ما بعده إلى آخر الرد، كما يفعل العارض.
      const leftQuote = fenceQuoted && raw.trim() !== "" && unquoted === raw;
      const leftItem = fenceOffset !== null && unquoted.trim() !== "" && indentOf(unquoted) < fenceOffset;
      if (!leftQuote && !leftItem) continue;
      fence = null;
    }
    // السياجُ يُفتح بعد علامة الاقتباس وعلامة القائمة أيضًا
    const item = LIST_MARKER.exec(unquoted);
    const opened = FENCE_OPEN.exec(item ? unquoted.slice(item[0].length) : unquoted);
    if (opened) {
      fence = opened[1] ?? opened[2] ?? "```";
      fenceQuoted = unquoted !== raw;
      // بالأعمدة كإزاحة الأسطر التالية: بندٌ متداخلٌ بعلامة جدولة يُقاس بما تُقاس به أسطرُه
      fenceOffset = item ? columnsOf(item[0]) : null;
      inTable = false;
      continue;
    }

    const trimmed = unquoted.trim();
    if (!trimmed) {
      inTable = false;
      continue;
    }
    const piped = UNESCAPED_PIPE.test(trimmed);
    if (TABLE_RULE.test(trimmed) && trimmed.includes("-") && (piped || inTable)) {
      inTable = true;
      continue;
    }
    if (HORIZONTAL_RULE.test(trimmed)) continue;
    if (!continuesParagraph && LINK_DEFINITION.test(trimmed)) continue;

    // صفُّ جدول: يتلوه صفُّ الفواصل، أو يتلو صفًّا من الجدول — وليس سطرًا يبدأ كتلةً أخرى
    const next = (lines[index + 1] ?? "").replace(QUOTE_PREFIX, "").trim();
    const nextIsRule = piped && next.includes("|") && next.includes("-") && TABLE_RULE.test(next);
    if (piped && !BLOCK_START.test(trimmed) && (inTable || nextIsRule)) {
      inTable = true;
      const cells = trimmed
        .split(UNESCAPED_PIPE)
        .filter((cell) => cell.trim() !== "")
        // «\|» في الخليّة عمودٌ من الكلام — ولو داخل كودٍ سطريّ، حيث لا يُفكّ هروب
        .map((cell) => plainInline(cell.replace(/\\\|/g, "|")))
        .filter(Boolean);
      // تُقرأ الخلايا بالترتيب وبينها وقفة — بفاصلة لغة الصفّ، وصفُّ الأرقام يرث لغةَ ما قبله
      const comma = detectSpeechLanguage(cells.join(" "), language) === "ar" ? "، " : ", ";
      emit(cells.join(comma));
      continue;
    }
    inTable = false;

    let line = trimmed;
    const heading = /^#{1,6}\s/.test(line);
    // علاماتُ العنوان الخاتمة تُزال — والنظرةُ إلى الخلف تمنع إعادةَ الفحص من كلّ فراغ
    if (heading) line = line.replace(/^#{1,6}\s+/, "").replace(/(?<!\s)\s+#+$/, "");
    line = line.replace(/^[-*+]\s+/, "");
    line = line.replace(FOOTNOTE_DEFINITION, "");
    emit(plainInline(line));
    inParagraph = !heading;
  }
  return out.join("\n");
}

/** جملةٌ ⇒ أجزاءٌ لا يتجاوز أيٌّ منها الحدّ: عند الفواصل أوّلًا، ثم عند الفراغ، ثم قسرًا */
function fitToLimit(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1);
    let cut = -1;
    for (const m of head.matchAll(/[،,;؛:]\s/g)) cut = m.index + 1;
    if (cut <= 0) cut = head.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}


/**
 * النصُّ المقروء ⇒ مقاطعُ متتابعة، لكلٍّ منها لغتُه.
 *
 * تُضمّ الجملُ القصيرة المتجاورة ذاتُ اللغة الواحدة في مقطع، فلا يصير
 * الردُّ خمسين عبارةً بينها خمسون سكتة. ولا تُضمّ جملتان بلغتين.
 */
export function chunkSpeechText(speechText: string, limit: number = MAX_CHUNK_CHARS): SpeechChunk[] {
  const size = Math.max(1, Math.floor(limit));
  const primary = detectSpeechLanguage(speechText);
  const chunks: SpeechChunk[] = [];
  let previous: SpeechLanguage = primary;
  for (const line of speechText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // الجملةُ تنتهي بعلامتها ثم فراغ — فلا يُقطع «3.14» ولا «example.com».
    // والنظرةُ إلى الأمام أوّلًا: فلا تُفحص الخلفيّةُ إلا عند فراغ.
    const sentences = trimmed.split(/(?=\s)(?<=[.!?؟…]["'”’»)\]]*)\s+/);
    /**
     * حروفُ كلّ جملةٍ تُعدّ مرّةً واحدة، وأوّلُ جملةٍ ذاتِ حروفٍ بعد كلّ موضعٍ
     * يُحسب بمسحٍ واحد من آخر السطر. فالبحثُ من كلّ جملةٍ عمّا يتلوها تربيعيّ
     * في سطرٍ كلُّه «1. 2. 3. …».
     */
    const tallies = sentences.map((sentence) => countScripts(sentence));
    const nextScripted: number[] = [];
    let later = -1;
    for (let at = sentences.length - 1; at >= 0; at--) {
      nextScripted[at] = later;
      const tally = tallies[at];
      if (tally && tally.arabic + tally.latin > 0) later = at;
    }
    for (let at = 0; at < sentences.length; at++) {
      const sentence = sentences[at] ?? "";
      const own = tallies[at] ?? { arabic: 0, latin: 0 };
      /**
       * جملةٌ بلا حروف («1.» أوّلَ بند) تأخذ لغةَ ما يتلوها على السطر نفسِه:
       * فرقمُ البند يُقرأ مع بنده لا بصوت الفقرة التي سبقته.
       */
      const decisive = own.arabic + own.latin > 0 ? own : (tallies[nextScripted[at] ?? -1] ?? own);
      const sentenceLang = languageOf(decisive, previous);
      for (const piece of fitToLimit(sentence, size)) {
        // جملةٌ طويلة مختلطة تُقطَّع: لكلّ جزءٍ لغتُه الغالبة، لا لغةُ الجملة كلِّها
        const lang = detectSpeechLanguage(piece, sentenceLang);
        previous = lang;
        const last = chunks[chunks.length - 1];
        if (last && last.lang === lang && last.text.length + 1 + piece.length <= size) {
          last.text = `${last.text} ${piece}`;
        } else {
          chunks.push({ text: piece, lang });
        }
      }
    }
  }
  return chunks;
}
