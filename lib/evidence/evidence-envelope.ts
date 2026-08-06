import { readFenceMarker } from "@/lib/evidence/marker-parser";

/**
 * غلاف الأدلة الآلي — `<<<YSD_EVIDENCE_V1>>>` (v0.9.0، الإيداع السادس).
 *
 * وحدة **نقيّة** بلا قاعدة ولا شبكة ولا بثّ ولا واجهة.
 *
 * ── لماذا كتلة في نهاية الرد لا JSON خالص ──
 *
 * الرد يُبثّ للمستخدم حرفًا بحرف. فلو كان الإخراج كلّه JSON لما ظهر شيء قبل
 * اكتماله، ولانهارت تجربة البثّ كلها من أجل بيانات إضافية. الكتلة في النهاية
 * تُبقي النصّ نصًّا، وتُلحق به ما يحتاجه الخادم وحده.
 *
 * ── ولماذا لا يُعرض السنتينل أبدًا ──
 *
 * هذه الكتلة **تفصيلٌ داخلي**: المستخدم طلب جوابًا لا بروتوكولًا. فأينما وُجد
 * السنتينل يُقطع النصّ المرئي عنده — سليمًا كان أو تالفًا، على سطره أو في
 * وسطه. حالة «تالف» تُسقط الاستشهادات ولا تُظهر الكتلة: الفشل الآمن أن يفقد
 * المستخدم المراجع لا أن يرى مخلّفات بروتوكول في رده.
 *
 * ── لا استخراج جزئي ──
 *
 * JSON تالفٌ لا يُنتزع منه ما «يبدو» صالحًا. المرشّح المنتزع من نصّ تالف
 * ادّعاءٌ لا نعرف أن النموذج قصده — وهو يمرّ بعدها على التحقق فيبدو مثبتًا.
 */

export const EVIDENCE_START = "<<<YSD_EVIDENCE_V1>>>";
export const EVIDENCE_END = "<<<END_YSD_EVIDENCE_V1>>>";

/** سقف الكتلة الآلية — 16KB بحساب بايتات UTF-8 لا محارف */
export const MAX_ENVELOPE_BYTES = 16 * 1024;

/** أقصى عدد مرشّحين — مطابق لسقف الأرقام */
export const MAX_ENVELOPE_CANDIDATES = 99;

export const MIN_ENVELOPE_QUOTE_CHARS = 12;
export const MAX_ENVELOPE_QUOTE_CHARS = 240;

export type EvidenceEnvelopeStatus = "valid" | "missing" | "malformed" | "too_large";

export interface EvidenceEnvelopeQuote {
  marker: number;
  quote: string;
}

export interface ExtractedEvidenceEnvelope {
  /** النصّ المعروض — لا يحوي السنتينل ولا ما بعده تحت أي حال */
  visibleText: string;
  quoteCandidates: EvidenceEnvelopeQuote[];
  status: EvidenceEnvelopeStatus;
}

/** مفاتيح تلوّث النموذج الأولي — تُرفض أينما ظهرت */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** طول UTF-8 بلا TextEncoder — الوحدة نقيّة وتعمل في أي بيئة */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      bytes += 4;
      i++;
    } else if (cp > 0x7ff) bytes += 3;
    else if (cp > 0x7f) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

export interface SentinelScan {
  /** إزاحة أول سنتينل خارج السياج، أو -1 */
  index: number;
  /** هل هو في أول سطره؟ (بعد إزاحة بيضاء فقط) */
  atLineStart: boolean;
  /** كم سنتينل بداية خارج السياج — أكثر من واحد ⇒ تالف */
  count: number;
  /**
   * هل كان أول ما وُجد سنتينل **نهاية** بلا بداية؟
   *
   * حالةٌ كشفها الاختبار: البحث عن البداية وحدها كان يترك
   * `<<<END_YSD_EVIDENCE_V1>>>` اليتيم نصًّا مرئيًا يصل المستخدم. القطع يجب
   * أن يقع عند **أي** سنتينل لا عند البداية فقط.
   */
  orphanEnd: boolean;
}

/**
 * يبحث عن سنتينل البداية **خارج أسوار الشيفرة**.
 *
 * السياج مقصود: نصٌّ يشرح البروتوكول داخل ``` هو شيفرةٌ يعرضها الرد، لا كتلةً
 * آلية. وبغير هذا التمييز يستحيل على النموذج أن يشرح الصيغة دون أن يُفسَّر
 * شرحه أمرًا.
 *
 * ويُستعمل أيضًا في مرشّح البثّ ليعرف أين يتوقف الإرسال — فالتعريف واحد،
 * والمرشّح لا يمكن أن يُرسل ما سيقطعه المستخرِج لاحقًا.
 */
export function scanEvidenceSentinel(raw: string): SentinelScan {
  const empty: SentinelScan = { index: -1, atLineStart: false, count: 0, orphanEnd: false };
  if (typeof raw !== "string" || raw.length === 0) return empty;

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let offset = 0;
  let first = -1;
  let firstAtLineStart = false;
  let count = 0;
  let firstEnd = -1;

  const lines = raw.split("\n");
  for (const line of lines) {
    const fence = readFenceMarker(line);

    if (inFence) {
      if (fence && fence.char === fenceChar && fence.len >= fenceLen) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
      offset += line.length + 1;
      continue;
    }

    if (fence) {
      inFence = true;
      fenceChar = fence.char;
      fenceLen = fence.len;
      offset += line.length + 1;
      continue;
    }

    const at = line.indexOf(EVIDENCE_START);
    if (at !== -1) {
      count++;
      if (first === -1) {
        first = offset + at;
        // «أول السطر» يتسامح مع إزاحة بيضاء ولا يتسامح مع نصّ قبله
        firstAtLineStart = line.slice(0, at).trim().length === 0;
      }
    }

    if (firstEnd === -1) {
      const endAt = line.indexOf(EVIDENCE_END);
      // `indexOf(EVIDENCE_START)` لا يطابق سنتينل النهاية، فالبحثان مستقلّان
      if (endAt !== -1) firstEnd = offset + endAt;
    }

    offset += line.length + 1;
  }

  if (first === -1) {
    // نهايةٌ يتيمة: تُقطع كما تُقطع البداية، ولا تُقبل كتلةً
    if (firstEnd === -1) return empty;
    return { index: firstEnd, atLineStart: false, count: 0, orphanEnd: true };
  }

  return { index: first, atLineStart: firstAtLineStart, count, orphanEnd: false };
}

/** فحص صارم لعنصر واحد — أي مخالفة تُسقط الكتلة كلها لا العنصر وحده */
function readQuoteEntry(entry: unknown): EvidenceEnvelopeQuote | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;

  const keys = Object.keys(entry as Record<string, unknown>);
  if (keys.length !== 2) return null;
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) return null;
  if (!keys.includes("marker") || !keys.includes("quote")) return null;

  const { marker, quote } = entry as { marker: unknown; quote: unknown };

  // Number.isInteger يرفض NaN وInfinity والكسور معًا
  if (typeof marker !== "number" || !Number.isInteger(marker)) return null;
  if (marker < 1 || marker > 99) return null;

  if (typeof quote !== "string") return null;
  const trimmed = quote.trim();
  if (trimmed.length < MIN_ENVELOPE_QUOTE_CHARS) return null;
  if (trimmed.length > MAX_ENVELOPE_QUOTE_CHARS) return null;

  return { marker, quote: trimmed };
}

/** يقرأ جسم الكتلة — يُعيد المرشّحين أو null لأي مخالفة */
function readEnvelopeBody(json: string): EvidenceEnvelopeQuote[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null; // JSON صارم — ولا محاولة إنقاذ
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const keys = Object.keys(parsed as Record<string, unknown>);
  // `quotes` وحدها — حقلٌ زائد يعني عقدًا غير الذي اتفقنا عليه
  if (keys.length !== 1 || keys[0] !== "quotes") return null;

  const { quotes } = parsed as { quotes: unknown };
  if (!Array.isArray(quotes)) return null;
  if (quotes.length > MAX_ENVELOPE_CANDIDATES) return null;

  const out: EvidenceEnvelopeQuote[] = [];
  for (const entry of quotes) {
    const read = readQuoteEntry(entry);
    if (read === null) return null; // ★ لا استخراج جزئي
    out.push(read);
  }
  return out;
}

/**
 * يفصل النصّ المرئي عن الكتلة الآلية.
 *
 * لا يسجّل شيئًا: لا النصّ، ولا الاقتباسات، ولا أطوالها. التسجيل — إن لزم —
 * بعدّاد `status` وحده عند المستدعي.
 */
export function extractEvidenceEnvelope(raw: string): ExtractedEvidenceEnvelope {
  const text = typeof raw === "string" ? raw : "";
  const scan = scanEvidenceSentinel(text);

  if (scan.index === -1) {
    return { visibleText: text, quoteCandidates: [], status: "missing" };
  }

  /**
   * ★ القطع أولًا وقبل أي حكم على الصحّة.
   *
   * كل مسار خروج بعد هذه النقطة يستعمل `visibleText` نفسه، فلا يمكن لفرعٍ
   * منسيّ أن يُعيد النصّ الخام ومعه الكتلة.
   */
  const visibleText = text.slice(0, scan.index);
  const bad = (status: EvidenceEnvelopeStatus): ExtractedEvidenceEnvelope => ({
    visibleText,
    quoteCandidates: [],
    status,
  });

  if (scan.orphanEnd) return bad("malformed");
  if (scan.count > 1) return bad("malformed");
  if (!scan.atLineStart) return bad("malformed");

  const block = text.slice(scan.index);
  if (utf8Length(block) > MAX_ENVELOPE_BYTES) return bad("too_large");

  const afterStart = scan.index + EVIDENCE_START.length;
  const endAt = text.indexOf(EVIDENCE_END, afterStart);
  if (endAt === -1) return bad("malformed");

  // السنتينلان على سطرين مستقلّين: ما بينهما وما حولهما لا يحمل نصًّا آخر
  const head = text.slice(afterStart, endAt);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline === -1) return bad("malformed");
  // ما بين آخر سطر جديد وسنتينل النهاية: إزاحة بيضاء فقط
  if (head.slice(lastNewline + 1).trim().length > 0) return bad("malformed");
  // وأول سطر بعد سنتينل البداية فارغ
  const firstNewline = head.indexOf("\n");
  if (firstNewline === -1) return bad("malformed");
  if (head.slice(0, firstNewline).trim().length > 0) return bad("malformed");

  // ★ لا شيء بعد سنتينل النهاية سوى بياض
  const tail = text.slice(endAt + EVIDENCE_END.length);
  if (tail.trim().length > 0) return bad("malformed");

  const body = head.slice(firstNewline + 1, lastNewline);
  const quoteCandidates = readEnvelopeBody(body);
  if (quoteCandidates === null) return bad("malformed");

  return { visibleText, quoteCandidates, status: "valid" };
}
