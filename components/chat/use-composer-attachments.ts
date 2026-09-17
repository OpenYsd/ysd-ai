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
 *   الخادم يسمح بعشر عمليّات رفعٍ في الدقيقة. عشرون ملفًّا دفعةً واحدة تعني عشرة
 *   رفوضٍ مؤكّدة؛ والطابور يُبقي الضغط معقولًا، و429 خطأٌ قابلٌ للإعادة لا نهاية.
 *
 * ★ والمحادثة تُثبَّت لكل ملفٍّ عند اختياره
 *
 *   كلُّ رفعٍ يحمل معرّف المحادثة التي اختير فيها، والخادم يتحقّق من ملكيّتها.
 *   والانتقال إلى محادثةٍ أخرى يُعيد تركيب المكوّن (`key={id}`) فيُلغى الجاري —
 *   فلا يظهر ملفُّ محادثةٍ في شريط أخرى.
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
  type ComposerAttachment,
  type ServerFileState,
} from "@/lib/chat/composer-attachments";

const UPLOAD_CONCURRENCY = 2;
const POLL_MS = 1500;
const POLL_MAX = 200;
const TERMINAL = new Set(["ready_for_rag", "rag_failed", "failed"]);

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
  initial,
  ensureConversation,
  locale,
  onConversationError,
}: {
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
  const seq = useRef(0);
  const files = useRef(new Map<string, File>());
  const convOf = useRef(new Map<string, string>());
  const handles = useRef(new Map<string, UploadHandle>());
  const removed = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const polling = useRef(new Set<string>());
  const limitsPromise = useRef<Promise<number | null> | null>(null);

  /** متابعة حالة ملفٍّ على الخادم حتى حالةٍ نهائيّة — استطلاعٌ واحدٌ لكل ملف */
  const poll = useCallback(async (fileId: string) => {
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
        dispatch({ type: "serverState", fileId, file: j.file });
        if (TERMINAL.has(j.file.status)) return;
      }
    } finally {
      polling.current.delete(fileId);
    }
  }, []);

  /**
   * تجهيز مستندٍ للذكاء الاصطناعي. الطلب يُصرّف الوظيفة بنفسه وقد يطول، فلا
   * يُنتظر قبل الاستطلاع — كما كان. و409 («قيد التجهيز») ليس فشلًا.
   */
  const requestRag = useCallback(
    (fileId: string) => {
      dispatch({ type: "ragRequested", fileId });
      void (async () => {
        const res = await fetch(`/api/files/${fileId}/rag`, { method: "POST" }).catch(() => null);
        if (!mounted.current) return;
        if (res && (res.ok || res.status === 409)) return;
        dispatch({ type: "indexFailed", fileId, message: await readError(res, localeRef.current) });
      })();
      void poll(fileId);
    },
    [poll],
  );

  const runUpload = useCallback(
    async (key: string) => {
      const file = files.current.get(key);
      const conversationId = convOf.current.get(key);
      if (!file || !conversationId) return;
      dispatch({ type: "uploadStart", key });
      const handle = uploadWithProgress({
        file,
        conversationId,
        onProgress: (percent) => {
          if (mounted.current && !removed.current.has(key)) dispatch({ type: "uploadProgress", key, percent });
        },
      });
      handles.current.set(key, handle);
      const res = await handle.done;
      handles.current.delete(key);
      if (!mounted.current || removed.current.has(key)) return;

      if (res.ok && res.file) {
        files.current.delete(key);
        const startRag = !isImageMime(res.file.mime_type) && res.file.status === "ready";
        dispatch({ type: "uploadDone", key, file: res.file, ragRequested: startRag });
        if (startRag) requestRag(res.file.id);
        return;
      }
      const failure = classifyUploadFailure(res.status, res.error);
      dispatch({
        type: "uploadFailed",
        key,
        kind: failure.kind,
        retry: failure.retry,
        message: res.error && res.error !== "network" && res.error !== "aborted"
          ? localizeServerMessage(res.error, localeRef.current)
          : null,
      });
    },
    [requestRag],
  );

  const pump = useCallback(() => {
    while (active.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const key = queue.current.shift() as string;
      if (removed.current.has(key)) continue;
      active.current += 1;
      void runUpload(key).finally(() => {
        active.current -= 1;
        if (mounted.current) pump();
      });
    }
  }, [runUpload]);

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

  const addFiles = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      const items = list.map((file) => ({ key: `local-${Date.now().toString(36)}-${seq.current++}`, file }));
      dispatch({
        type: "add",
        items: items.map(({ key, file }) => ({ key, name: file.name, size: file.size, mime: file.type })),
      });
      for (const { key, file } of items) files.current.set(key, file);

      const conversationId = await ensureConversation();
      if (!mounted.current) return;
      if (!conversationId) {
        onConvErrorRef.current();
        for (const { key } of items) dispatch({ type: "uploadFailed", key, kind: "network", retry: "upload" });
        return;
      }
      const maxFileMb = await loadLimit(conversationId);
      if (!mounted.current) return;

      for (const { key, file } of items) {
        if (removed.current.has(key)) continue;
        const invalid = validateSelection(file, maxFileMb);
        if (invalid) {
          files.current.delete(key);
          dispatch({
            type: "uploadFailed",
            key,
            kind: invalid.kind,
            retry: null,
            message: invalid.limitMb ? `${invalid.limitMb} MB` : null,
          });
          continue;
        }
        convOf.current.set(key, conversationId);
        queue.current.push(key);
      }
      pump();
    },
    [ensureConversation, loadLimit, pump],
  );

  const remove = useCallback(async (key: string) => {
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
        dispatch({ type: "unlinkFailed", key, message: await readError(res, localeRef.current) });
        return;
      }
    }
    removed.current.add(key);
    queue.current = queue.current.filter((k) => k !== key);
    handles.current.get(key)?.abort();
    files.current.delete(key);
    convOf.current.delete(key);
    dispatch({ type: "remove", key });
  }, []);

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
        dispatch({ type: "retryQueued", key });
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
      dispatch({ type: "serverState", fileId, file: { id: fileId, status: "processing", mime_type: a.mime } });
      const res = await fetch(`/api/files/${fileId}/process`, { method: "POST" }).catch(() => null);
      if (!mounted.current) return;
      const j = res && res.ok ? ((await res.json().catch(() => null)) as { file?: ServerFileState } | null) : null;
      if (!j?.file) {
        dispatch({ type: "serverState", fileId, file: { id: fileId, status: "failed", mime_type: a.mime } });
        return;
      }
      dispatch({ type: "serverState", fileId, file: j.file });
      if (!isImageMime(j.file.mime_type) && j.file.status === "ready") requestRag(fileId);
    },
    [ensureConversation, pump, requestRag],
  );

  const markSent = useCallback(() => dispatch({ type: "markSent" }), []);

  useEffect(() => {
    mounted.current = true;
    // تجهيزٌ بدأ قبل إعادة التحميل: يُتابَع بدل أن تبقى نسبتُه جامدة
    for (const a of stateRef.current) {
      if (a.fileId && (a.serverStatus === "chunking" || a.serverStatus === "embedding")) void poll(a.fileId);
    }
    const inflight = handles.current;
    return () => {
      // مغادرة المحادثة تُلغي ما لم يكتمل: لا رفعَ يُربط بمحادثةٍ لم يعد صاحبها فيها
      mounted.current = false;
      queue.current = [];
      for (const h of inflight.values()) h.abort();
      inflight.clear();
    };
  }, [poll]);

  return {
    attachments,
    addFiles,
    remove,
    retry,
    markSent,
    sendBlocked: blocksSend(attachments),
  };
}
