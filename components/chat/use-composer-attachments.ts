"use client";

/**
 * دورة حياة مرفقات شريط الكتابة: الطابور، الرفع، التجهيز، الإزالة، وإعادة المحاولة.
 *
 * ★ لا مسارَ خادمٍ جديد
 *
 *   الرفع `POST /api/files/upload` (XHR لتقدّمٍ حقيقيّ)، والتجهيز
 *   `POST /api/files/:id/rag`، والاستخراج من جديد `POST /api/files/:id/process`،
 *   والإزالة من السياق `PATCH /api/files/:id` بـ`conversationId: null` — كما كانت.
 *   الجديد تنسيقُها لعدّة ملفّاتٍ معًا لا غير.
 *
 * ★ اثنان في آنٍ واحد
 *
 *   الخادم يسمح بعشر عمليّات رفعٍ في الدقيقة. وأوّلُ 429 **يوقف الطابور كلَّه**
 *   مدّةَ `Retry-After` ويُعيد الملف إلى رأسه — فلا يُرمى باقي الدفعة على نافذةٍ
 *   معلومٌ أنها مغلقة، ولا تتحوّل عشرون بطاقةً إلى أخطاء. ولكل ملفٍّ ثلاثُ
 *   انتظاراتٍ تلقائيّة، ثم خطأٌ قابلٌ للإعادة يدويًّا.
 *
 * ★ والمحادثة تُثبَّت لكل ملفٍّ عند اختياره
 *
 *   كلُّ رفعٍ يحمل معرّف المحادثة التي اختير فيها، والخادم يتحقّق من ملكيّتها.
 *
 * ★ وإعادةُ تركيب المحادثة نفسها لا تُضيّع ما اختاره صاحبها
 *
 *   محادثةٌ جديدة تنتقل إلى `/chat/:id` بعد أول ردّ (`router.refresh`)، فيُفكّ
 *   المكوّن ويُركَّب غيرُه **للمحادثة نفسها**. فتُسلَّم المسوّدات عند التفكيك —
 *   بملفّاتها ورفعها الجاري — مفتاحُها المحادثةُ التي اختيرت فيها، ولا يتبنّاها
 *   إلا مكوّنٌ يُركَّب **لتلك المحادثة**. وتركيبُ محادثةٍ أخرى يُلغيها فورًا.
 *
 * ★ وردٌّ مقطوعٌ لا يعني ملفًّا لم يُحفظ
 *
 *   الخادم يُدرج الصفّ قبل التخزين والاستخراج، فقد يُحفظ الملفُّ كاملًا ثم يصل
 *   502 من الوسيط (رُصد حيًّا). فلكلّ ملفٍّ مختارٍ معرّفٌ ثابت (`clientUploadId`)
 *   يُرسل معه، وقبل عرض «أعد الرفع» بعد 5xx أو انقطاع نسأل الخادم: هل حُفظ؟
 *   فإن وُجد تبنّيناه، وإن لم يوجد عرضنا الإعادة — والإعادةُ بالمعرّف نفسه
 *   يُعيد الخادمُ لها الملفَّ إن حُفظ في الأثناء، فلا نسخةَ ثانية.
 *
 * ★ والتجهيزُ يُتابَع حتى ينتهي — بلا إلحاح
 *
 *   الاستطلاع يتباطأ حين لا يتغيّر شيء (حتى 15 ثانية) ولا يتوقّف بعد مدّةٍ
 *   ثابتة. ويكشف الوظيفةَ المتوقّفة من بيانات الخادم (نبضٌ أقدمُ من عقد الإيجار،
 *   أو وظيفةٌ مستحقّةٌ لم يلتقطها أحد) فيستأنفها بطلب تجهيزٍ واحد، مرّاتٍ
 *   محدودةً متباعدة، ثم يعرض إعادةً يدويّة.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { uploadWithProgress, type UploadHandle, type UploadResult } from "@/components/files/upload";
import {
  attachmentsReducer,
  blocksSend,
  canRemove,
  classifyUploadFailure,
  fromServerFile,
  isImageMime,
  isIndexingStalled,
  localizeServerMessage,
  validateSelection,
  type AttachmentAction,
  type ComposerAttachment,
  type RagJobView,
  type ServerFileState,
} from "@/lib/chat/composer-attachments";

const UPLOAD_CONCURRENCY = 2;
/** انتظاراتٌ تلقائيّة بعد 429 لكل ملف — ثم خطأٌ بزرّ إعادة: لا حلقةَ بلا نهاية */
const RATE_LIMIT_WAITS = 3;
const RATE_LIMIT_WAIT_MAX_S = 60;
const TERMINAL = new Set(["ready_for_rag", "rag_failed", "failed"]);
/** مهلة تبنّي مسوّدات محادثةٍ فُكّ مكوّنها — بعدها يُلغى ما لم يتبنَّه أحد */
const CARRY_GRACE_MS = 5000;

/**
 * توقيتات الاستطلاع والمصالحة والاستئناف — في موضعٍ واحد.
 *
 * - الاستطلاع يبدأ سريعًا ويتباطأ حين لا يتغيّر شيء، ويعود سريعًا مع أيّ تقدّم.
 * - «متوقّف» = نبضٌ أقدمُ من عقد الإيجار (120 ث) بهامش، أو وظيفةٌ مستحقّةٌ منذ
 *   90 ث بلا التقاط — ولا يُحكم بذلك قبل 30 ث من طلب التجهيز.
 * - الاستئناف طلبُ تجهيزٍ واحد، بفاصل دقيقةٍ على الأقل، ثلاثَ مرّاتٍ في الأكثر.
 *
 * مُصدَّرةٌ ليضبطها الاختبار؛ ولا يغيّرها شيءٌ في التطبيق.
 */
export const COMPOSER_TIMINGS = {
  pollMinMs: 1500,
  pollMaxMs: 15_000,
  pollFactor: 1.5,
  pollHiddenMs: 30_000,
  reconcileDelaysMs: [0, 2000, 4000, 8000, 12_000] as readonly number[],
  stallLeaseMs: 150_000,
  stallQueuedMs: 90_000,
  stallMinAgeMs: 30_000,
  nudgeGapMs: 60_000,
  maxNudges: 3,
};

export interface InitialConversationFile {
  id: string;
  name: string;
  status: string;
  mime?: string | null;
  size?: number | null;
  ragTotal?: number | null;
  ragDone?: number | null;
  ragError?: string | null;
}

/** مَصبّ تقدّم الرفع — يُحوَّل إلى المكوّن الذي تبنّى الرفع */
interface ProgressSink {
  current: (percent: number) => void;
}

interface CarriedDraft {
  attachment: ComposerAttachment;
  file: File | null;
  handle: UploadHandle | null;
  sink: ProgressSink | null;
  rateWaits: number;
  clientUploadId: string | null;
}

interface Carry {
  drafts: CarriedDraft[];
  pausedUntil: number;
  timer: ReturnType<typeof setTimeout>;
}

/** مسوّداتٌ تنتظر مكوّنَ محادثتها — مفتاحها معرّف المحادثة التي اختيرت فيها */
const carried = new Map<string, Carry>();

function discardCarry(conversationId: string) {
  const carry = carried.get(conversationId);
  if (!carry) return;
  carried.delete(conversationId);
  clearTimeout(carry.timer);
  for (const d of carry.drafts) d.handle?.abort();
}

/** يُلغي كلَّ مسوّدةٍ معلّقة — للاختبارات، كي لا تعبر مسوّدةٌ من اختبارٍ إلى آخر */
export function discardCarriedAttachments() {
  for (const id of [...carried.keys()]) discardCarry(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const newUploadId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
      );

const stalledMessage = (locale: "ar" | "en") =>
  locale === "ar"
    ? "لم يتقدّم التجهيز بعد محاولات استئناف — أعد المحاولة"
    : "Preparation made no progress after resume attempts — try again";

/** ردٌّ لا يُعرف معه مصيرُ الملف: انقطاعٌ (لا إلغاءٌ منّا) أو خطأُ خادمٍ/وسيط */
const outcomeUnknown = (res: UploadResult) =>
  res.error !== "aborted" && (!res.status || res.status >= 500);

async function readError(res: Response | null, locale: "ar" | "en"): Promise<string | null> {
  if (!res) return null;
  try {
    const j = (await res.json()) as { error?: string };
    return localizeServerMessage(j.error, locale);
  } catch {
    return null;
  }
}

export function useComposerAttachments({
  conversationId,
  initial,
  ensureConversation,
  locale,
  onConversationError,
}: {
  /** محادثة الصفحة (`null` في محادثةٍ جديدة) — بها وحدها تُتبنّى مسوّداتٌ عبرت التفكيك */
  conversationId: string | null;
  initial: InitialConversationFile[] | undefined;
  ensureConversation: () => Promise<string | null>;
  locale: "ar" | "en";
  onConversationError: () => void;
}) {
  const [attachments, dispatch] = useReducer(attachmentsReducer, initial, (init) =>
    (init ?? []).map((f) =>
      fromServerFile({
        id: f.id,
        original_name: f.name,
        status: f.status,
        mime_type: f.mime ?? null,
        size_bytes: f.size ?? null,
        rag_total_chunks: f.ragTotal ?? null,
        rag_done_chunks: f.ragDone ?? null,
        rag_error: f.ragError ?? null,
      }),
    ),
  );

  const stateRef = useRef<ComposerAttachment[]>(attachments);
  stateRef.current = attachments;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const onConvErrorRef = useRef(onConversationError);
  onConvErrorRef.current = onConversationError;

  const mounted = useRef(false);
  /** يزيد مع كل تركيب: ما بدأ قبل التركيب الحاليّ لا يُكمل (StrictMode يركّب مرّتين) */
  const life = useRef(0);
  const seq = useRef(0);
  const files = useRef(new Map<string, File>());
  const convOf = useRef(new Map<string, string>());
  /** معرّفٌ ثابتٌ لكل ملفٍّ مختار — يعبر إعادة المحاولة وإعادة التركيب */
  const uploadIds = useRef(new Map<string, string>());
  const handles = useRef(new Map<string, UploadHandle>());
  const sinks = useRef(new Map<string, ProgressSink>());
  /** آخر من ينتظر نتيجة كلّ رفع — منتظرٌ أقدم لا يعالجها مرّتين */
  const settlers = useRef(new Map<string, object>());
  const removed = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const polling = useRef(new Set<string>());
  const limitsPromise = useRef<Promise<number | null> | null>(null);
  const pausedUntil = useRef(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateWaits = useRef(new Map<string, number>());
  /** مستنداتٌ تُبنّت بعد مصالحةٍ وهي ما زالت تُعالَج — يُطلب تجهيزُها حين يجهز نصُّها */
  const autoRag = useRef(new Set<string>());
  /** متى طُلب تجهيزُ كلّ ملف — لا يُحكم بالتوقّف قبل مهلةٍ من الطلب */
  const ragRequestedAt = useRef(new Map<string, number>());
  /** محاولاتُ الاستئناف التلقائيّ لكل ملف — محدودةٌ ومتباعدة */
  const nudges = useRef(new Map<string, { count: number; at: number }>());

  /** الحالة المرجعيّة تتقدّم مع كل إجراء — التفكيك قد يقع قبل أن يُرسم آخرها */
  const update = useCallback((action: AttachmentAction) => {
    stateRef.current = attachmentsReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  /** استئنافُ تجهيزٍ متوقّف: طلبٌ واحد، ولا يُنتظر (قد يطول التصريف) */
  const nudge = useCallback(
    (fileId: string) => {
      const now = Date.now();
      const n = nudges.current.get(fileId) ?? { count: 0, at: 0 };
      if (now - n.at < COMPOSER_TIMINGS.nudgeGapMs) return;
      if (n.count >= COMPOSER_TIMINGS.maxNudges) {
        update({ type: "indexFailed", fileId, kind: "indexStalled", message: stalledMessage(localeRef.current) });
        return;
      }
      nudges.current.set(fileId, { count: n.count + 1, at: now });
      void (async () => {
        const res = await fetch(`/api/files/${fileId}/rag`, { method: "POST" }).catch(() => null);
        if (!mounted.current || !res) return;
        // 200/202 (في الطابور)/409 (يعمل الآن)/429 (لاحقًا) — كلّها ليست فشلًا للملف
        if (res.ok || res.status === 409 || res.status === 429) return;
        update({ type: "indexFailed", fileId, message: await readError(res, localeRef.current) });
      })();
    },
    [update],
  );

  /**
   * متابعة حالة ملفٍّ على الخادم حتى حالةٍ نهائيّة — استطلاعٌ واحدٌ لكل ملف.
   * يتباطأ حين لا يتغيّر شيء، ولا ينقطع بعد مدّةٍ ثابتة، ويستأنف ما توقّف.
   */
  const poll = useCallback(
    async (fileId: string) => {
      if (polling.current.has(fileId)) return;
      polling.current.add(fileId);
      let delay = COMPOSER_TIMINGS.pollMinMs;
      let lastSignature = "";
      try {
        for (;;) {
          const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
          await sleep(hidden ? Math.max(delay, COMPOSER_TIMINGS.pollHiddenMs) : delay);
          if (!mounted.current) return;
          const current = stateRef.current.find((a) => a.fileId === fileId);
          // أُزيل، أو أعلن العميل فشلَه: لا يُطمس الفشل بحالةٍ قديمة
          if (!current || current.phase === "error") return;
          const res = await fetch(`/api/files/${fileId}`).catch(() => null);
          if (!mounted.current) return;
          if (!res) {
            // انقطاعٌ عابر: نحاول لاحقًا بتباطؤ، لا نتخلّى
            delay = Math.min(delay * COMPOSER_TIMINGS.pollFactor, COMPOSER_TIMINGS.pollMaxMs);
            continue;
          }
          if (!res.ok) return;
          const j = (await res.json().catch(() => null)) as { file?: ServerFileState; job?: RagJobView | null } | null;
          if (!j?.file) return;
          const file = j.file;
          update({ type: "serverState", fileId, file });

          if (autoRag.current.has(fileId) && file.status === "ready" && !isImageMime(file.mime_type)) {
            autoRag.current.delete(fileId);
            requestRagRef.current(fileId);
            delay = COMPOSER_TIMINGS.pollMinMs;
            continue;
          }
          const after = stateRef.current.find((a) => a.fileId === fileId);
          if (!after || after.phase === "error" || TERMINAL.has(file.status)) return;
          const waitingForRag = after.phase === "indexing" || autoRag.current.has(fileId);
          if (!waitingForRag && after.phase !== "processing") return;

          const signature = `${file.status}|${file.rag_done_chunks ?? ""}|${j.job?.status ?? ""}|${j.job?.heartbeat_at ?? ""}`;
          delay = signature !== lastSignature
            ? COMPOSER_TIMINGS.pollMinMs
            : Math.min(delay * COMPOSER_TIMINGS.pollFactor, COMPOSER_TIMINGS.pollMaxMs);
          lastSignature = signature;

          const requestedAt = ragRequestedAt.current.get(fileId) ?? 0;
          if (
            after.phase === "indexing" &&
            Date.now() - requestedAt >= COMPOSER_TIMINGS.stallMinAgeMs &&
            isIndexingStalled(file, j.job ?? null, Date.now(), {
              leaseMs: COMPOSER_TIMINGS.stallLeaseMs,
              queuedGraceMs: COMPOSER_TIMINGS.stallQueuedMs,
            })
          ) {
            nudge(fileId);
          }
        }
      } finally {
        polling.current.delete(fileId);
      }
    },
    [nudge, update],
  );

  /**
   * تجهيز مستندٍ للذكاء الاصطناعي. الطلب يُصرّف الوظيفة بنفسه وقد يطول، فلا
   * يُنتظر قبل الاستطلاع — كما كان. و409 («قيد التجهيز») و202 («في الطابور»)
   * و429 ليست فشلًا: الاستطلاعُ يتابع، ويستأنف إن توقّف شيء.
   */
  const requestRag = useCallback(
    (fileId: string) => {
      ragRequestedAt.current.set(fileId, Date.now());
      update({ type: "ragRequested", fileId });
      void (async () => {
        const res = await fetch(`/api/files/${fileId}/rag`, { method: "POST" }).catch(() => null);
        if (!mounted.current) return;
        if (!res || res.ok || res.status === 409 || res.status === 429) return;
        update({ type: "indexFailed", fileId, message: await readError(res, localeRef.current) });
      })();
      void poll(fileId);
    },
    [poll, update],
  );
  const requestRagRef = useRef(requestRag);
  requestRagRef.current = requestRag;

  const progressTo = useCallback(
    (key: string) => (percent: number) => {
      if (mounted.current && !removed.current.has(key)) update({ type: "uploadProgress", key, percent });
    },
    [update],
  );

  /** ملفٌّ حُفظ على الخادم — بردٍّ ناجح أو بعد مصالحة: يُتبنّى ويُتابَع تجهيزه */
  const onSaved = useCallback(
    (key: string, file: ServerFileState) => {
      files.current.delete(key);
      rateWaits.current.delete(key);
      const doc = !isImageMime(file.mime_type);
      const startRag = doc && file.status === "ready";
      const alreadyIndexing = doc && (file.status === "chunking" || file.status === "embedding");
      update({ type: "uploadDone", key, file, ragRequested: startRag || alreadyIndexing || file.status === "ready_for_rag" });
      if (startRag) {
        requestRag(file.id);
      } else if (doc && (file.status === "uploaded" || file.status === "processing")) {
        // حُفظ والاستخراجُ ما زال جاريًا (مصالحةٌ بعد ردٍّ مقطوع): يُطلب التجهيز حين يجهز النصّ
        autoRag.current.add(file.id);
        void poll(file.id);
      } else if (alreadyIndexing) {
        void poll(file.id);
      }
    },
    [poll, requestRag, update],
  );

  /** بعد ردٍّ مقطوع: هل حُفظ الملف؟ نسأل الخادم قبل أن نعرض إعادة الرفع */
  const reconcile = useCallback(
    async (key: string, res: UploadResult) => {
      const clientUploadId = uploadIds.current.get(key);
      const epoch = life.current;
      update({ type: "verifying", key });
      if (clientUploadId) {
        for (const wait of COMPOSER_TIMINGS.reconcileDelaysMs) {
          if (wait > 0) await sleep(wait);
          if (!mounted.current || epoch !== life.current || removed.current.has(key)) return;
          const r = await fetch(`/api/files?clientUploadId=${encodeURIComponent(clientUploadId)}`).catch(() => null);
          if (!mounted.current || epoch !== life.current || removed.current.has(key)) return;
          if (!r?.ok) continue;
          const j = (await r.json().catch(() => null)) as { files?: ServerFileState[] } | null;
          const saved = j?.files?.[0];
          if (saved) {
            onSaved(key, saved);
            return;
          }
        }
      }
      const failure = classifyUploadFailure(res.status, res.error);
      update({
        type: "uploadFailed",
        key,
        kind: failure.kind,
        retry: failure.retry,
        message: res.error && res.error !== "network" && res.error !== "aborted"
          ? localizeServerMessage(res.error, localeRef.current)
          : null,
      });
    },
    [onSaved, update],
  );

  /** نتيجة رفعٍ جارٍ — لمن بدأه، أو لمن تبنّاه بعد إعادة التركيب */
  const settleUpload = useCallback(
    async (key: string, handle: UploadHandle) => {
      const token = {};
      settlers.current.set(key, token);
      const res = await handle.done;
      if (settlers.current.get(key) !== token) return;
      settlers.current.delete(key);
      handles.current.delete(key);
      sinks.current.delete(key);
      if (!mounted.current || removed.current.has(key)) return;

      if (res.ok && res.file) {
        onSaved(key, res.file);
        return;
      }
      if (res.status === 429) {
        const waits = rateWaits.current.get(key) ?? 0;
        if (waits < RATE_LIMIT_WAITS) {
          rateWaits.current.set(key, waits + 1);
          const seconds = Math.min(Math.max(res.retryAfterSec ?? 10, 1), RATE_LIMIT_WAIT_MAX_S);
          pausedUntil.current = Math.max(pausedUntil.current, Date.now() + seconds * 1000);
          queue.current.unshift(key);
          update({ type: "retryQueued", key });
          return;
        }
      }
      rateWaits.current.delete(key);
      if (outcomeUnknown(res)) {
        await reconcile(key, res);
        return;
      }
      const failure = classifyUploadFailure(res.status, res.error);
      update({
        type: "uploadFailed",
        key,
        kind: failure.kind,
        retry: failure.retry,
        message: res.error && res.error !== "network" && res.error !== "aborted"
          ? localizeServerMessage(res.error, localeRef.current)
          : null,
      });
    },
    [onSaved, reconcile, update],
  );

  const runUpload = useCallback(
    async (key: string) => {
      const file = files.current.get(key);
      const conversationId = convOf.current.get(key);
      if (!file || !conversationId) return;
      update({ type: "uploadStart", key });
      const sink: ProgressSink = { current: progressTo(key) };
      const handle = uploadWithProgress({
        file,
        conversationId,
        clientUploadId: uploadIds.current.get(key) ?? null,
        onProgress: (percent) => sink.current(percent),
      });
      handles.current.set(key, handle);
      sinks.current.set(key, sink);
      await settleUpload(key, handle);
    },
    [progressTo, settleUpload, update],
  );

  const pump = useCallback(
    function pumpQueue() {
      const wait = pausedUntil.current - Date.now();
      if (wait > 0) {
        // الخادم قال «انتظر»: لا رفعَ جديدًا قبل أن تنقضي المدّة
        if (!resumeTimer.current && queue.current.length > 0) {
          resumeTimer.current = setTimeout(() => {
            resumeTimer.current = null;
            if (mounted.current) pumpQueue();
          }, wait);
        }
        return;
      }
      while (active.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
        const key = queue.current.shift() as string;
        if (removed.current.has(key) || handles.current.has(key)) continue;
        active.current += 1;
        void runUpload(key).finally(() => {
          active.current -= 1;
          if (mounted.current) pumpQueue();
        });
      }
    },
    [runUpload],
  );

  /** الحدّ الفعليّ من الخادم (usage_limits ∧ سقف المزوّد) — مرّةً في الجلسة */
  const loadLimit = useCallback((conversationId: string) => {
    if (!limitsPromise.current) {
      limitsPromise.current = fetch(`/api/files?conversationId=${encodeURIComponent(conversationId)}`)
        .then(async (res) => {
          if (!res.ok) return null;
          const j = (await res.json()) as { limits?: { maxFileMb?: number } };
          const n = Number(j.limits?.maxFileMb);
          return Number.isFinite(n) && n > 0 ? n : null;
        })
        .catch(() => null);
    }
    return limitsPromise.current;
  }, []);

  /** تحقّقٌ مسبقٌ ثم الطابور — لملفّاتٍ اختيرت الآن، أو عبرت إعادة التركيب قبل أن تبدأ */
  const enqueue = useCallback(
    async (keys: string[], conversationId: string) => {
      const epoch = life.current;
      const maxFileMb = await loadLimit(conversationId);
      if (!mounted.current || epoch !== life.current) return;

      for (const key of keys) {
        const file = files.current.get(key);
        if (!file || removed.current.has(key) || handles.current.has(key) || queue.current.includes(key)) continue;
        const invalid = validateSelection(file, maxFileMb);
        if (invalid) {
          files.current.delete(key);
          update({
            type: "uploadFailed",
            key,
            kind: invalid.kind,
            retry: null,
            message: invalid.limitMb ? `${invalid.limitMb} MB` : null,
          });
          continue;
        }
        queue.current.push(key);
      }
      pump();
    },
    [loadLimit, pump, update],
  );

  const addFiles = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      const items = list.map((file) => ({ key: `local-${Date.now().toString(36)}-${seq.current++}`, file }));
      update({
        type: "add",
        items: items.map(({ key, file }) => ({ key, name: file.name, size: file.size, mime: file.type })),
      });
      for (const { key, file } of items) {
        files.current.set(key, file);
        uploadIds.current.set(key, newUploadId());
      }

      const epoch = life.current;
      const conversationId = await ensureConversation();
      if (!mounted.current || epoch !== life.current) return;
      if (!conversationId) {
        onConvErrorRef.current();
        for (const { key } of items) update({ type: "uploadFailed", key, kind: "network", retry: "upload" });
        return;
      }
      // المحادثة تُثبَّت فور معرفتها — فملفٌّ ينتظر التحقّق يعبر إعادة التركيب إليها
      for (const { key } of items) convOf.current.set(key, conversationId);
      await enqueue(items.map(({ key }) => key), conversationId);
    },
    [ensureConversation, enqueue, update],
  );

  const remove = useCallback(
    async (key: string) => {
      const a = stateRef.current.find((x) => x.key === key);
      if (!a || !canRemove(a)) return;
      if (a.fileId) {
        // الملف رُبط بالمحادثة: يُفكّ منها ولا يُحذف — كما كان الشريط يفعل
        const res = await fetch(`/api/files/${a.fileId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: null }),
        }).catch(() => null);
        if (!mounted.current) return;
        if (!res || !res.ok) {
          update({ type: "unlinkFailed", key, message: await readError(res, localeRef.current) });
          return;
        }
      }
      removed.current.add(key);
      queue.current = queue.current.filter((k) => k !== key);
      handles.current.get(key)?.abort();
      files.current.delete(key);
      convOf.current.delete(key);
      uploadIds.current.delete(key);
      update({ type: "remove", key });
    },
    [update],
  );

  const retry = useCallback(
    async (key: string) => {
      const a = stateRef.current.find((x) => x.key === key);
      if (!a || !a.retry) return;
      if (a.retry === "upload") {
        if (!files.current.has(key)) return;
        let conversationId = convOf.current.get(key) ?? null;
        if (!conversationId) {
          conversationId = await ensureConversation();
          if (!mounted.current) return;
          if (!conversationId) {
            onConvErrorRef.current();
            return;
          }
          convOf.current.set(key, conversationId);
        }
        rateWaits.current.delete(key);
        update({ type: "retryQueued", key });
        queue.current.push(key);
        pump();
        return;
      }
      if (!a.fileId) return;
      if (a.retry === "rag") {
        // إعادةٌ يدويّة: تبدأ محاولاتُ الاستئناف التلقائيّ من جديد
        nudges.current.delete(a.fileId);
        requestRag(a.fileId);
        return;
      }
      // "extract": استخراجٌ من جديد، ثم التجهيز إن صار النصّ جاهزًا
      const fileId = a.fileId;
      update({ type: "serverState", fileId, file: { id: fileId, status: "processing", mime_type: a.mime } });
      const res = await fetch(`/api/files/${fileId}/process`, { method: "POST" }).catch(() => null);
      if (!mounted.current) return;
      const j = res && res.ok ? ((await res.json().catch(() => null)) as { file?: ServerFileState } | null) : null;
      if (!j?.file) {
        update({ type: "serverState", fileId, file: { id: fileId, status: "failed", mime_type: a.mime } });
        return;
      }
      update({ type: "serverState", fileId, file: j.file });
      if (!isImageMime(j.file.mime_type) && j.file.status === "ready") requestRag(fileId);
    },
    [ensureConversation, pump, requestRag, update],
  );

  /** تبنّي مسوّدات المحادثة نفسها بعد إعادة التركيب: البطاقات، والرفع الجاري، والطابور */
  const adopt = useCallback(
    (owner: string, carry: Carry) => {
      pausedUntil.current = Math.max(pausedUntil.current, carry.pausedUntil);
      update({ type: "restore", items: carry.drafts.map((d) => d.attachment) });
      const pending: string[] = [];
      for (const d of carry.drafts) {
        const { key, phase, fileId } = d.attachment;
        if (d.file) files.current.set(key, d.file);
        if (d.clientUploadId) uploadIds.current.set(key, d.clientUploadId);
        convOf.current.set(key, owner);
        if (d.rateWaits > 0) rateWaits.current.set(key, d.rateWaits);
        if (d.handle) {
          handles.current.set(key, d.handle);
          if (d.sink) {
            d.sink.current = progressTo(key);
            sinks.current.set(key, d.sink);
          }
          active.current += 1;
          void settleUpload(key, d.handle).finally(() => {
            active.current -= 1;
            if (mounted.current) pump();
          });
        } else if (phase === "selected" && d.file) {
          pending.push(key);
        } else if (!fileId && (phase === "uploading" || phase === "processing")) {
          // رفعٌ بلا مقبضٍ لا تُعرف نتيجته: نسأل الخادم قبل أيّ إعادة — لا رفعٌ مكرَّرٌ صامت
          void reconcile(key, { ok: false, status: 0, error: "network" });
        } else if (fileId && (phase === "indexing" || phase === "processing")) {
          // مستندٌ حُفظ ونصُّه يُستخرج بعدُ: يُطلب تجهيزه حين يجهز، كما لو لم يُفكّ المكوّن
          if (phase === "processing" && !isImageMime(d.attachment.mime)) autoRag.current.add(fileId);
          void poll(fileId);
        }
      }
      if (pending.length > 0) void enqueue(pending, owner);
    },
    [enqueue, poll, progressTo, pump, reconcile, settleUpload, update],
  );

  const markSent = useCallback(() => update({ type: "markSent" }), [update]);

  useEffect(() => {
    mounted.current = true;
    life.current += 1;
    // مسوّدات محادثةٍ أخرى: غادرها صاحبها — تُلغى الآن ولا تُتبنّى هنا أبدًا
    for (const id of [...carried.keys()]) if (id !== conversationId) discardCarry(id);
    const carry = conversationId ? carried.get(conversationId) : undefined;
    if (conversationId && carry) {
      carried.delete(conversationId);
      clearTimeout(carry.timer);
      adopt(conversationId, carry);
    }
    // تجهيزٌ بدأ قبل إعادة التحميل: يُتابَع — ويُستأنف إن كان قد توقّف
    for (const a of stateRef.current) {
      if (a.scope === "context" && a.fileId && (a.serverStatus === "chunking" || a.serverStatus === "embedding")) {
        void poll(a.fileId);
      }
    }

    const inflight = handles.current;
    const fileMap = files.current;
    const convMap = convOf.current;
    const idMap = uploadIds.current;
    const sinkMap = sinks.current;
    const waitMap = rateWaits.current;
    const removedSet = removed.current;
    return () => {
      mounted.current = false;
      queue.current = [];
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = null;

      // المسوّدات تُسلَّم لمحادثتها لا تُرمى: إن رُكّب مكوّنُها من جديد تبنّاها
      const byConversation = new Map<string, CarriedDraft[]>();
      for (const a of stateRef.current) {
        if (a.scope !== "draft" || removedSet.has(a.key)) continue;
        const owner = convMap.get(a.key);
        if (!owner) continue;
        const handle = inflight.get(a.key) ?? null;
        if (handle) inflight.delete(a.key);
        const list = byConversation.get(owner) ?? [];
        list.push({
          attachment: a,
          file: fileMap.get(a.key) ?? null,
          handle,
          sink: sinkMap.get(a.key) ?? null,
          rateWaits: waitMap.get(a.key) ?? 0,
          clientUploadId: idMap.get(a.key) ?? null,
        });
        byConversation.set(owner, list);
      }
      for (const [owner, drafts] of byConversation) {
        discardCarry(owner);
        carried.set(owner, {
          drafts,
          pausedUntil: pausedUntil.current,
          timer: setTimeout(() => discardCarry(owner), CARRY_GRACE_MS),
        });
      }
      // ما لم يُسلَّم (بلا محادثةٍ معروفة) يُلغى كما كان
      for (const h of inflight.values()) h.abort();
      inflight.clear();
    };
  }, [adopt, conversationId, poll]);

  return {
    attachments,
    addFiles,
    remove,
    retry,
    markSent,
    sendBlocked: blocksSend(attachments),
  };
}
