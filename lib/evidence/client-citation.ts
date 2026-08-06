/**
 * عقد الاستشهاد الموحّد بين البثّ الحيّ وإعادة التحميل (v0.9.0، الإيداع السابع).
 *
 * وحدة **نقيّة بلا `server-only`** عمدًا: النوع نفسه يصف ما تعرضه الواجهة، فلا
 * بدّ أن يُستورد من العميل والخادم معًا.
 *
 * ── لماذا عقد واحد لا عقدان ──
 *
 * الاستشهاد يصل بطريقين: إطار SSE لحظة الإجابة، وصفٌّ من
 * `get_conversation_evidence` عند فتح المحادثة لاحقًا. ولو اختلف شكلهما
 * لاحتاجت الواجهة فرعين لكل حقل، ولانحرف أحدهما عن الآخر مع أول تعديل —
 * فيظهر المرجع بشكل بعد الإرسال وبشكل آخر بعد التحديث، وهو عطبٌ يراه المستخدم
 * ولا يراه أي اختبار وحدة.
 *
 * ── ولماذا `relevance` غائبة من النوع أصلًا ──
 *
 * ليست محذوفة عند الإرسال بل **غير موجودة**: درجة الصلة رقمٌ داخلي للترتيب،
 * وإظهارها يدعو المستخدم إلى قراءة «0.62» حكمًا على صحّة الاقتباس وهي ليست
 * كذلك. وغيابها من النوع يجعل تسريبها خطأ ترجمة لا سهوًا في مراجعة.
 */

export type CitationVerification = "exact" | "normalized";

export interface ClientCitation {
  /**
   * معرّف صفّ المصدر — يُعرف بعد الحفظ وحده.
   *
   * `null` في البثّ الحيّ: الصفّ يُنشأ داخل الدالة ولا تُعيد معرّفاته. ولا
   * أثر لذلك: مفتاح التمييز هو `(الرسالة، الفقرة، الرقم)` لا هذا الحقل.
   */
  sourceId: string | null;
  segmentIndex: number;
  marker: number;
  /** يصير `null` إذا حُذف المقطع — والاستشهاد يبقى */
  chunkId: string | null;
  fileId: string | null;
  chunkIndex: number;
  /** الحيّ ما دام الملف قائمًا، وإلا لقطة وقت الإجابة */
  fileName: string;
  pageNumber: number | null;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  verification: CitationVerification;
  /** هل يمكن فتح المقطع فعلًا؟ الواجهة لا تعرض رابطًا مكسورًا */
  sourceAvailable: boolean;
}

export interface EvidenceSummary {
  supported: boolean;
  supportedSegments: number;
  unsupportedSegments: number[];
  sourcesCount: number;
  version: number;
}

/** الشكل الخام لصفّ `get_conversation_evidence` */
export interface EvidenceRow {
  source_id: string | null;
  message_id: string;
  segment_index: number;
  marker: number;
  chunk_id: string | null;
  file_id: string | null;
  chunk_index: number;
  file_name: string;
  page_number: number | null;
  quote: string;
  quote_start: number;
  quote_end: number;
  verification: string;
  source_available: boolean;
}

/** الشكل الخام لإطار SSE من نوع `citation` */
export interface CitationEvent {
  type: "citation";
  segmentIndex: number;
  marker: number;
  chunkId: string | null;
  fileId: string | null;
  chunkIndex: number;
  fileName: string;
  pageNumber: number | null;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  verification: string;
  sourceAvailable: boolean;
}

const asVerification = (v: unknown): CitationVerification =>
  v === "normalized" ? "normalized" : "exact";

const asInt = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;

const asNullableInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

const asNullableId = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** صفّ القاعدة ⇒ العقد الموحّد */
export function citationFromRow(row: EvidenceRow): ClientCitation {
  return {
    sourceId: asNullableId(row.source_id),
    segmentIndex: asInt(row.segment_index),
    marker: asInt(row.marker),
    chunkId: asNullableId(row.chunk_id),
    fileId: asNullableId(row.file_id),
    chunkIndex: asInt(row.chunk_index),
    fileName: asText(row.file_name),
    pageNumber: asNullableInt(row.page_number),
    quote: asText(row.quote),
    quoteStart: asInt(row.quote_start),
    quoteEnd: asInt(row.quote_end),
    verification: asVerification(row.verification),
    sourceAvailable: row.source_available === true,
  };
}

/** إطار SSE ⇒ العقد الموحّد */
export function citationFromEvent(event: CitationEvent): ClientCitation {
  return {
    // لا يُعرف قبل القراءة — ولا يدخل في مفتاح التمييز
    sourceId: null,
    segmentIndex: asInt(event.segmentIndex),
    marker: asInt(event.marker),
    chunkId: asNullableId(event.chunkId),
    fileId: asNullableId(event.fileId),
    chunkIndex: asInt(event.chunkIndex),
    fileName: asText(event.fileName),
    pageNumber: asNullableInt(event.pageNumber),
    quote: asText(event.quote),
    quoteStart: asInt(event.quoteStart),
    quoteEnd: asInt(event.quoteEnd),
    verification: asVerification(event.verification),
    sourceAvailable: event.sourceAvailable === true,
  };
}

/**
 * مفتاح التمييز داخل الرسالة الواحدة.
 *
 * `(الفقرة، الرقم)` لا `sourceId`: الأخير غائب في البثّ الحيّ، فالتمييز به
 * كان سيُبقي النسخة الحيّة والنسخة المُعادة معًا بعد التحديث — أي استشهادين
 * لمرجع واحد.
 */
export const citationKey = (c: ClientCitation): string => `${c.segmentIndex}:${c.marker}`;

/** الترتيب المعتمد: الفقرة ثم الرقم — ثابت في الطريقين */
export function sortCitations(citations: ClientCitation[]): ClientCitation[] {
  return [...citations].sort((a, b) =>
    a.segmentIndex !== b.segmentIndex
      ? a.segmentIndex - b.segmentIndex
      : a.marker - b.marker,
  );
}

/**
 * يدمج مجموعتين بلا تكرار — **الأحدث يفوز**.
 *
 * الترتيب مقصود: ما جاء من القاعدة بعد إعادة التحميل أصدق مما بُثّ لحظة
 * الإجابة (قد يكون الملف حُذف بينهما، فتتغيّر `sourceAvailable` والاسم).
 * ولهذا `incoming` يحلّ محلّ `existing` عند تطابق المفتاح.
 */
export function mergeCitations(
  existing: ClientCitation[],
  incoming: ClientCitation[],
): ClientCitation[] {
  const byKey = new Map<string, ClientCitation>();
  for (const c of existing) byKey.set(citationKey(c), c);
  for (const c of incoming) byKey.set(citationKey(c), c);
  return sortCitations([...byKey.values()]);
}

/**
 * يقرأ ملخّص الأدلة من `messages.metadata`.
 *
 * الرسائل القديمة بلا الحقل — وهو الوضع الطبيعي لا خطأ: `null` تعني «لا أدلة
 * لهذه الرسالة» وتُعرض كما كانت قبل v0.9 تمامًا.
 */
export function evidenceSummaryFromMetadata(metadata: unknown): EvidenceSummary | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const raw = (metadata as { evidence?: unknown }).evidence;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const e = raw as Record<string, unknown>;
  const unsupported = Array.isArray(e.unsupportedSegments)
    ? e.unsupportedSegments.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];

  return {
    supported: e.supported === true,
    supportedSegments: asInt(e.supportedSegments),
    unsupportedSegments: unsupported.map((v) => Math.trunc(v)),
    sourcesCount: asInt(e.sourcesCount),
    version: asInt(e.version, 1),
  };
}

/** يجمع صفوف الأدلة في خريطة بالرسالة — بترتيب ثابت داخل كل رسالة */
export function groupCitationsByMessage(rows: EvidenceRow[]): Map<string, ClientCitation[]> {
  const byMessage = new Map<string, ClientCitation[]>();
  for (const row of rows) {
    const messageId = asText(row.message_id);
    if (!messageId) continue;
    const list = byMessage.get(messageId);
    const citation = citationFromRow(row);
    if (list) list.push(citation);
    else byMessage.set(messageId, [citation]);
  }
  for (const [id, list] of byMessage) byMessage.set(id, sortCitations(list));
  return byMessage;
}
