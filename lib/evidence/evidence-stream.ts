import {
  MALFORMED_LOOKAHEAD,
  parseEvidenceMarkers,
  readFenceMarker,
} from "@/lib/evidence/marker-parser";
import {
  canonicalizeSentinels,
  EVIDENCE_END,
  EVIDENCE_START,
  extractEvidenceEnvelope,
  scanEvidenceSentinel,
} from "@/lib/evidence/evidence-envelope";

/**
 * مرشّح البثّ — النصّ المرئي وحده يصل العميل (v0.9.0، الإيداع السادس).
 *
 * وحدة **نقيّة**: لا قاعدة ولا شبكة ولا واجهة.
 *
 * ── العقد الذي يجعلها صحيحة ──
 *
 * مهما انقسمت دفعات المزوّد، مجموعُ ما أُرسل يساوي بالضبط:
 *
 *   parseEvidenceMarkers(extractEvidenceEnvelope(raw).visibleText).cleanText
 *
 * وليست هذه صياغةً أنيقة بل شرطُ سلامة: العميل يرى نصًّا، والقاعدة تحفظ نصًّا،
 * وإزاحاتُ الاستشهاد تشير إلى مواضع فيه. فاختلافُ حرفٍ واحد بين ما عُرض وما
 * حُفظ يجعل «ميّز هذا الاقتباس» يشير إلى الموضع الخطأ.
 *
 * ── كيف تُضمن المساواة مع انقسام تعسّفي ──
 *
 * `cleanText` يُبنى **سطرًا سطرًا**: مخرَج السطر يتحدّد بالسطر وحالة السياج
 * قبله، ولا يتغيّر بما يأتي بعده. فيكفي ألّا نُرسل إلا الأسطر المكتملة، ونحتجز
 * السطر الجاري حتى يكتمل.
 *
 * والاحتجاز نفسه يحلّ مشكلتين أخريين بلا شيفرة إضافية: العلامة `[[n]]` لا تعبر
 * الأسطر، والسنتينل يبدأ سطره. فأي انقسام داخلهما يقع حتمًا في السطر المحتجز.
 *
 * ── الوضع العادي بلا مصادر ──
 *
 * تمريرٌ محض: نفس الدفعات، نفس البايتات، بلا تجميع ولا تأخير. Evidence Mode
 * ميزةٌ للردود المسنَدة إلى ملفات، ولا يجوز أن تغيّر حرفًا في سواها.
 */

/** سقف ما نحتفظ به من الرد الخام — فوقه يتوقف استخراج الأدلة بأمان */
export const MAX_RAW_RESPONSE_CHARS = 100_000;

/** أطول سنتينل — به يُقاس الاحتجاز فلا تتسرّب بادئةٌ منقسمة */
const SENTINEL_MAX_LEN = Math.max(EVIDENCE_START.length, EVIDENCE_END.length);

export interface EvidenceStream {
  /** يستقبل دفعة ويُعيد ما يجوز عرضه الآن (قد يكون فارغًا) */
  push(text: string): string;
  /** يُستدعى بعد آخر دفعة ويُعيد ما تبقّى */
  flush(): string;
  /** الرد الخام المحتفَظ به — للمستخرِج بعد الاكتمال */
  readonly raw: string;
  /** هل تجاوز الرد السقف؟ عندها لا تُحفظ استشهادات */
  readonly overflowed: boolean;
  /** هل الوضع مفعّل أصلًا؟ */
  readonly enabled: boolean;
}

/** تمرير محض — الوضع العادي، بلا أي تغيير على البايتات */
function passthrough(): EvidenceStream {
  return {
    push: (text) => text,
    flush: () => "",
    raw: "",
    overflowed: false,
    enabled: false,
  };
}

/**
 * نهاية تركيب `[` إن كان **محسومًا**، أو `null` إن كان ما يأتي قد يغيّره.
 *
 * «محسوم» يشمل الحالتين معًا: علامةٌ صحيحة تُحذف، و`[` عاديةٌ تبقى. المهم أن
 * الحرف القادم لا يبدّل الحكم.
 */
function resolveBracketEnd(line: string, i: number): number | null {
  const next = line[i + 1];
  if (next === undefined) return null; // قد تصير `[[`
  if (next !== "[") return i + 1; // قوسٌ مفرد — نصّ عادي

  let j = i + 2;
  let digits = 0;
  while (j < line.length && line[j]! >= "0" && line[j]! <= "9" && digits <= 2) {
    digits++;
    j++;
  }
  if (j >= line.length) return null; // قد تأتي أرقام أو `]]`
  if (line[j] === "]") {
    if (j + 1 >= line.length) return null; // ننتظر القوس الثاني
    if (line[j + 1] === "]") return j + 2; // صحيحة أو مشوّهة — كلتاهما محسومة
  }

  // ليست بالصيغة: هل هي **محاولة** مشوّهة؟ الحكم يحتاج نافذة البحث كاملة
  const limit = Math.min(line.length, i + 2 + MALFORMED_LOOKAHEAD);
  for (let k = i + 2; k < limit; k++) {
    if (line[k] === "]" && line[k + 1] === "]") return k + 2;
  }
  if (line.length < i + 2 + MALFORMED_LOOKAHEAD + 1) return null; // النافذة ناقصة
  return i + 1; // مؤكد: ليست محاولة
}

/**
 * طول ما استقرّ من **السطر الجاري** (غير المكتمل).
 *
 * ── لماذا لا يكفي الاحتجاز حتى نهاية السطر ──
 *
 * الاحتجاز السطري يكفي للصحّة ولا يكفي للبثّ: جوابُ RAG نموذجيًّا فقرةٌ واحدة
 * بلا `\n` إطلاقًا، فيبقى محتجَزًا كلّه حتى `flush` ويصل دفعةً واحدة — أي أن
 * Evidence Mode يُلغي البثّ في أكثر حالاته شيوعًا (قِيس: **صفر** حرف أثناء
 * البثّ لفقرة واحدة).
 *
 * فنمسح السطر الجاري إلى الأمام ونقف عند **أول تركيب غير محسوم**:
 *
 *  • `\` هروبٌ يحتاج حرفه التالي.
 *  • `` ` `` سلسلةٌ تحتاج إغلاقًا بنفس الطول — وقبله المحتوى قد يصير شيفرة.
 *  • `<` قد تكون بداية سنتينل، فلا تُرسل حتى يُستبعد ذلك.
 *  • `[` عبر `resolveBracketEnd` أعلاه.
 *
 * الوقوف عند **الأول** لا الأخير: `أ [[` فيها قوسان، والأخير ليس بداية
 * التركيب — القطع عنده كان يُرسل `[` الأولى فيخرج نصٌّ ليس بادئةً لما سيستقرّ،
 * فيصمت الحارس ويضيع الرد كلّه.
 *
 * وأخيرًا نتراجع عن الفراغ الملاصق: علامةٌ تليه قد تبتلعه (`نص [[1]].` ⇒
 * `نص.`)، فإرساله مبكّرًا يكسر البادئة كذلك.
 */
function settledPrefixLength(line: string, inFence: boolean): number {
  if (inFence) return line.length; // داخل السياج كل شيء حرفيّ

  let i = 0;
  let settled = 0;

  while (i < line.length) {
    const c = line[i]!;

    if (c === "\\") {
      if (i + 1 >= line.length) break;
      i += 2;
      settled = i;
      continue;
    }

    if (c === "`") {
      let run = 0;
      while (i + run < line.length && line[i + run] === "`") run++;
      if (i + run >= line.length) break; // السلسلة نفسها قد تطول
      const closeAt = line.indexOf("`".repeat(run), i + run);
      if (closeAt === -1) break; // لم تُغلق بعد
      if (line[closeAt + run] === "`") break; // الإغلاق قد يطول
      i = closeAt + run;
      settled = i;
      continue;
    }

    if (c === "<") {
      /**
       * **كلا السنتينلين**: `<<<E` ليست بادئةً للبداية وهي بادئة للنهاية.
       * فحصُ البداية وحدها كان يُرسل النهاية اليتيمة حرفًا حرفًا — نفس الثغرة
       * التي أُصلحت في المستخرِج، عادت هنا من باب آخر.
       */
      const rest = line.slice(i, i + SENTINEL_MAX_LEN);
      if (EVIDENCE_START.startsWith(rest) || EVIDENCE_END.startsWith(rest)) break;
      i++;
      settled = i;
      continue;
    }

    if (c === "[") {
      const end = resolveBracketEnd(line, i);
      if (end === null) break;
      // علامةٌ في آخر المتاح: حذفها يتوقف على الحرف التالي وهو مجهول
      if (end >= line.length) break;
      i = end;
      settled = i;
      continue;
    }

    i++;
    settled = i;
  }

  while (settled > 0 && (line[settled - 1] === " " || line[settled - 1] === "\t")) settled--;
  return settled;
}

/** حالة السياج عند إزاحة معيّنة — تُحسب من الأسطر المكتملة قبلها */
function fenceStateAt(raw: string, offset: number): boolean {
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const head = raw.slice(0, offset);
  if (head.length === 0) return false;

  for (const line of head.split("\n")) {
    const fence = readFenceMarker(line);
    if (inFence) {
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
    }
  }
  return inFence;
}

/**
 * إزالة العلامات في **مسار الفيض** وحده.
 *
 * ماسحٌ حرفي مبسّط لا يعرف السياج ولا الهروب. لا يُستعمل في المسار الطبيعي:
 * هو شبكة أمان لردٍّ تجاوز 100 ألف حرف (وسقف الإخراج عندنا أقلّ من ثلثه)،
 * غرضها ألّا تظهر علامة خام، لا أن تطابق المُحلِّل.
 */
function stripMarkersLoosely(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[" && text[i + 1] === "[") {
      let j = i + 2;
      let digits = "";
      while (j < text.length && text[j]! >= "0" && text[j]! <= "9" && digits.length <= 2) {
        digits += text[j]!;
        j++;
      }
      if (
        digits.length >= 1 &&
        digits.length <= 2 &&
        !(digits.length > 1 && digits[0] === "0") &&
        Number(digits) >= 1 &&
        text[j] === "]" &&
        text[j + 1] === "]"
      ) {
        i = j + 2;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

export function createEvidenceStream(options: { enabled: boolean }): EvidenceStream {
  if (!options.enabled) return passthrough();

  let raw = "";
  /** ما أُرسل فعلًا — نصًّا لا طولًا، كي يمكن إثبات أنه بادئة */
  let emitted = "";
  let overflowed = false;
  /** حالة الفيض: نصّ محتجز، وهل رأينا السنتينل فنصمت بعده */
  let overflowPending = "";
  let overflowSilenced = false;

  /** يُرسل ما استقرّ: الأسطر المكتملة، ثم ما استقرّ من السطر الجاري */
  const advance = (): string => {
    /**
     * ★ المسح على النصّ **المُقوَّم** — وإلا لم يُرَ السنتينل الناقص.
     *
     * الماسح لا يعرف إلا الصيغة القانونية، فصيغةٌ ناقصة `>` واحدة كانت تُقرأ
     * «لا سنتينل» ⇒ يستقرّ البثّ على النصّ كلّه ⇒ تخرج الكتلة الداخلية إلى
     * المستخدم حرفًا حرفًا. رُصد حيًّا وحُفظ في محتوى الرسالة.
     *
     * والفهرس صالح لـ`raw` نفسه: التقويم لا يُدرج إلا **عند** بداية السنتينل
     * أو بعدها، فلا يُزحزح موضعها. فالقطع يقع في المكان الصحيح من النصّ الخام.
     */
    const scan = scanEvidenceSentinel(canonicalizeSentinels(raw).text);
    const limit = scan.index === -1 ? raw.length : scan.index;
    // آخر سطر جديد **قبل** الحدّ: ما بعده سطرٌ جارٍ لم يكتمل
    const lineStart = raw.lastIndexOf("\n", limit - 1) + 1;

    /**
     * ظهر سنتينل ⇒ لا نتقدّم داخل سطره: القطع يقع عنده، وما بينه وبين أول
     * السطر يخرج عند `flush` من المرجع النهائي وحده.
     */
    const safeEnd =
      scan.index === -1
        ? lineStart +
          settledPrefixLength(raw.slice(lineStart), fenceStateAt(raw, lineStart))
        : lineStart;

    if (safeEnd <= 0) return "";

    const clean = parseEvidenceMarkers(raw.slice(0, safeEnd)).cleanText;
    if (clean.length <= emitted.length) return "";
    /**
     * حارس بنيوي: ما أُرسل يجب أن يكون بادئةً مما استقرّ. لا يقع خلافه بحكم
     * البناء أعلاه — ولو وقع فالإرسال يُنتج نصًّا مشوّهًا لدى العميل، والصمت
     * أهون: النصّ يكتمل عند `flush` أو لا يكتمل، ولا يتكرر.
     */
    if (!clean.startsWith(emitted)) return "";
    const out = clean.slice(emitted.length);
    emitted = clean;
    return out;
  };

  /** مسار الفيض: احتجاز بطول السنتينل يمنع تسرّبه منقسمًا بين دفعتين */
  const scrubOverflow = (text: string): string => {
    if (overflowSilenced) return "";
    overflowPending += text;

    const at = overflowPending.indexOf(EVIDENCE_START);
    if (at !== -1) {
      overflowSilenced = true;
      const out = stripMarkersLoosely(overflowPending.slice(0, at));
      overflowPending = "";
      return out;
    }

    // نحتجز ما يكفي لأطول بادئة سنتينل ممكنة — وهو أطول من أي علامة
    const keep = Math.min(overflowPending.length, EVIDENCE_START.length - 1);
    const ready = overflowPending.slice(0, overflowPending.length - keep);
    overflowPending = overflowPending.slice(overflowPending.length - keep);
    return stripMarkersLoosely(ready);
  };

  return {
    push(text: string): string {
      if (typeof text !== "string" || text.length === 0) return "";
      if (overflowed) return scrubOverflow(text);

      const room = MAX_RAW_RESPONSE_CHARS - raw.length;
      if (text.length <= room) {
        raw += text;
        return advance();
      }

      /**
       * تجاوز السقف داخل هذه الدفعة: نأخذ ما يسع، نُفرغ ما استقرّ منه، ثم
       * ننتقل إلى المسار المُصان. `raw` يتوقف هنا فلا تنمو الذاكرة بلا حدّ.
       */
      raw += text.slice(0, Math.max(0, room));
      overflowed = true;
      const settled = advance();
      /**
       * البقية التي لم يبلغها `advance` (سطر جارٍ) تعود إلى مسار الفيض كي لا
       * تضيع — والسنتينل فيها يُلتقط هناك.
       */
      const tail = raw.slice(emitted.length > 0 ? raw.lastIndexOf("\n") + 1 : 0);
      overflowPending = "";
      return settled + scrubOverflow(tail + text.slice(Math.max(0, room)));
    },

    flush(): string {
      if (overflowed) {
        if (overflowSilenced) return "";
        const rest = stripMarkersLoosely(overflowPending);
        overflowPending = "";
        return rest;
      }

      /**
       * ★ المرجع النهائي: نفس الدالتين اللتين يعرّف بهما العقد. فما يصل العميل
       * هو حرفيًا `parseEvidenceMarkers(extract(raw).visibleText).cleanText`،
       * لا تقريبٌ منه.
       */
      const visible = extractEvidenceEnvelope(raw).visibleText;
      const final = parseEvidenceMarkers(visible).cleanText;
      if (!final.startsWith(emitted)) return "";
      if (final.length <= emitted.length) return "";
      const out = final.slice(emitted.length);
      emitted = final;
      return out;
    },

    get raw() {
      return raw;
    },
    get overflowed() {
      return overflowed;
    },
    get enabled() {
      return true;
    },
  };
}
