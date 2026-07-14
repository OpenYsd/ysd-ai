/**
 * تقسيم النص إلى مقاطع لـ RAG — يدعم العربية والإنجليزية.
 * القواعد: احترام الفقرات والعناوين، عدم قطع الكلمات أبدًا،
 * تداخل محدود بين المقاطع، لا مقاطع فارغة ولا مكررة.
 */

import { createHash } from "node:crypto";

export interface Chunk {
  index: number;
  content: string;
  characterCount: number;
  pageNumber: number | null;
  hash: string;
}

export interface ChunkingOptions {
  /** الحجم المستهدف للمقطع بالأحرف */
  targetChars?: number;
  /** الحد الأقصى الصلب للمقطع */
  maxChars?: number;
  /** حجم التداخل التقريبي بين المقاطع المتتالية */
  overlapChars?: number;
  /** أقل طول يُقبل للمقطع */
  minChars?: number;
}

const DEFAULTS: Required<ChunkingOptions> = {
  targetChars: 1000,
  maxChars: 1400,
  overlapChars: 150,
  minChars: 25,
};

/** hash محتوى موحّد — يتجاهل فروق المسافات لمنع التكرار */
export function contentHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

/** تقسيم فقرة طويلة على حدود الجمل ثم المسافات — دون قطع كلمة أبدًا */
function splitLongParagraph(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  // حدود الجمل: عربية وإنجليزية
  const sentences = text.match(/[^.!?؟…\n]+[.!?؟…\n]*/g) ?? [text];
  const parts: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // جملة أطول من الحد — قسّم على المسافات (لا نقطع كلمة)
      flush();
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if (current.length + word.length + 1 > maxChars) flush();
        current += (current ? " " : "") + word;
      }
      flush();
      continue;
    }
    if (current.length + sentence.length > maxChars) flush();
    current += sentence;
  }
  flush();
  return parts;
}

/** هل يبدو السطر عنوانًا؟ (Markdown أو سطر قصير بلا علامة ختام) */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t)) return true;
  return t.length <= 60 && !/[.!?؟،:…]$/.test(t) && !/\s{2,}/.test(t) && t.split(/\s+/).length <= 8;
}

/** ذيل نص للتداخل — يبدأ من حدود كلمة */
function overlapTail(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return text;
  const slice = text.slice(-overlapChars);
  const firstSpace = slice.search(/\s/);
  return firstSpace === -1 ? slice : slice.slice(firstSpace + 1);
}

interface PageText {
  pageNumber: number | null;
  text: string;
}

/**
 * التقسيم الرئيسي. يقبل نصًا واحدًا أو صفحات (PDF) للحفاظ على أرقام الصفحات.
 */
export function chunkText(
  input: string | PageText[],
  options?: ChunkingOptions,
): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const pages: PageText[] =
    typeof input === "string" ? [{ pageNumber: null, text: input }] : input;

  const chunks: Chunk[] = [];
  const seenHashes = new Set<string>();
  let index = 0;

  for (const page of pages) {
    // الفقرات — مع إلحاق العناوين بالفقرة التالية
    const rawParagraphs = page.text
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    const paragraphs: string[] = [];
    let pendingHeading = "";
    for (const p of rawParagraphs) {
      if (isHeading(p) && !p.includes("\n")) {
        pendingHeading = pendingHeading ? `${pendingHeading}\n${p}` : p;
        continue;
      }
      paragraphs.push(pendingHeading ? `${pendingHeading}\n${p}` : p);
      pendingHeading = "";
    }
    if (pendingHeading) paragraphs.push(pendingHeading);

    let current = "";
    let previousTail = "";

    const emit = () => {
      const content = current.trim();
      current = "";
      if (content.length < opts.minChars) return;
      const hash = contentHash(content);
      if (seenHashes.has(hash)) return; // لا مقاطع مكررة
      seenHashes.add(hash);
      chunks.push({
        index: index++,
        content,
        characterCount: content.length,
        pageNumber: page.pageNumber,
        hash,
      });
      previousTail = overlapTail(content, opts.overlapChars);
    };

    for (const paragraph of paragraphs) {
      // نقسم على الحجم المستهدف حتى يبقى (الذيل المتداخل + القطعة) دون الحد الصلب
      const pieces = splitLongParagraph(paragraph, opts.targetChars);
      for (const piece of pieces) {
        if (current && current.length + piece.length + 2 > opts.targetChars) {
          emit();
          // التداخل: ذيل المقطع السابق يفتتح التالي
          if (previousTail && previousTail.length < opts.targetChars / 2) {
            current = previousTail + "\n";
          }
        }
        current += (current ? "\n\n" : "") + piece;
        // فقرة واحدة تجاوزت الحد الصلب — أخرجها فورًا
        while (current.length >= opts.maxChars) {
          emit();
          if (previousTail && previousTail.length < opts.targetChars / 2) {
            current = previousTail + "\n";
            previousTail = "";
          }
        }
      }
    }
    emit();
  }

  return chunks;
}
