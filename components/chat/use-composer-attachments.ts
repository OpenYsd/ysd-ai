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
 *   المكوّن ويُركَّب غيرُه **للمحادثة نفسها**. كان التفكيك يُلغي الرفع ويُفرغ
 *   الطابور، فتختفي ملفّاتٌ أُرفقت في تلك اللحظة بلا خطأٍ ولا أثر.
 *
 *   الآن تُسلَّم المسوّدات عند التفكيك — بملفّاتها ورفعها الجاري — مفتاحُها
 *   المحادثةُ التي اختيرت فيها. ولا يتبنّاها إلا مكوّنٌ يُركَّب **لتلك المحادثة**.
 *   وتركيبُ محادثةٍ أخرى (أو محادثةٍ جديدة) يُلغيها فورًا، وما لم يتبنَّه أحدٌ
 *   خلال مهلةٍ قصيرة يُلغى — فلا يظهر ملفُّ محادثةٍ في شريط أخرى، ولا يُرفع
 *   ملفٌّ إلى غير محادثته.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { uploadWithProgress, type UploadHandle } from "@/components/files/upload";
import {
  attachmentsReducer,
  blocksSend,
  canRemove,
  classifyUploadFailure,
  fromServerFile,
  isImageMime,
  localizeServerMessage,
  validateSelection,
  type AttachmentAction,
  type ComposerAttachment,
  type ServerFileState,
} from "@/lib/chat/composer-attachments";

const UPLOAD_CONCURRENCY = 2;
/** انتظاراتٌ تلقائيّة بعد 429 لكل ملف — ثم خطأٌ بزرّ إعادة: لا حلقةَ بلا نهاية */
const RATE_LIMIT_WAITS = 3;
const RATE_LIMIT_WAIT_MAX_S = 60;
const POLL_MS = 1500;
const POLL_MAX = 200;
const TERMINAL = new Set(["ready_for_rag", "rag_failed", "failed"]);
/** مهلة تبنّي مسوّدات محادثةٍ فُكّ مكوّنها — بعدها يُلغى ما لم يتبنَّه أحد */
const CARRY_GRACE_MS = 5000;

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

  /** الحالة المرجعيّة تتقدّم مع كل إجراء — التفكيك قد يقع قبل أن يُرسم آخرها */
  const update = useCallback((action: AttachmentAction) => {
    stateRef.current = attachmentsReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  /** متابعة حالة ملفٍّ على الخادم حتى حالةٍ نهائيّة — استطلاعٌ واحدٌ لكل ملف */
  const poll = useCallback(
    async (fileId: string) => {
      if (polling.current.has(fileId)) return;
      polling.current.add(fileId);
      try {
        for (let i = 0; i < POLL_MAX; i++) {
          await sleep(POLL_MS);
          if (!mounted.current) return;
          const current = stateRef.current.find((a) => a.fileId === fileId);
          // أُزيل، أو أعلن العميل فشلَه (رفض إدراج الوظيفة): لا يُطمس الفشل بحالةٍ قديمة
          if (!current || current.phase === "error") return;
          const res = await fetch(`/api/files/${fileId}`).catch(() => null);
          if (!res || !res.ok || !mounted.current) return;
          const j = (await res.json().catch(() => null)) as { file?: ServerFileState } | null;
          if (!j?.file) return;
          update({ type: "serverState", fileId, file: j.file });
          if (TERMINAL.has(j.file.status)) return;
        }
      } finally {
        polling.current.delete(fileId);
      }
    },
    [update],
  );

  /**
   * تجهيز مستندٍ للذكاء الاصطناعي. الطلب يُصرّف الوظيفة بنفسه وقد يطول، فلا
   * يُنتظر قبل الاستطلاع — كما كان. و409 («قيد التجهيز») ليس فشلًا.
   */
  const requestRag = useCallback(
    (fileId: string) => {
      update({ type: "ragRequested", fileId });
      void (async () => {
        const res = await fetch(`/api/files/${fileId}/rag`, { method: "POST" }).catch(() => null);
        if (!mounted.current) return;
        if (res && (res.ok || res.status === 409)) return;
        update({ type: "indexFailed", fileId, message: await readError(res, localeRef.current) });
      })();
      void poll(fileId);
    },
    [poll, update],
  );

  const progressTo = useCallback(
    (key: string) => (percent: number) => {
      if (mounted.current && !removed.current.has(key)) update({ type: "uploadProgress", key, percent });
    },
    [update],
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
        files.current.delete(key);
        rateWaits.current.delete(key);
        const startRag = !isImageMime(res.file.mime_type) && res.file.status === "ready";
        update({ type: "uploadDone", key, file: res.file, ragRequested: startRag });
        if (startRag) requestRag(res.file.id);
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
    [requestRag, update],
  );

  const runUpload = useCallback(
    async (key: string) => {
      const file = files.current.get(key);
      const conversationId = convOf.current.get(key);
      if (!file || !conversationId) return;
      update({ type: "uploadStart", key });
      const sink: ProgressSink = { current: progressTo(key) };
      const handle = uploadWithProgress({ file, conversationId, onProgress: (percent) => sink.current(percent) });
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
      for (const { key, file } of items) files.current.set(key, file);

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
        } else if (phase === "uploading" || phase === "processing") {
          // رفعٌ بلا مقبض لا تُعرف نتيجته: خطأٌ يُعاد يدويًّا، لا رفعٌ مكرَّرٌ صامت
          update({ type: "uploadFailed", key, kind: "network", retry: d.file ? "upload" : null });
        } else if (fileId && phase === "indexing") {
          void poll(fileId);
        }
      }
      if (pending.length > 0) void enqueue(pending, owner);
    },
    [enqueue, poll, progressTo, pump, settleUpload, update],
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
    // تجهيزٌ بدأ قبل إعادة التحميل: يُتابَع بدل أن تبقى نسبتُه جامدة
    for (const a of stateRef.current) {
      if (a.scope === "context" && a.fileId && (a.serverStatus === "chunking" || a.serverStatus === "embedding")) {
        void poll(a.fileId);
      }
    }

    const inflight = handles.current;
    const fileMap = files.current;
    const convMap = convOf.current;
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
