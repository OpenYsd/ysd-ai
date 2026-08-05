/**
 * التحقق من أن اقتباسًا مقترَحًا موجودٌ فعلًا داخل مقطع (v0.9.0، الإيداع الثالث).
 *
 * وحدة **نقيّة** بلا تبعية: لا قاعدة، ولا شبكة، ولا بثّ، ولا واجهة.
 *
 * ── الطبقة الحاسمة في Evidence Mode ──
 *
 * النموذج يقترح رقمًا واقتباسًا؛ وهذه الوحدة تجيب عن سؤال واحد: **هل هذا
 * النصّ موجود في هذا المقطع؟** ما لا يثبت هنا لا يصير استشهادًا. وبذلك يتحوّل
 * الاستشهاد من ادّعاءٍ يُصدَّق إلى واقعةٍ تُفحَص.
 *
 * ── لماذا التطبيع محافظ ──
 *
 * كل توسعة في التطبيع تزيد فرصة أن يُقبل نصٌّ لم يقله المقطع. و**الاستشهاد
 * الكاذب أخطر من المفقود**: المفقود يترك الفقرة موسومة «غير مدعومة» فيعرف
 * القارئ حدّ الدليل، والكاذب يمنح ثقةً بلا أساس.
 *
 * ولهذا لا `ة ← ه`، ولا `ؤ ← و`، ولا `ئ ← ي`: هذه **فروق معنى** لا رسم.
 * «حياة» و«حياه»، و«مسؤول» و«مسوول» — كلمات مختلفة، وقبولها متطابقةً يعني
 * نسبة جملة إلى مقطع لا يحويها. ولا مسافة تحرير ولا تقريب ولا مرادفات ولا
 * إعادة ترتيب: كلها تقبل ما لم يُكتب.
 *
 * وما يُطبَّع رسمٌ بحت: تشكيل لا يُغيّر الحرف، وتطويل زخرفي، وأشكال ألف،
 * وأرقام بأبجدية أخرى، ومحارف صفرية العرض لا تُرى أصلًا.
 *
 * ── النصّ المُعاد ──
 *
 * `quote` **دائمًا شريحة من المقطع الأصلي** لا نصّ النموذج ولا النصّ المطبَّع.
 * فما يُحفظ ويُعرض ويُميَّز في الملف هو ما ورد في المصدر حرفيًا — والفرق بين
 * الاثنين هو الفرق بين دليلٍ وإعادةِ صياغة.
 */

/** أقصى طول اقتباس مقبول — قرار v0.9.0 */
export const MAX_QUOTE_CHARS = 240;

/** أدنى طول بعد التطبيع: أقصر من ذلك دليلٌ أضعف من أن يُنسب */
export const MIN_QUOTE_CHARS = 12;

/** أقصى حجم مقطع يُبحث فيه */
export const MAX_CONTENT_CHARS = 100_000;

/** سقف عدّ التكرارات — العدّ الدقيق لا يستحق مسحًا غير محدود */
export const MAX_OCCURRENCE_SCAN = 100;

export type QuoteRejectReason =
  | "empty"
  | "too_short"
  | "too_long"
  | "content_too_large"
  | "not_found";

export type VerifiedQuote =
  | {
      verified: true;
      verification: "exact" | "normalized";
      /** **شريحة من المقطع الأصلي** — لا نصّ النموذج ولا المطبَّع */
      quote: string;
      /** إزاحة البداية داخل `snippetContent` كما ورد */
      start: number;
      end: number;
      occurrenceCount: number;
    }
  | { verified: false; reason: QuoteRejectReason };

// ════════════════════════════════════════════════════════════
//  التطبيع — قوائم صريحة، بلا تعبير نمطي على نصّ المستخدم
// ════════════════════════════════════════════════════════════

/** تشكيل عربي وعلامات فوقية لا تُغيّر الحرف */
function isArabicDiacritic(cp: number): boolean {
  return (
    (cp >= 0x064b && cp <= 0x065f) || // فتحتان … سكون وما بينها
    cp === 0x0670 || // ألف خنجرية
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e8) ||
    (cp >= 0x06ea && cp <= 0x06ed) ||
    (cp >= 0x08d3 && cp <= 0x08ff)
  );
}

/** محارف صفرية العرض ومحارف اتجاه — لا تُرى ولا تُنطق */
function isInvisible(cp: number): boolean {
  return (
    cp === 0x200b || // ZWSP
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM
    cp === 0x061c || // ALM
    cp === 0x200e || // LRM
    cp === 0x200f || // RLM
    (cp >= 0x202a && cp <= 0x202e) || // LRE RLE PDF LRO RLO
    (cp >= 0x2066 && cp <= 0x2069) || // LRI RLI FSI PDI
    cp === 0x0640 // تطويل
  );
}

function isWhitespace(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** أشكال الرسم التي تُوحَّد — رسمٌ لا معنى */
const LETTER_FOLD = new Map<string, string>([
  ["أ", "ا"], // أ → ا
  ["إ", "ا"], // إ → ا
  ["آ", "ا"], // آ → ا
  ["ٱ", "ا"], // ٱ → ا
  ["ى", "ي"], // ى → ي
  ["ی", "ي"], // ی (فارسية) → ي
  ["ک", "ك"], // ک (فارسية) → ك
]);

/** أرقام عربية-هندية وفارسية → 0-9 */
function foldDigit(cp: number): string | null {
  if (cp >= 0x0660 && cp <= 0x0669) return String(cp - 0x0660);
  if (cp >= 0x06f0 && cp <= 0x06f9) return String(cp - 0x06f0);
  return null;
}

export interface NormalizedWithMap {
  normalized: string;
  /** لكل حرف مطبَّع: بداية مصدره في النص الأصلي */
  srcStart: number[];
  /** ونهايته — لازمة لأن حرف المصدر قد يكون زوجًا بديلًا أو يتمدّد */
  srcEnd: number[];
}

/**
 * يطبّع النص **مع خريطة إزاحات** إلى الأصل.
 *
 * الخريطة هي جوهر الوحدة: بدونها يمكن التحقق لكن لا يمكن إرجاع شريحة أصلية،
 * فيُعرض للمستخدم نصٌّ مطبَّع لا يطابق ملفه حرفًا بحرف — ولا يمكن تمييزه داخل
 * المقطع في الواجهة.
 *
 * NFKC يُطبَّق **على كل نقطة ترميز وحدها** لا على النص كاملًا: التطبيع الشامل
 * قد يدمج حرفين متجاورين فتنهار المطابقة واحدًا-لواحد بين المُخرَج والمصدر.
 * والغرض المقصود من NFKC هنا (العرض الكامل، الروابط، أشكال العرض) يتحقّق على
 * مستوى النقطة الواحدة.
 */
export function normalizeWithMap(text: string): NormalizedWithMap {
  const out: string[] = [];
  const srcStart: number[] = [];
  const srcEnd: number[] = [];
  let lastWasSpace = true; // يمنع فراغًا بادئًا

  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const from = i;
    const to = i + width;
    i = to;

    if (isInvisible(cp)) continue;

    if (isWhitespace(cp)) {
      if (!lastWasSpace) {
        out.push(" ");
        srcStart.push(from);
        srcEnd.push(to);
        lastWasSpace = true;
      }
      continue;
    }

    const digit = foldDigit(cp);
    if (digit !== null) {
      out.push(digit);
      srcStart.push(from);
      srcEnd.push(to);
      lastWasSpace = false;
      continue;
    }

    // NFKC على نقطة الترميز وحدها — قد يُنتج أكثر من حرف (ﻻ ⇒ لا)
    let expanded: string;
    try {
      expanded = String.fromCodePoint(cp).normalize("NFKC");
    } catch {
      // Unicode شاذّ أو بديل يتيم: يُمرَّر كما هو ولا يُرمى استثناء
      expanded = String.fromCodePoint(cp);
    }

    for (const ch of expanded) {
      const ecp = ch.codePointAt(0)!;
      if (isArabicDiacritic(ecp) || isInvisible(ecp)) continue;

      if (isWhitespace(ecp)) {
        if (!lastWasSpace) {
          out.push(" ");
          srcStart.push(from);
          srcEnd.push(to);
          lastWasSpace = true;
        }
        continue;
      }

      const d = foldDigit(ecp);
      if (d !== null) {
        out.push(d);
        srcStart.push(from);
        srcEnd.push(to);
        lastWasSpace = false;
        continue;
      }

      const folded = LETTER_FOLD.get(ch) ?? ch;
      // lowercase للاتينية وحدها — toLowerCase لا يمسّ العربية
      out.push(folded.toLowerCase());
      srcStart.push(from);
      srcEnd.push(to);
      lastWasSpace = false;
    }
  }

  // إزالة فراغ لاحق مع خريطته
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    srcStart.pop();
    srcEnd.pop();
  }

  return { normalized: out.join(""), srcStart, srcEnd };
}

/** يعدّ التكرارات بحدّ أعلى — `indexOf` متتالٍ، بلا تعبير نمطي */
function countOccurrences(haystack: string, needle: string, from: number): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = from;
  while (at !== -1 && count < MAX_OCCURRENCE_SCAN) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * يتحقّق من أن `candidateQuote` موجود في `snippetContent`.
 *
 * لا يسجّل شيئًا: لا الاقتباس، ولا المقطع، ولا النصّ المطبَّع، ولا طولها.
 * الوحدة نقيّة، والتسجيل — إن لزم — مسؤولية المستدعي وبعدّادات مجرّدة.
 */
export function verifyEvidenceQuote(input: {
  candidateQuote: string;
  snippetContent: string;
}): VerifiedQuote {
  const candidateRaw = typeof input.candidateQuote === "string" ? input.candidateQuote : "";
  const content = typeof input.snippetContent === "string" ? input.snippetContent : "";

  // (١) الفراغ الخارجي يُزال من المرشّح وحده — المقطع لا يُمسّ
  const candidate = candidateRaw.trim();
  if (candidate.length === 0) return { verified: false, reason: "empty" };
  if (candidate.length > MAX_QUOTE_CHARS) {
    // **لا يُقصّ**: القصّ يخترع اقتباسًا لم يقترحه النموذج
    return { verified: false, reason: "too_long" };
  }
  if (content.length === 0) return { verified: false, reason: "not_found" };
  if (content.length > MAX_CONTENT_CHARS) {
    return { verified: false, reason: "content_too_large" };
  }

  // (٢) الحدّ الأدنى يُقاس **بعد التطبيع**: تشكيلٌ كثيف يجعل نصًّا قصيرًا يبدو طويلًا
  const nCand = normalizeWithMap(candidate);
  if (nCand.normalized.length < MIN_QUOTE_CHARS) {
    return { verified: false, reason: "too_short" };
  }

  /**
   * (٣) الحرفي أولًا. نجاحه يعني أن ما اقترحه النموذج مطابقٌ للمصدر حرفًا
   * بحرف — أقوى ما يمكن، ولا حاجة إلى تطبيع يوسّع القبول.
   */
  const exactAt = content.indexOf(candidate);
  if (exactAt !== -1) {
    return {
      verified: true,
      verification: "exact",
      // شريحة من الأصل حتى في الحالة الحرفية: المصدر هو المرجع لا المرشّح
      quote: content.slice(exactAt, exactAt + candidate.length),
      start: exactAt,
      end: exactAt + candidate.length,
      occurrenceCount: countOccurrences(content, candidate, exactAt),
    };
  }

  // (٤) المطبَّع — عند فشل الحرفي وحده
  const nContent = normalizeWithMap(content);
  const at = nContent.normalized.indexOf(nCand.normalized);
  if (at === -1) return { verified: false, reason: "not_found" };

  const lastIdx = at + nCand.normalized.length - 1;
  const start = nContent.srcStart[at]!;
  const end = nContent.srcEnd[lastIdx]!;

  return {
    verified: true,
    verification: "normalized",
    /**
     * الشريحة من **الأصل** بحدود الخريطة — لا النصّ المطبَّع. فالمستخدم يرى
     * ما في ملفه بتشكيله وتطويله كما هو، ويمكن تمييزه داخل المقطع لاحقًا.
     */
    quote: content.slice(start, end),
    start,
    end,
    occurrenceCount: countOccurrences(nContent.normalized, nCand.normalized, at),
  };
}
