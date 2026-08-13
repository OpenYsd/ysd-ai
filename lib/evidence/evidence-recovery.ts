import "server-only";

import {
  countNumberedClaims,
  parseEvidenceMarkers,
} from "@/lib/evidence/marker-parser";
import { verifyEvidenceQuote } from "@/lib/evidence/quote-verifier";
import type { AIProviderAdapter } from "@/lib/ai/types";
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

/**
 * سقف نصّ المستخدم في نداء الاسترداد — **ميزانية تُوزَّع، لا قصّ من الآخر**.
 *
 * كان القصّ يقع على النصّ كاملًا بعد بنائه، والمصادر تُكتب أولًا. فحين تجاوز
 * عددها ثلاثة عشر ابتلع القصُّ **الفقرات المستهدفة والتعليمة الختامية معًا**:
 * يصل النموذج مصادرُ مبتورة بلا مهمّة، فلا يستطيع الربط لأنه لم يرَ ما يربطه.
 * وسقف الاسترجاع نفسه ستة عشر مقطعًا — أي أن الحدّ الطبيعي للنظام يقع فوق
 * عتبة القطع مباشرةً. قِيس: 16 مصدرًا ⇒ 20,040 حرفًا مقابل سقف 15,600.
 *
 * القيمة كما كانت (6_000 + 1_200×8) — المتغيّر هو **كيف** تُوزَّع لا كم هي.
 */
export const RECOVERY_MAX_USER_CHARS = RECOVERY_MAX_ANSWER_CHARS + RECOVERY_MAX_SNIPPET_CHARS * 8;

/** قياسات بناء الحمولة — أعداد ومنطقيّات، بلا محتوى ولا أسماء */
export interface RecoveryPromptBudget {
  sourceCount: number;
  sourcesIncluded: number;
  sourcesDropped: number;
  /** هل قُلّصت المصادر بسبب الميزانية؟ (لا يعني قطع مهمّة — ذلك مستحيل) */
  promptTruncated: boolean;
  /** كم مقطعًا تجاوز سقف المقطع الواحد فقُصّ */
  snippetTruncatedCount: number;
}

export type RecoveryStatus = "not_needed" | "success" | "failed" | "timeout";

/**
 * سبب فشل الاسترداد — رمز مغلق.
 *
 * `failed` وحدها كانت تغطّي ثلاث حالات متباينة: نداءٌ لم ينجح، وردٌّ غير
 * قابل للتحليل، وروابطُ لم ينجُ منها اقتباس. وعلاج كلٍّ منها مختلف تمامًا،
 * فجمعُها في كلمة يجعل التشخيص مستحيلًا بالضبط حين نحتاجه.
 *
 * و`provider_error` تعني **أن نداء المحوّل لم ينجح** — لا أكثر. لا ندّعي
 * أن الطلب بلغ المزوّد الخارجي أو لم يبلغه: المحوّل لا يقول ذلك.
 */
export type RecoveryFailureReason =
  | "none"
  | "provider_error"
  | "unparseable"
  | "no_links"
  | "no_verified_quote";

/** قياسات الاسترداد — أعداد ومنطقيّات فقط، بلا أي محتوى */
export interface RecoveryTelemetry {
  providerCallAttempted: boolean;
  providerCallSucceeded: boolean;
  linksReturned: number;
  linksScoped: number;
  verifiedSources: number;
  failureReason: RecoveryFailureReason;
}

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
}): { systemPrompt: string; userText: string; budget: RecoveryPromptBudget } {
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

  /**
   * ★ الترتيب: المهمّة أولًا في الحجز، والمصادر تأخذ ما تبقّى.
   *
   * الفقرات المستهدفة والتعليمة الختامية تُحجز مساحتهما **قبل** أي مصدر،
   * فلا يمكن لكثرة المصادر أن تبترهما. وهذا هو الفرق كله عن القصّ السابق:
   * ذاك كان يقطع من الآخر — حيث المهمّة — وهذا يقطع من المصادر وحدها.
   */
  const segmentBlock = input.segments
    .map((s) => `[فقرة ${s.segmentIndex}]\n${s.text}`)
    .join("\n\n")
    .slice(0, RECOVERY_MAX_ANSWER_CHARS);

  const TAIL = "\n\nأخرج JSON الروابط الآن.";
  const HEAD = "المصادر:\n";
  const MID = "\n\nالإجابة:\n";
  const scaffold = HEAD.length + MID.length + segmentBlock.length + TAIL.length;

  /** ما تبقّى للمصادر بعد حجز المهمّة — لا يقلّ عن صفر */
  let remaining = Math.max(0, RECOVERY_MAX_USER_CHARS - scaffold);

  let snippetTruncatedCount = 0;
  const blocks: string[] = [];

  /**
   * المصادر بترتيب الاسترجاع كما هي — لا إعادة ترتيب ولا إعادة تقييم.
   * والمحذوف هو **آخرها** أي الأقل صلة، لأن الاسترجاع رتّبها بالصلة أصلًا.
   */
  for (const src of input.sources) {
    const content = src.content.slice(0, RECOVERY_MAX_SNIPPET_CHARS);
    const block = `<source index="${src.marker}">\n${content}\n</source>`;
    const cost = block.length + 1; // فاصل السطر بين الكتل
    if (cost > remaining) break; // لا يُقصّ مصدر جزئيًّا: يُحذف كاملًا أو يُدرَج كاملًا
    /**
     * العدّ **بعد** القبول لا قبله.
     *
     * مقطعٌ قُصّ ثم حُذف لضيق الميزانية ليس «مقطعًا مقصوصًا في الحمولة»،
     * وعدّه كذلك يجعل الرقم أكبر من عدد المصادر المُدرَجة فيُقرأ خطأً.
     */
    if (content.length < src.content.length) snippetTruncatedCount++;
    blocks.push(block);
    remaining -= cost;
  }

  const userText = `${HEAD}${blocks.join("\n")}${MID}${segmentBlock}${TAIL}`;

  return {
    systemPrompt,
    userText,
    budget: {
      sourceCount: input.sources.length,
      sourcesIncluded: blocks.length,
      sourcesDropped: input.sources.length - blocks.length,
      promptTruncated: blocks.length < input.sources.length,
      snippetTruncatedCount,
    },
  };
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
  /**
   * ★ إصدار التقسيم — **مطلوب**، لا اختياري.
   *
   * جعله اختياريًّا يعيد العطل نفسه: مستدعٍ ينساه فيهبط صامتًا إلى v1
   * وتصير فهارس المقاطع تعني شيئًا آخر. فالنوع هو الحارس هنا.
   */
  segmentation: 1 | 2;
}): ResolvedEvidence {
  const parsed = parseEvidenceMarkers(input.cleanText, {
    segmentation: input.segmentation,
  });
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
    // يُعلن الإصدار الذي قُسّم به فعلًا — فيتحقّق منه الدمج قبل أن يثق به
    segmentationVersion: input.segmentation,
    lineSegments: parsed.lineSegments,
    numberedClaimCount: countNumberedClaims(input.cleanText),
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
  /**
   * ★ المزوّد الذي **أجاب فعلًا** — لا معرّف نموذج.
   *
   * كان الاسترداد موصولًا بـOpenRouter بالسلك، فحين أجاب Groq أُرسل معرّف
   * نموذجه إلى نقطة OpenRouter بمفتاحها. وفي أول طلب حيّ احتاج استردادًا
   * كان حساب OpenRouter في عطل `auth` — ففشل الاسترداد قبل أن يبدأ.
   */
  provider: AIProviderAdapter;
  maxVerifiedSources: number;
  /**
   * ★ إصدار التقسيم المتفاوَض عليه — **مطلوب** ويأتي من المسار.
   *
   * المظروف معطوب فلا يوجد `ResolvedEvidence` موثوق يُورَث منه الإصدار،
   * بخلاف الاسترداد الجزئي. فيُمرَّر صراحةً، ويحكم التحليل والحلّ معًا.
   */
  segmentation: 1 | 2;
  signal?: AbortSignal;
}): Promise<{ status: RecoveryStatus; evidence: ResolvedEvidence | null; telemetry: RecoveryTelemetry }> {
  const tel: RecoveryTelemetry = {
    providerCallAttempted: false,
    providerCallSucceeded: false,
    linksReturned: 0,
    linksScoped: 0,
    verifiedSources: 0,
    failureReason: "none",
  };
  const parsed = parseEvidenceMarkers(input.cleanText, {
    segmentation: input.segmentation,
  });
  if (parsed.segments.length === 0 || input.sourceRegistry.length === 0) {
    return { status: "failed", evidence: null, telemetry: { ...tel, failureReason: "provider_error" } };
  }
  if (!input.provider.requestJsonCompletion) {
    return { status: "failed", evidence: null, telemetry: { ...tel, failureReason: "provider_error" } };
  }
  tel.providerCallAttempted = true;

  const { systemPrompt, userText } = buildRecoveryPrompt({
    segments: parsed.segments
      .map((s) => ({ segmentIndex: s.segmentIndex, text: s.cleanText }))
      .slice(0, 64),
    sources: input.sourceRegistry.map((e) => ({ marker: e.marker, content: e.snippet.content })),
  });

  const answer = await input.provider.requestJsonCompletion({
    systemPrompt,
    // الحمولة محدودة: إجابة طويلة لا تُرسل كاملة
    // لا قصّ هنا: الميزانية طُبّقت في البناء، والمهمّة محجوزة بالتصميم
    userText,
    maxTokens: RECOVERY_MAX_TOKENS,
    timeoutMs: RECOVERY_TIMEOUT_MS,
    signal: input.signal,
  });

  if (!answer.ok) {
    return {
      status: answer.reason === "timeout" ? "timeout" : "failed",
      evidence: null,
      telemetry: { ...tel, failureReason: "provider_error" },
    };
  }
  tel.providerCallSucceeded = true;

  const links = parseRecoveryLinks(answer.text);
  if (links === null) {
    return { status: "failed", evidence: null, telemetry: { ...tel, failureReason: "unparseable" } };
  }
  tel.linksReturned = links.length;
  tel.linksScoped = links.length;
  if (links.length === 0) {
    return { status: "failed", evidence: null, telemetry: { ...tel, failureReason: "no_links" } };
  }

  const evidence = resolveRecoveredEvidence({
    cleanText: input.cleanText,
    links,
    sourceRegistry: input.sourceRegistry,
    maxVerifiedSources: input.maxVerifiedSources,
    segmentation: input.segmentation,
  });

  tel.verifiedSources = evidence.sources.length;
  // بلا مصدر متحقَّق واحد لا معنى لتسميتها نجاحًا
  const ok = evidence.sources.length > 0;
  return {
    status: ok ? "success" : "failed",
    evidence: ok ? evidence : null,
    telemetry: { ...tel, failureReason: ok ? "none" : "no_verified_quote" },
  };
}

// ════════════════════════════════════════════════════════════
//  استرداد **جزئي** — تغطية ناقصة لا مظروف معطوب
// ════════════════════════════════════════════════════════════

/** سبب تشغيل الاسترداد — رمز مغلق للتشخيص */
export type RecoveryReason = "none" | "malformed_envelope" | "partial_coverage";

export interface PartialRecoveryOutcome {
  status: RecoveryStatus;
  evidence: ResolvedEvidence | null;
  /** أرقام المقاطع المطلوبة — أرقام فقط */
  requestedSegments: number[];
  recoveredSegments: number[];
  failedSegments: number[];
  /** قياسات بناء الحمولة — أعداد ومنطقيّات فقط */
  budget: RecoveryPromptBudget;
  /** عدد الروابط التي أعادها النموذج بعد التحليل والحصر */
  linksReturned: number;
}

/**
 * يدمج استردادًا جزئيًا في حلٍّ قائم — **بلا مساس بما تحقّق**.
 *
 * القاعدة: المقطع المدعوم يبقى كما هو حرفيًا، بمصادره وترتيبها. والمصدر
 * المسترَدّ لا يُضاف إن كان رقمه موجودًا سلفًا — فلا صفّ مكرّر ولا استبدال
 * لمرجع صالح رآه المستخدم.
 */
export function mergePartialEvidence(
  base: ResolvedEvidence,
  recovered: ResolvedEvidence,
  maxVerifiedSources: number,
): ResolvedEvidence {
  /**
   * ★ الثابت: لا دمج إلا بين حلَّين قُسّما بالإصدار نفسه.
   *
   * الدمج يطابق `segmentIndex` بـ`segmentIndex`. فإن اختلف الإصدار اختلف
   * معنى الرقم: «المقطع 0» عند v1 قد يضمّ ثلاثة ادّعاءات، وعند v2 يضمّ
   * الأول وحده. فمصدرٌ وُجد للادّعاء الثالث يُلصق بالأول بلا أن يشتكي أحد.
   *
   * والرفض هنا لا في المستدعي: هذه نقطة الدمج، وأيّ مسار جديد يمرّ بها.
   * ويُعاد الأساس **بمرجعه** لا بنسخة — فيقدر المستدعي على كشف الرفض
   * بمطابقة مرجعية، بلا رمز خطأ جديد ولا تغيير في الشكل.
   */
  if (base.segmentationVersion !== recovered.segmentationVersion) return base;

  const baseMarkers = new Set(base.sources.map((s) => s.marker));
  const targeted = new Set(base.unsupportedSegments);

  // مصادر جديدة فقط — الرقم الموجود سلفًا يفوز دائمًا
  const additions = recovered.sources.filter((s) => !baseMarkers.has(s.marker));
  const limit = Number.isFinite(maxVerifiedSources) ? Math.max(0, Math.floor(maxVerifiedSources)) : 0;
  const room = Math.max(0, limit - base.sources.length);
  const accepted = additions.slice(0, room);
  const acceptedMarkers = new Set(accepted.map((s) => s.marker));
  const sources = [...base.sources, ...accepted];

  const recoveredByIndex = new Map(recovered.segments.map((s) => [s.segmentIndex, s]));

  const segments = base.segments.map((seg) => {
    // ★ المدعوم لا يُمسّ — ولا حتى يُعاد ترتيب مصادره
    if (seg.supported || !targeted.has(seg.segmentIndex)) return seg;

    const found = recoveredByIndex.get(seg.segmentIndex);
    if (!found) return seg;
    // تُقبل الأرقام التي نجت من التحقق ومن سقف الخطة معًا
    const markers = found.sourceMarkers.filter(
      (m) => acceptedMarkers.has(m) || baseMarkers.has(m),
    );
    if (markers.length === 0) return seg;
    return {
      segmentIndex: seg.segmentIndex,
      sourceMarkers: [...markers].sort((a, b) => a - b),
      supported: true,
    };
  });

  const unsupportedSegments = segments.filter((s) => !s.supported).map((s) => s.segmentIndex);

  return {
    cleanText: base.cleanText,
    // الإصداران متساويان بحكم الثابت أعلاه — فأيّهما هو هو
    segmentationVersion: base.segmentationVersion,
    // النصّ لم يتغيّر بالدمج ⇒ التخطيط والعدّ يبقيان كما هما
    lineSegments: base.lineSegments,
    numberedClaimCount: base.numberedClaimCount,
    sources,
    segments,
    unsupportedSegments,
    stats: {
      ...base.stats,
      verifiedSources: sources.length,
      // ما أُسقط في المحاولة الجزئية يُضاف إلى ما أُسقط أصلًا
      droppedInvalidQuotes: base.stats.droppedInvalidQuotes + recovered.stats.droppedInvalidQuotes,
      droppedUnknownMarkers:
        base.stats.droppedUnknownMarkers + recovered.stats.droppedUnknownMarkers,
      droppedByPlanLimit: base.stats.droppedByPlanLimit + Math.max(0, additions.length - accepted.length),
    },
  };
}

/**
 * استرداد **المقاطع غير المدعومة وحدها** حين يكون المظروف صالحًا.
 *
 * الحادثة: مظروفٌ صالح بثلاثة مرشّحين، نجا منها واحد، فبقي مقطعان بلا دعم
 * رغم أن مقاطع الاسترجاع تحتوي ما يدعمهما. كان المسار يكتفي بذلك ويعرضهما
 * «غير مدعومَين» — ولا محاولة ثانية إلا حين يكون المظروف معطوبًا.
 *
 * ولا يُخفَّف التحقق بحرف: الاقتباس المسترَدّ يمرّ بنفس `resolveRecoveredEvidence`
 * — تطابق حرفي ثم تطبيع متحفّظ — ومَن يسقط يبقى مقطعه غير مدعوم.
 */
export async function attemptPartialEvidenceRecovery(input: {
  cleanText: string;
  resolved: ResolvedEvidence;
  sourceRegistry: EvidenceSourceRegistryEntry[];
  provider: AIProviderAdapter;
  maxVerifiedSources: number;
  signal?: AbortSignal;
}): Promise<PartialRecoveryOutcome> {
  const requestedSegments = [...input.resolved.unsupportedSegments].sort((a, b) => a - b);
  const emptyBudget: RecoveryPromptBudget = {
    sourceCount: input.sourceRegistry.length,
    sourcesIncluded: 0,
    sourcesDropped: 0,
    promptTruncated: false,
    snippetTruncatedCount: 0,
  };
  const empty: PartialRecoveryOutcome = {
    status: "failed",
    evidence: null,
    requestedSegments,
    recoveredSegments: [],
    failedSegments: requestedSegments,
    budget: emptyBudget,
    linksReturned: 0,
  };

  if (requestedSegments.length === 0 || input.sourceRegistry.length === 0) {
    return { ...empty, status: "not_needed", failedSegments: [] };
  }
  if (!input.provider.requestJsonCompletion) return empty;

  /**
   * ★ الإصدار **يُورَث من `resolved`** — ولا يُقبل كوسيط منفصل.
   *
   * فوسيطٌ منفصل يُنسى: هذا بعينه ما حدث. و`requestedSegments` مشتقّة من
   * `resolved.unsupportedSegments`، فقراءتها بإصدار آخر تجعل الفهرس نفسه
   * يشير إلى فقرة أخرى. المصدر واحد لأن المعنى واحد.
   */
  const segmentation = input.resolved.segmentationVersion;
  const parsed = parseEvidenceMarkers(input.cleanText, { segmentation });
  const targeted = new Set(requestedSegments);
  /**
   * ★ الفقرات المستهدفة وحدها تدخل الموجّه.
   *
   * إرسال المدعومة يُغري النموذج بإعادة ربطها فيُنتج بديلًا لمرجع صالح —
   * وتغييرُ مرجعٍ رآه المستخدم أسوأ من ترك فقرة بلا مرجع. وهو أيضًا أرخص:
   * حمولة أصغر ورموز أقل.
   */
  const segments = parsed.segments
    .filter((s) => targeted.has(s.segmentIndex))
    .map((s) => ({ segmentIndex: s.segmentIndex, text: s.cleanText }))
    .slice(0, 64);

  if (segments.length === 0) return empty;

  const { systemPrompt, userText, budget } = buildRecoveryPrompt({
    segments,
    sources: input.sourceRegistry.map((e) => ({ marker: e.marker, content: e.snippet.content })),
  });

  const answer = await input.provider.requestJsonCompletion({
    systemPrompt,
    // لا قصّ هنا: الميزانية طُبّقت في البناء، والمهمّة محجوزة بالتصميم
    userText,
    maxTokens: RECOVERY_MAX_TOKENS,
    timeoutMs: RECOVERY_TIMEOUT_MS,
    signal: input.signal,
  });

  if (!answer.ok) {
    return { ...empty, budget, status: answer.reason === "timeout" ? "timeout" : "failed" };
  }

  const links = parseRecoveryLinks(answer.text);
  if (links === null) return { ...empty, budget };

  /**
   * روابط لفقرات **غير مستهدفة** تُرمى قبل التحقق.
   *
   * النموذج قد يربط فقرةً مدعومة سلفًا رغم أنها لم تُرسل إليه. قبولها يعني
   * تغيير مرجع صالح — وهو ما يمنعه الدمج لاحقًا، لكن رميها هنا أوضح وأرخص.
   */
  const scoped = links.filter((l) => targeted.has(l.segmentIndex));
  if (scoped.length === 0) return { ...empty, budget, linksReturned: links.length };

  const recoveredEvidence = resolveRecoveredEvidence({
    cleanText: input.cleanText,
    links: scoped,
    sourceRegistry: input.sourceRegistry,
    maxVerifiedSources: input.maxVerifiedSources,
    segmentation,
  });

  const merged = mergePartialEvidence(input.resolved, recoveredEvidence, input.maxVerifiedSources);
  /**
   * ★ الدمج يرفض عند اختلاف الإصدارين فيُعيد الأساس كما هو.
   *
   * فيُكتشف ذلك بالمطابقة المرجعية: `merged === input.resolved` يعني أن
   * الثابت لم يصمد. والفشل الآمن هنا هو ترك المقاطع بلا دعم — لا إلصاق
   * مصدرٍ بفقرة قد لا تكون فقرته.
   */
  if (merged === input.resolved) return { ...empty, budget, linksReturned: scoped.length };
  const stillUnsupported = new Set(merged.unsupportedSegments);
  const recoveredSegments = requestedSegments.filter((i) => !stillUnsupported.has(i));
  const failedSegments = requestedSegments.filter((i) => stillUnsupported.has(i));

  return {
    status: recoveredSegments.length > 0 ? "success" : "failed",
    evidence: recoveredSegments.length > 0 ? merged : null,
    requestedSegments,
    recoveredSegments,
    failedSegments,
    budget,
    linksReturned: scoped.length,
  };
}
