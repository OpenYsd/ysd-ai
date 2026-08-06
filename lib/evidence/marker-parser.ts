/**
 * مُحلِّل علامات Evidence Mode — `[[n]]` (v0.9.0، الإيداع الثاني).
 *
 * وحدة **نقيّة** بلا أي تبعية: لا قاعدة، ولا شبكة، ولا بثّ، ولا واجهة، ولا
 * `server-only`. تعمل على الخادم والعميل معًا، وتُختبر بلا تمويه.
 *
 * ── ما تفعله وما لا تفعله ──
 *
 * تستخرج **ما طلبه النموذج** لا أكثر: أرقام العلامات وموضعها من الفقرات.
 * ولا تربط رقمًا بمصدر، ولا تتحقق من وجوده، ولا تحكم على صحّته — ذلك كلّه
 * في إيداع لاحق. الاسم `requestedMarkers` مقصود: **طلبٌ لا حقيقة**.
 *
 * ── لماذا ماسحٌ حرفي لا تعبير نمطي ──
 *
 * المدخل نصٌّ من نموذج لغوي، أي **مدخل غير موثوق بطول تعسّفي**. وأي تعبير
 * نمطي فيه تكرار متداخل (`(\s*\d*)*` وأشباهه) يفتح باب ReDoS: نصّ مصنوع يجعل
 * التحليل أُسّيًا فيتجمّد الخيط. الماسح الحرفي يمرّ على كل حرف **مرة واحدة**،
 * فزمنه خطّي بحكم البناء لا بحكم التدقيق.
 *
 * ── لماذا `[[n]]` لا `[n]` ──
 *
 * `[1]` يلتبس بروابط Markdown (`[1](url)`) ومراجعها (`[1]: url`). و`[[n]]`
 * لا يصطدم بأي بناء Markdown قياسي، ويُجرَّد من النص المحفوظ فلا يراه المستخدم.
 */

/** أقصى طول مدخل يُحلَّل — فوقه يُعاد النص كما هو بلا مسح */
export const MAX_INPUT_CHARS = 100_000;

/** أقصى عدد مرشّحي علامات يُنظر فيها — ما بعده يبقى نصًّا عاديًا */
export const MAX_MARKER_CANDIDATES = 99;

/** أكبر رقم علامة مقبول */
export const MAX_MARKER = 99;

/**
 * أقصى مسافة نبحث فيها عن `]]` بعد `[[` لنعدّ ما بينهما **محاولة** علامة.
 * محدودة عمدًا: بلا حدّ يصير كل `[[` في النص بحثًا حتى آخره، فيتحوّل المسح
 * إلى تربيعي على نصّ مليء بالأقواس.
 */
export const MALFORMED_LOOKAHEAD = 12;

export interface ParsedEvidenceSegment {
  /** ترتيب الفقرة بين الفقرات المُخرَجة — يبدأ من 0 */
  segmentIndex: number;
  /** نصّ الفقرة كما ورد، بعلاماته */
  rawText: string;
  /** نصّ الفقرة بعد إزالة العلامات الصحيحة وحدها */
  cleanText: string;
  /** أرقام العلامات بترتيب أول ظهور، بلا تكرار */
  requestedMarkers: number[];
}

export interface ParsedEvidenceOutput {
  /** النصّ كاملًا بعد إزالة العلامات الصحيحة */
  cleanText: string;
  segments: ParsedEvidenceSegment[];
  /** أرقام العلامات على مستوى الرسالة، بترتيب أول ظهور وبلا تكرار */
  allRequestedMarkers: number[];
  /** عدد المحاولات التي بدت علامةً ولم تكن — تبقى في النص كما هي */
  malformedCount: number;
  /**
   * لكل سطر: رقم الفقرة التي ينتمي إليها، أو `null` إن لم ينتمِ لأي فقرة
   * مُخرَجة (سطر فاصل، أو فقرة سقطت لأنها صارت فارغة).
   *
   * ── لماذا يُحسب هنا لا في الواجهة ──
   *
   * الواجهة تحتاج أن تعرف **أين** تضع زرّ الاستشهاد، أي أن تربط `segmentIndex`
   * بموضعٍ في Markdown. وإعادةُ اشتقاق التقسيم هناك تعني تعريفين للفقرة
   * يفترقان مع أول تعديل — فيظهر الزرّ عند فقرةٍ غير التي استُشهد بها، وهو
   * خطأ نسبة لا خطأ تنسيق.
   *
   * يُحسب في نفس المرور، فلا يمكن أن يتباعد عمّا في `segments`.
   */
  lineSegments: (number | null)[];
}

const EMPTY: ParsedEvidenceOutput = {
  cleanText: "",
  segments: [],
  allRequestedMarkers: [],
  malformedCount: 0,
  lineSegments: [],
};

/**
 * محارف لا يُترك قبلها فراغ بعد إزالة علامة.
 *
 * الترقيم بديهي. و`<` معه لأن `محتوى [[1]]</div>` كان يُخلّف فراغًا معلّقًا
 * داخل الوسم (`محتوى </div>`) — والعلامة كانت ملتصقة بالوسم لا بالنص.
 */
const CLING_LEFT = new Set([
  ".", ",", "،", ";", "؛", ":", "!", "?", "؟", ")", "]", "}", "»", '"', "'", "<",
]);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isSpace = (c: string): boolean => c === " " || c === "\t";

/**
 * سطر فتح/إغلاق سياج: ``` أو ~~~ (ثلاثة فأكثر) مع إزاحة حتى ثلاث مسافات.
 *
 * مُصدَّرة كي يستعملها مستخرِج الغلاف (v0.9.0، الإيداع السادس): «داخل سياج»
 * يجب أن تعني الشيء نفسه في الموضعين. تعريفان متوازيان يفترقان يومًا، فيصير
 * نصٌّ **علامةً** عند أحدهما و**شيفرةً** عند الآخر.
 */
export function readFenceMarker(line: string): { char: string; len: number } | null {
  return fenceInfo(line);
}

function fenceInfo(line: string): { char: string; len: number } | null {
  let i = 0;
  while (i < 3 && i < line.length && line[i] === " ") i++;
  const c = line[i];
  if (c !== "`" && c !== "~") return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === c) len++;
  return len >= 3 ? { char: c, len } : null;
}

/**
 * يفحص علامةً محتملة تبدأ عند `i` حيث `text[i] === "["`.
 *
 * يُعيد `{ value, end }` لعلامة صحيحة، أو `{ malformed: true, end }` لمحاولة
 * فاشلة، أو `null` إن لم تكن محاولةً أصلًا.
 *
 * **القبول ضيّق عمدًا**: رقمٌ واحد أو رقمان، بلا صفر بادئ، بلا إشارة، بلا
 * فراغ، بلا كسر. كل ما عداه يبقى نصًّا — فالتساهل هنا يعني قبول ما لم يقصده
 * النموذج ونسبته إلى مصدر.
 */
function scanMarker(
  text: string,
  i: number,
): { value: number; end: number } | { malformed: true; end: number } | null {
  if (text[i] !== "[" || text[i + 1] !== "[") return null;

  let j = i + 2;
  // رقم واحد أو رقمان فقط
  let digits = "";
  while (j < text.length && isDigit(text[j]!) && digits.length <= 2) {
    digits += text[j]!;
    j++;
  }

  const closesHere = text[j] === "]" && text[j + 1] === "]";
  if (closesHere && digits.length >= 1 && digits.length <= 2) {
    // لا صفر بادئ: "01" و"0" مرفوضان
    const leadingZero = digits.length > 1 && digits[0] === "0";
    const value = Number(digits);
    if (!leadingZero && value >= 1 && value <= MAX_MARKER) {
      return { value, end: j + 2 };
    }
    return { malformed: true, end: j + 2 };
  }

  /**
   * ليست علامة صحيحة. هل هي **محاولة**؟ نبحث عن `]]` ضمن نافذة محدودة.
   * وجودها يعني أن النموذج قصد علامةً وأخطأ (`[[abc]]`، `[[ 1 ]]`، `[[100]]`)،
   * فتُعدّ مشوّهة. وغيابها يعني أن `[[` هنا نصٌّ عادي لا محاولة.
   */
  const limit = Math.min(text.length - 1, i + 2 + MALFORMED_LOOKAHEAD);
  for (let k = i + 2; k < limit; k++) {
    if (text[k] === "]" && text[k + 1] === "]") {
      return { malformed: true, end: k + 2 };
    }
    // سطر جديد ينهي المحاولة — العلامة لا تعبر الأسطر
    if (text[k] === "\n") break;
  }
  return null;
}

/** نتيجة مسح سطرٍ واحد خارج السياج */
interface LineScan {
  clean: string;
  markers: number[];
  malformed: number;
  candidates: number;
}

/**
 * يمسح سطرًا واحدًا: يتخطّى الشيفرة السطرية والمهروب، ويزيل العلامات الصحيحة.
 * مرور واحد على الأحرف.
 */
function scanLine(line: string, candidateBudget: number): LineScan {
  let out = "";
  const markers: number[] = [];
  let malformed = 0;
  let candidates = 0;
  let i = 0;

  while (i < line.length) {
    const c = line[i]!;

    /**
     * الهروب: `\[` يعني «قوسٌ حرفي» في Markdown. نُبقي التسلسل **كما هو** ولا
     * نحوّله ولا نُزيل العلامة بعده — فالمستخدم كتب `\[[1]]` ليرى `[[1]]`،
     * وتجريدها كان سيمحو ما أراد إظهاره.
     */
    if (c === "\\" && i + 1 < line.length) {
      out += c;
      out += line[i + 1];
      i += 2;
      continue;
    }

    /**
     * الشيفرة السطرية: سلسلة backtick تُغلق بسلسلة **بنفس الطول** بالضبط.
     * ما بينهما يُنسخ حرفيًا ولا يُبحث فيه عن علامات — العلامة داخل شيفرة
     * جزءٌ مما يعرضه المؤلّف لا استشهاد.
     */
    if (c === "`") {
      let run = 0;
      while (i + run < line.length && line[i + run] === "`") run++;
      const open = "`".repeat(run);
      const closeAt = line.indexOf(open, i + run);
      // نتأكد أن الإغلاق ليس جزءًا من سلسلة أطول
      if (closeAt !== -1 && line[closeAt + run] !== "`") {
        out += line.slice(i, closeAt + run);
        i = closeAt + run;
        continue;
      }
      // بلا إغلاق: backtick عادي
      out += open;
      i += run;
      continue;
    }

    if (c === "[") {
      const hit = scanMarker(line, i);
      if (hit) {
        if (candidates >= candidateBudget) {
          // تجاوزنا سقف المرشّحين: يبقى نصًّا عاديًا
          out += line.slice(i, hit.end);
          i = hit.end;
          continue;
        }
        candidates++;
        if ("malformed" in hit) {
          malformed++;
          out += line.slice(i, hit.end); // المشوّهة تبقى ظاهرة
          i = hit.end;
          continue;
        }

        markers.push(hit.value);

        /**
         * تسوية الفراغ عند موضع الإزالة — محليًّا لا على النص كله.
         *
         * `نص [[1]] نص` ⇒ فراغ واحد لا اثنان.
         * `نص [[1]].`   ⇒ `نص.` لا `نص .`
         *
         * ولا نمسّ فراغًا بعيدًا عن موضع الإزالة: تسويةٌ شاملة كانت ستغيّر
         * تنسيقًا قصده الكاتب (محاذاة جدول، إزاحة قائمة).
         */
        const next = line[hit.end];

        /**
         * علامة في **أول السطر** متبوعة بفراغ: لا فراغ قبلها يُنزع، فيبقى
         * الذي بعدها إزاحةً كاذبة في أول الفقرة. نبتلعه.
         */
        if (out.length === 0 && next !== undefined && isSpace(next)) {
          i = hit.end + 1;
          continue;
        }

        const prevIsSpace = out.length > 0 && isSpace(out[out.length - 1]!);
        if (prevIsSpace && next !== undefined && isSpace(next)) {
          i = hit.end + 1; // ابتلع أحد الفراغين
          continue;
        }
        if (prevIsSpace && (next === undefined || CLING_LEFT.has(next))) {
          out = out.slice(0, -1); // انزع الفراغ الذي سبقها
        }
        i = hit.end;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { clean: out, markers, malformed, candidates };
}

/** يضيف الأرقام إلى القائمة بترتيب أول ظهور وبلا تكرار */
function pushUnique(target: number[], seen: Set<number>, values: number[]): void {
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      target.push(v);
    }
  }
}

/**
 * يحلّل نصّ الرد ويستخرج علامات `[[n]]`.
 *
 * لا يسجّل شيئًا: لا النصّ ولا العلامات ولا عددها. الوحدة نقيّة، والتسجيل —
 * إن لزم — مسؤولية المستدعي وبعدّادات مجرّدة لا محتوى.
 */
export function parseEvidenceMarkers(text: string): ParsedEvidenceOutput {
  if (typeof text !== "string" || text.length === 0) return { ...EMPTY };

  /**
   * حدّ الطول: فوقه لا نمسح إطلاقًا ونُعيد النصّ كما هو بفقرة واحدة.
   *
   * الرفض الكامل أصدق من تحليلٍ جزئي: نصّ بهذا الطول شذوذٌ في مسارنا (سقف
   * الإخراج 8192 رمزًا في أعلى خطة)، والتحليل الجزئي كان سينتج علاماتٍ من
   * أوّله ويُسقط ما بعده بلا أن يعرف أحد.
   */
  if (text.length > MAX_INPUT_CHARS) {
    return {
      cleanText: text,
      segments: [
        { segmentIndex: 0, rawText: text, cleanText: text, requestedMarkers: [] },
      ],
      allRequestedMarkers: [],
      malformedCount: 0,
      /**
       * فقرةٌ واحدة تغطّي النصّ كلّه، فكل سطر ينتمي إليها.
       *
       * كان هذا المسار يُعيد مصفوفةً بعنصرٍ واحد فارغ بينما `segments` يُعلن
       * فقرةً قائمة — تناقضٌ بين مخرَجَي الدالة نفسها. لا أثر له اليوم (الأدلة
       * معطّلة أصلًا فوق هذا الحجم)، لكن قارئًا لاحقًا يبني عليه سيجد فقرةً
       * بلا أسطر.
       */
      lineSegments: new Array<number | null>(text.split(/\r?\n/).length).fill(0),
    };
  }

  const lines = text.split(/\r?\n/);

  // حالة السياج: تعبر الأسطر ولا تتأثر بالأسطر الفارغة
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  // تراكم الفقرة الجارية
  let rawBuf: string[] = [];
  let cleanBuf: string[] = [];
  let segMarkers: number[] = [];

  /** النص النظيف كاملًا — يُجمع في نفس المرور فلا يمكن أن يتباعد عن الفقرات */
  const wholeClean: string[] = [];
  const segments: ParsedEvidenceSegment[] = [];
  const allMarkers: number[] = [];
  const allSeen = new Set<number>();
  let malformedCount = 0;
  let candidatesUsed = 0;

  /** أرقام أسطر الفقرة الجارية — تُختم برقمها عند نجاح `flush` */
  let bufLines: number[] = [];
  const lineSegments: (number | null)[] = new Array<number | null>(lines.length).fill(null);

  const flush = (): void => {
    if (rawBuf.length === 0) return;
    const rawText = rawBuf.join("\n");
    const cleanText = cleanBuf.join("\n");

    /**
     * فقرة صار نصّها فارغًا بعد الإزالة (كانت علامةً وحدها في سطر).
     *
     * لا نُخرج فقرةً فارغة — وهو المطلوب صراحةً. وعلاماتها **تُضاف إلى الفقرة
     * السابقة**: علامةٌ وحدها بعد فقرة استشهادٌ بها لا فقرةٌ مستقلة. وبلا
     * سابقة تُهمَل الفقرة ويبقى الرقم في `allRequestedMarkers` لأن النموذج
     * طلبه فعلًا.
     */
    if (cleanText.trim().length === 0) {
      if (segMarkers.length > 0) {
        const prev = segments[segments.length - 1];
        if (prev) {
          const seen = new Set(prev.requestedMarkers);
          pushUnique(prev.requestedMarkers, seen, segMarkers);
        }
        pushUnique(allMarkers, allSeen, segMarkers);
      }
      rawBuf = [];
      cleanBuf = [];
      segMarkers = [];
      // الفقرة سقطت: أسطرها لا تنتمي إلى أي فقرة مُخرَجة
      bufLines = [];
      return;
    }

    const seen = new Set<number>();
    const requested: number[] = [];
    pushUnique(requested, seen, segMarkers);
    pushUnique(allMarkers, allSeen, segMarkers);

    const segmentIndex = segments.length;
    segments.push({
      segmentIndex,
      rawText,
      cleanText,
      requestedMarkers: requested,
    });
    for (const ln of bufLines) lineSegments[ln] = segmentIndex;

    rawBuf = [];
    cleanBuf = [];
    segMarkers = [];
    bufLines = [];
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!;
    const fence = fenceInfo(line);

    if (inFence) {
      // داخل سياج: لا علامات، ولا فصل فقرات، حتى يُغلق
      rawBuf.push(line);
      cleanBuf.push(line);
      wholeClean.push(line);
      bufLines.push(lineNo);
      if (fence && fence.char === fenceChar && fence.len >= fenceLen) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }

    if (fence) {
      inFence = true;
      fenceChar = fence.char;
      fenceLen = fence.len;
      rawBuf.push(line);
      cleanBuf.push(line);
      wholeClean.push(line);
      bufLines.push(lineNo);
      continue;
    }

    // سطر فارغ خارج السياج ⇒ نهاية فقرة (ويبقى في النص النظيف فاصلًا)
    if (line.trim().length === 0) {
      flush();
      wholeClean.push(line);
      continue;
    }

    const budget = Math.max(0, MAX_MARKER_CANDIDATES - candidatesUsed);
    const scanned = scanLine(line, budget);
    candidatesUsed += scanned.candidates;
    malformedCount += scanned.malformed;
    segMarkers.push(...scanned.markers);
    rawBuf.push(line);
    cleanBuf.push(scanned.clean);
    wholeClean.push(scanned.clean);
    bufLines.push(lineNo);
  }

  flush();

  /**
   * `cleanText` الكامل من `wholeClean` لا من ضمّ الفقرات: الضمّ كان سيفقد
   * الأسطر الفارغة الفاصلة فينهار تنسيق Markdown (فقرات تلتصق، وقوائم
   * تندمج). وجمعه في نفس المرور يمنع أن يتباعد عمّا في الفقرات.
   */
  return {
    cleanText: wholeClean.join("\n"),
    segments,
    allRequestedMarkers: allMarkers,
    malformedCount,
    lineSegments,
  };
}
