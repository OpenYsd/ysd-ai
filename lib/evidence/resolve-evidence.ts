import "server-only";

import {
  parseEvidenceMarkers,
  MAX_MARKER,
} from "@/lib/evidence/marker-parser";
import { verifyEvidenceQuote } from "@/lib/evidence/quote-verifier";
import type { RetrievedSnippet } from "@/lib/rag/retrieval";

/**
 * حلّ الأدلة — من ادّعاء النموذج إلى مصادر مُثبَتة (v0.9.0، الإيداع الخامس).
 *
 * ── الحدّ الفاصل: ما يقوله النموذج وما نأخذه منه ──
 *
 * النموذج يرسل **شيئين لا ثالث لهما**: رقم علامة، ونصّ اقتباس. وكل ما عداهما
 * — معرّف المقطع، معرّف الملف، اسمه، صفحته، ترتيبه، درجة صلته — يأتي من
 * `RetrievedSnippet` الذي بناه الاسترجاع من القاعدة.
 *
 * هذا ليس تنظيمًا للشيفرة بل حدُّ ثقة: لو قبلنا `fileName` من النموذج لصار
 * بوسعه أن ينسب اقتباسًا إلى ملفٍ لم يقرأه؛ ولو قبلنا `relevance` لصار بوسعه
 * أن يرفع مصدرًا ضعيفًا فوق قويّ. الرقم يختار **أيّ** مقطع، ولا يصف شيئًا عنه.
 *
 * ── ولماذا الاقتباس المُعاد ليس نصّ النموذج ──
 *
 * `verifyEvidenceQuote` تُعيد **شريحة من المقطع الأصلي** بإزاحاتها. فما يُحفظ
 * هو ما في ملف المستخدم حرفًا بحرف، لا ما كتبه النموذج — ولو تطابقا. الفرق
 * يظهر في الحالة المطبَّعة: النموذج قد يكتب بلا تشكيل وما في الملف مُشكَّل،
 * والمعروض يجب أن يطابق الملف كي يمكن تمييزه فيه.
 *
 * ── لا تسجيل ──
 *
 * لا `responseText`، ولا اقتباس، ولا محتوى مقطع، ولا اسم ملف. `stats` عدّادات
 * مجرّدة وحدها — وهي كل ما يجوز أن يخرج من هنا إلى سجلّ أو مقياس.
 */

/** ما يرسله النموذج: رقمٌ ونصّ، لا أكثر */
export interface EvidenceQuoteCandidate {
  marker: number;
  quote: string;
}

/** ما بناه الاسترجاع: الرقم مقرونًا بمقطعه صراحةً */
export interface EvidenceSourceRegistryEntry {
  marker: number;
  snippet: RetrievedSnippet;
}

export interface ResolvedEvidenceSource {
  marker: number;
  chunkId: string;
  fileId: string;
  chunkIndex: number;
  fileNameSnapshot: string;
  pageNumberSnapshot: number | null;
  /** شريحة من المقطع الأصلي — مخرَج `verifyEvidenceQuote` لا نصّ النموذج */
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  relevance: number;
  verification: "exact" | "normalized";
}

export interface ResolvedEvidenceSegment {
  segmentIndex: number;
  /** أرقام المصادر الباقية بعد التحقق وحدّ الخطة — بترتيب ورودها في الفقرة */
  sourceMarkers: number[];
  supported: boolean;
}

export interface ResolvedEvidence {
  cleanText: string;
  sources: ResolvedEvidenceSource[];
  segments: ResolvedEvidenceSegment[];
  unsupportedSegments: number[];
  stats: {
    requestedMarkers: number;
    verifiedSources: number;
    /** رقمٌ في النص بلا مدخل في السجلّ — النموذج اخترع مرجعًا */
    droppedUnknownMarkers: number;
    /** رقمٌ له مصدر ولم يُرسَل معه اقتباس */
    droppedMissingQuotes: number;
    /** اقتباسٌ لم يجتز التحقق، أو التبس، أو كرّر مصدرًا مقبولًا */
    droppedInvalidQuotes: number;
    /** مصدرٌ متحقَّق أسقطه سقف الخطة */
    droppedByPlanLimit: number;
  };
}

/**
 * سقف المدخلات التي نمرّ عليها. الأرقام محصورة في 1..99 أصلًا، فما فوق ذلك
 * تكرارٌ أو حشو؛ والحدّ يمنع أن يتحوّل مصفوفٌ ضخم إلى عمل غير محدود.
 */
export const MAX_EVIDENCE_INPUT_ENTRIES = 500;

const isUsableMarker = (m: unknown): m is number =>
  typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MARKER;

/**
 * حصر `similarity` في [0,1].
 *
 * ليس حكمًا على القيمة بل حارس حدود عائمة: `1 - (v <=> q)` قد يُخرج
 * `1.0000000000000002` أو قيمة سالبة طفيفة. وقيد `relevance` في 0032 يرفض
 * ذلك، فيسقط **حفظ الرسالة كلها** بسبب خطأ في المنزلة السادسة عشرة. الحصر
 * يمسّ ما هو خارج المدى وحده ولا يغيّر ترتيبًا.
 */
function clampRelevance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function resolveEvidence(input: {
  responseText: string;
  quoteCandidates: EvidenceQuoteCandidate[];
  sourceRegistry: EvidenceSourceRegistryEntry[];
  maxVerifiedSources: number;
}): ResolvedEvidence {
  const parsed = parseEvidenceMarkers(
    typeof input.responseText === "string" ? input.responseText : "",
  );

  /** أرقام النص بترتيب أول ظهور — وهو ترتيب كسر التعادل عند حدّ الخطة */
  const requested = parsed.allRequestedMarkers;
  const firstSeen = new Map<number, number>();
  requested.forEach((m, i) => firstSeen.set(m, i));

  // ── السجلّ: الرقم مقرونًا بمقطعه ──
  const registry = new Map<number, RetrievedSnippet>();
  /**
   * رقمٌ واحد لمقطعين مختلفين. لا يقع في مسارنا اليوم، ولو وقع فاختيار أحدهما
   * ينسب اقتباسًا إلى مقطع قد لا يحويه. الالتباس يُسقط الرقم، ولا يُحلّ بالحدس.
   */
  const registryAmbiguous = new Set<number>();
  const registryEntries = Array.isArray(input.sourceRegistry)
    ? input.sourceRegistry.slice(0, MAX_EVIDENCE_INPUT_ENTRIES)
    : [];
  for (const entry of registryEntries) {
    if (!entry || !isUsableMarker(entry.marker) || !entry.snippet) continue;
    const existing = registry.get(entry.marker);
    if (existing === undefined) {
      registry.set(entry.marker, entry.snippet);
      continue;
    }
    // نفس المقطع مكرّرًا ليس التباسًا؛ مقطعٌ آخر هو
    if (existing.chunkId !== entry.snippet.chunkId) registryAmbiguous.add(entry.marker);
  }

  // ── المرشّحون: الرقم واقتباسه ──
  const candidateQuote = new Map<number, string>();
  /** رقمٌ باقتباسين مختلفين: أيّهما قصد النموذج؟ لا نُخمّن (القاعدة ١٢) */
  const candidateAmbiguous = new Set<number>();
  const candidateEntries = Array.isArray(input.quoteCandidates)
    ? input.quoteCandidates.slice(0, MAX_EVIDENCE_INPUT_ENTRIES)
    : [];
  for (const entry of candidateEntries) {
    if (!entry || !isUsableMarker(entry.marker)) continue;
    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    const existing = candidateQuote.get(entry.marker);
    if (existing === undefined) {
      candidateQuote.set(entry.marker, quote);
      continue;
    }
    // متطابقان بعد التشذيب ⇒ تكرارٌ يُزال بلا أثر؛ مختلفان ⇒ التباس
    if (existing !== quote) candidateAmbiguous.add(entry.marker);
  }

  let droppedUnknownMarkers = 0;
  let droppedMissingQuotes = 0;
  let droppedInvalidQuotes = 0;

  const verified: ResolvedEvidenceSource[] = [];

  /**
   * اقتباسات قُبلت لكل مقطع.
   *
   * القاعدة ١٤: المقطع نفسه بعلامتين لا يجوز إلا باقتباسين مختلفين. وهو نفس ما
   * يفرضه الفهرس الجزئي `(message_id, chunk_id, quote)` في 0032 — والحسم هنا
   * يعني أن الكتابة تصل إلى القاعدة نظيفة بدل أن ترتدّ بـ23505 فتُسقط أدلة
   * الرسالة كلها من أجل تكرارٍ كان يمكن إسقاطه وحده.
   */
  const acceptedQuotesByChunk = new Map<string, Set<string>>();

  for (const marker of requested) {
    const snippet = registry.get(marker);
    // القاعدة ٩: رقمٌ في النص بلا مصدر ⇒ غير مدعوم
    if (snippet === undefined || registryAmbiguous.has(marker)) {
      droppedUnknownMarkers++;
      continue;
    }

    if (candidateAmbiguous.has(marker)) {
      droppedInvalidQuotes++;
      continue;
    }

    // القاعدة ١٠: رقمٌ بلا اقتباس ⇒ غير مدعوم
    const quote = candidateQuote.get(marker);
    if (quote === undefined || quote.length === 0) {
      droppedMissingQuotes++;
      continue;
    }

    // القاعدة ١١: ما لا يثبت لا يُحفظ
    const result = verifyEvidenceQuote({
      candidateQuote: quote,
      snippetContent: snippet.content,
    });
    if (!result.verified) {
      droppedInvalidQuotes++;
      continue;
    }

    const seen = acceptedQuotesByChunk.get(snippet.chunkId);
    if (seen !== undefined && seen.has(result.quote)) {
      droppedInvalidQuotes++;
      continue;
    }
    if (seen === undefined) {
      acceptedQuotesByChunk.set(snippet.chunkId, new Set([result.quote]));
    } else {
      seen.add(result.quote);
    }

    verified.push({
      marker, // القاعدة ١٥: لا إعادة ترقيم
      // ★ كل ما يلي من المقطع لا من النموذج
      chunkId: snippet.chunkId,
      fileId: snippet.fileId,
      chunkIndex: snippet.chunkIndex,
      fileNameSnapshot: snippet.fileName,
      pageNumberSnapshot: snippet.pageNumber,
      quote: result.quote, // شريحة الأصل
      quoteStart: result.start,
      quoteEnd: result.end,
      relevance: clampRelevance(snippet.similarity),
      verification: result.verification,
    });
  }

  /**
   * حدّ الخطة **بعد التحقق** لا قبله.
   *
   * قبله كان سيقطع مصادر ربما سقط بعضها في التحقق، فيضيع دليلٌ صالح لأجل
   * ادّعاءٍ كاذب سبقه في القائمة.
   */
  const limitRaw = input.maxVerifiedSources;
  const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.floor(limitRaw)) : 0;

  const ranked = [...verified].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // التعادل: أول ظهور في النص — ترتيبٌ ثابت لا يعتمد على استقرار الفرز
    return (firstSeen.get(a.marker) ?? 0) - (firstSeen.get(b.marker) ?? 0);
  });
  const sources = ranked.slice(0, limit);
  const droppedByPlanLimit = ranked.length - sources.length;

  // ── الفقرات: تُبنى من المقبول وحده ──
  const keptMarkers = new Set(sources.map((s) => s.marker));
  const segments: ResolvedEvidenceSegment[] = parsed.segments.map((seg) => {
    const sourceMarkers = seg.requestedMarkers.filter((m) => keptMarkers.has(m));
    return {
      segmentIndex: seg.segmentIndex,
      sourceMarkers,
      supported: sourceMarkers.length > 0,
    };
  });
  const unsupportedSegments = segments
    .filter((s) => !s.supported)
    .map((s) => s.segmentIndex);

  return {
    /**
     * من المُحلِّل مباشرةً: هو يجرّد **كل** علامة صحيحة عند المسح، فلا يبقى
     * فيه رقمٌ استُبعد لاحقًا ولا رقمٌ لم يُتحقَّق منه. والفقرة التي فقدت
     * مصادرها تُوسم في `segments` ولا يُشوَّه نصّها.
     */
    cleanText: parsed.cleanText,
    sources,
    segments,
    unsupportedSegments,
    stats: {
      requestedMarkers: requested.length,
      verifiedSources: sources.length,
      droppedUnknownMarkers,
      droppedMissingQuotes,
      droppedInvalidQuotes,
      droppedByPlanLimit,
    },
  };
}
