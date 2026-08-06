import "server-only";

import { parseEvidenceMarkers } from "@/lib/evidence/marker-parser";
import { verifyEvidenceQuote } from "@/lib/evidence/quote-verifier";
import { requestJsonCompletion } from "@/lib/ai/openrouter";
import type {
  EvidenceSourceRegistryEntry,
  ResolvedEvidence,
  ResolvedEvidenceSource,
} from "@/lib/evidence/resolve-evidence";

/**
 * استرداد الأدلة — محاولة واحدة حين يتجاهل النموذج الغلاف (v0.9.0).
 *
 * ── لماذا لزم هذا ──
 *
 * الموجّه يصل إلى نموذج الاحتياط كاملًا — **مُثبَت** بقراءة جسم الطلب الثاني
 * حرفًا بحرف. فالسقوط إلى الاحتياط لا يُفقد التعليمات ولا ترقيم المصادر.
 * لكنّ الالتزام بالغلاف يبقى **سلوك نموذج**، ونماذج السلسلة تتفاوت فيه:
 * `nemotron` أجاب إجابةً سليمة كاملة ولم يُخرج الغلاف إطلاقًا (رسالة
 * c6ba2754، `completion = null`، `sourcesCount = 0`).
 *
 * فبناء الاستشهاد على التزام النموذج وحده يجعل وجود المراجع رهنًا بأي نموذج
 * تصادف أن ردّ. والاسترداد يفصل الأمرين: الإجابة من النموذج، والاستشهاد
 * سؤالٌ مستقلّ يُطرح بعدها.
 *
 * ── وما لا يفعله ──
 *
 * لا يمسّ نصّ الإجابة. المستخدم رأى ردَّه كاملًا وانتهى؛ هذه مرحلة لاحقة
 * تُنتج مراجع أو لا تُنتج، ولا تُعيد كتابة حرف واحد مما قرأه.
 *
 * ولا يُصدَّق فيه شيء: الرقم يُقابَل بالسِّجل، والاقتباس يمرّ بنفس المتحقّق
 * (`exact` أو `normalized`)، ودرجة الصلة من المقطع وحده. النموذج هنا **يقترح
 * موضعًا**، والخادم هو من يُثبت.
 */

/** سقف الاسترداد — محاولة واحدة بمهلة قصيرة وحمولة محدودة */
export const RECOVERY_TIMEOUT_MS = 8_000;
export const RECOVERY_MAX_TOKENS = 700;
/** أقصى ما يُرسل من نصّ الإجابة — الفقرات الأولى تكفي للربط */
export const RECOVERY_MAX_ANSWER_CHARS = 6_000;
/** أقصى ما يُرسل من كل مقطع */
export const RECOVERY_MAX_SNIPPET_CHARS = 1_200;
/** أقصى عدد روابط تُقرأ من الرد */
export const RECOVERY_MAX_LINKS = 24;

export type RecoveryStatus = "not_needed" | "success" | "failed" | "timeout";

export interface RecoveryLink {
  segmentIndex: number;
  marker: number;
  quote: string;
}

/** مفاتيح تلوّث النموذج الأولي — تُرفض أينما ظهرت */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * موجّه الاسترداد — الفقرات مرقّمة والمصادر مرقّمة **بنفس ترقيم السياق**.
 *
 * دالة نقيّة: تُختبر بلا شبكة، ويمكن قراءة ما يُرسل فعلًا.
 */
export function buildRecoveryPrompt(input: {
  segments: { segmentIndex: number; text: string }[];
  sources: { marker: number; content: string }[];
}): { systemPrompt: string; userText: string } {
  const segmentBlock = input.segments
    .map((s) => `[فقرة ${s.segmentIndex}]\n${s.text}`)
    .join("\n\n");

  const sourceBlock = input.sources
    .map((s) => `<source index="${s.marker}">\n${s.content.slice(0, RECOVERY_MAX_SNIPPET_CHARS)}\n</source>`)
    .join("\n");

  const systemPrompt = `أنت مدقّق استشهادات. مهمتك ربط فقرات إجابة بمصادرها الحرفية.

قواعد صارمة:
- أخرج JSON واحدًا فقط، بلا أي شرح قبله أو بعده، وبلا أسيجة شيفرة.
- الصيغة: {"links":[{"segmentIndex":0,"marker":1,"quote":"نص منقول حرفيًا"}]}
- segmentIndex رقم الفقرة كما ورد بين قوسين.
- marker رقم المصدر كما ورد في <source index="n">.
- quote نصٌّ **منقول حرفيًا** من ذلك المصدر بالذات، بين 12 و240 حرفًا.
- انقل النص كما هو تمامًا. لا تختصره ولا تعد صياغته ولا تترجمه.
- إن لم تجد نصًّا حرفيًا يدعم فقرةً، فلا تضف رابطًا لها.
- إن لم يوجد أي ربط مؤكد، أخرج: {"links":[]}
- لا تخترع اقتباسًا غير موجود في المصادر بأي حال.`;

  const userText = `المصادر:
${sourceBlock}

الإجابة:
${segmentBlock}

أخرج JSON الروابط الآن.`;

  return { systemPrompt, userText };
}

/**
 * يقرأ JSON الروابط — **صارم بلا استخراج جزئي**.
 *
 * نصٌّ تالف لا يُنتزع منه ما «يبدو» صالحًا: الرابط المنتزع من ردٍّ لا نثق به
 * يمرّ بعدها على التحقق فيبدو مُثبتًا.
 */
export function parseRecoveryLinks(raw: string): RecoveryLink[] | null {
  if (typeof raw !== "string") return null;

  // النموذج قد يغلّف JSON بسياج رغم المنع — نقبل التغليف ولا نقبل ما عداه
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "links") return null;

  const { links } = parsed as { links: unknown };
  if (!Array.isArray(links)) return null;
  if (links.length > RECOVERY_MAX_LINKS) return null;

  const out: RecoveryLink[] = [];
  for (const entry of links) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const k = Object.keys(entry as Record<string, unknown>);
    if (k.length !== 3) return null;
    if (k.some((x) => FORBIDDEN_KEYS.has(x))) return null;

    const { segmentIndex, marker, quote } = entry as {
      segmentIndex: unknown;
      marker: unknown;
      quote: unknown;
    };
    if (typeof segmentIndex !== "number" || !Number.isInteger(segmentIndex)) return null;
    if (segmentIndex < 0 || segmentIndex > 4095) return null;
    if (typeof marker !== "number" || !Number.isInteger(marker)) return null;
    if (marker < 1 || marker > 99) return null;
    if (typeof quote !== "string") return null;
    const trimmed = quote.trim();
    if (trimmed.length < 12 || trimmed.length > 240) return null;

    out.push({ segmentIndex, marker, quote: trimmed });
  }
  return out;
}

/**
 * يحوّل روابط الاسترداد إلى أدلة **مُثبَتة** — بنفس صرامة المسار الأصلي.
 *
 * الفرق الوحيد عن `resolveEvidence` أن موضع الاستشهاد يأتي من الرابط لا من
 * علامة في النصّ. وكل ما عدا ذلك متطابق: الرقم يُقابَل بالسِّجل، والاقتباس
 * يمرّ بالمتحقّق، والقيم من المقطع، ولا مطابقة تقريبية.
 */
export function resolveRecoveredEvidence(input: {
  cleanText: string;
  links: RecoveryLink[];
  sourceRegistry: EvidenceSourceRegistryEntry[];
  maxVerifiedSources: number;
}): ResolvedEvidence {
  const parsed = parseEvidenceMarkers(input.cleanText);
  const segmentCount = parsed.segments.length;

  const registry = new Map(input.sourceRegistry.map((e) => [e.marker, e.snippet]));

  let droppedUnknownMarkers = 0;
  let droppedInvalidQuotes = 0;
  let droppedInvalidRelevance = 0;

  const verified: (ResolvedEvidenceSource & { segmentIndex: number })[] = [];
  const acceptedQuotesByChunk = new Map<string, Set<string>>();
  /** رقم واحد لكل فقرة لا يتكرر */
  const seenPairs = new Set<string>();

  for (const link of input.links) {
    // الفقرة يجب أن توجد فعلًا في الإجابة المعروضة
    if (link.segmentIndex >= segmentCount) {
      droppedUnknownMarkers++;
      continue;
    }
    const snippet = registry.get(link.marker);
    if (!snippet) {
      droppedUnknownMarkers++;
      continue;
    }
    const pair = `${link.segmentIndex}:${link.marker}`;
    if (seenPairs.has(pair)) continue;

    const result = verifyEvidenceQuote({
      candidateQuote: link.quote,
      snippetContent: snippet.content,
    });
    if (!result.verified) {
      droppedInvalidQuotes++;
      continue;
    }

    const relevance = snippet.similarity;
    if (!Number.isFinite(relevance) || relevance < -1e-6 || relevance > 1 + 1e-6) {
      droppedInvalidRelevance++;
      continue;
    }

    const seen = acceptedQuotesByChunk.get(snippet.chunkId);
    if (seen?.has(result.quote)) {
      droppedInvalidQuotes++;
      continue;
    }
    if (seen) seen.add(result.quote);
    else acceptedQuotesByChunk.set(snippet.chunkId, new Set([result.quote]));

    seenPairs.add(pair);
    verified.push({
      segmentIndex: link.segmentIndex,
      marker: link.marker,
      chunkId: snippet.chunkId,
      fileId: snippet.fileId,
      chunkIndex: snippet.chunkIndex,
      fileNameSnapshot: snippet.fileName,
      pageNumberSnapshot: snippet.pageNumber,
      quote: result.quote,
      quoteStart: result.start,
      quoteEnd: result.end,
      relevance: relevance < 0 ? 0 : relevance > 1 ? 1 : relevance,
      verification: result.verification,
    });
  }

  /**
   * حدّ الخطة على **المصادر** لا الروابط: الرقم الواحد قد يدعم فقرتين، وهو
   * مصدر واحد. الترتيب بالصلة ثم بالرقم — ثابت لا يعتمد على ترتيب النموذج.
   */
  const byMarker = new Map<number, ResolvedEvidenceSource>();
  for (const v of verified) {
    if (!byMarker.has(v.marker)) {
      // `segmentIndex` يخصّ الرابط لا المصدر — يُترك خارج الصفّ المحفوظ
      const { segmentIndex, ...source } = v;
      void segmentIndex;
      byMarker.set(v.marker, source);
    }
  }
  const ranked = [...byMarker.values()].sort((a, b) =>
    b.relevance !== a.relevance ? b.relevance - a.relevance : a.marker - b.marker,
  );
  const limit = Number.isFinite(input.maxVerifiedSources)
    ? Math.max(0, Math.floor(input.maxVerifiedSources))
    : 0;
  const sources = ranked.slice(0, limit);
  const droppedByPlanLimit = ranked.length - sources.length;
  const kept = new Set(sources.map((s) => s.marker));

  const bySegment = new Map<number, number[]>();
  for (const v of verified) {
    if (!kept.has(v.marker)) continue;
    const list = bySegment.get(v.segmentIndex);
    if (list) {
      if (!list.includes(v.marker)) list.push(v.marker);
    } else bySegment.set(v.segmentIndex, [v.marker]);
  }

  const segments = parsed.segments.map((s) => {
    const markers = (bySegment.get(s.segmentIndex) ?? []).sort((a, b) => a - b);
    return { segmentIndex: s.segmentIndex, sourceMarkers: markers, supported: markers.length > 0 };
  });

  return {
    cleanText: input.cleanText,
    sources,
    segments,
    unsupportedSegments: segments.filter((s) => !s.supported).map((s) => s.segmentIndex),
    stats: {
      requestedMarkers: input.links.length,
      verifiedSources: sources.length,
      droppedUnknownMarkers,
      droppedMissingQuotes: 0,
      droppedInvalidQuotes,
      droppedInvalidRelevance,
      droppedByPlanLimit,
    },
  };
}

/**
 * يُشغّل محاولة الاسترداد الواحدة.
 *
 * لا يرمي أبدًا: فشلها يترك الرد كما هو «غير موثّق»، وهو ما كان سيقع بدونها.
 */
export async function attemptEvidenceRecovery(input: {
  cleanText: string;
  sourceRegistry: EvidenceSourceRegistryEntry[];
  model: string;
  maxVerifiedSources: number;
  signal?: AbortSignal;
}): Promise<{ status: RecoveryStatus; evidence: ResolvedEvidence | null }> {
  const parsed = parseEvidenceMarkers(input.cleanText);
  if (parsed.segments.length === 0 || input.sourceRegistry.length === 0) {
    return { status: "failed", evidence: null };
  }

  const { systemPrompt, userText } = buildRecoveryPrompt({
    segments: parsed.segments
      .map((s) => ({ segmentIndex: s.segmentIndex, text: s.cleanText }))
      .slice(0, 64),
    sources: input.sourceRegistry.map((e) => ({ marker: e.marker, content: e.snippet.content })),
  });

  const answer = await requestJsonCompletion({
    model: input.model,
    systemPrompt,
    // الحمولة محدودة: إجابة طويلة لا تُرسل كاملة
    userText: userText.slice(0, RECOVERY_MAX_ANSWER_CHARS + RECOVERY_MAX_SNIPPET_CHARS * 8),
    maxTokens: RECOVERY_MAX_TOKENS,
    timeoutMs: RECOVERY_TIMEOUT_MS,
    signal: input.signal,
  });

  if (!answer.ok) {
    return { status: answer.reason === "timeout" ? "timeout" : "failed", evidence: null };
  }

  const links = parseRecoveryLinks(answer.text);
  if (links === null) return { status: "failed", evidence: null };

  const evidence = resolveRecoveredEvidence({
    cleanText: input.cleanText,
    links,
    sourceRegistry: input.sourceRegistry,
    maxVerifiedSources: input.maxVerifiedSources,
  });

  // بلا مصدر متحقَّق واحد لا معنى لتسميتها نجاحًا
  return {
    status: evidence.sources.length > 0 ? "success" : "failed",
    evidence: evidence.sources.length > 0 ? evidence : null,
  };
}
