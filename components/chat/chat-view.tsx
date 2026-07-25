"use client";

/**
 * واجهة المحادثة الحقيقية:
 * بث SSE من /api/chat · حفظ واسترجاع من قاعدة البيانات ·
 * إيقاف التوليد (AbortController) · إعادة توليد · تعديل رسالة المستخدم ·
 * Markdown وكتل كود · اختيار النموذج.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { uploadWithProgress } from "@/components/files/upload";
import { useI18n } from "@/lib/i18n";
import {
  type ChatErrorCode,
  ERROR_MESSAGES,
  codeFromHttpStatus,
} from "@/lib/ai/error-codes";
import { LogoMark } from "@/components/logo";
import { MobileMenuButton } from "@/components/shell/app-shell";
import { Markdown } from "./markdown";

export interface ChatModel {
  id: string;
  nameAr: string;
  nameEn: string;
  /** اسم الموفر — يظهر في منتقي النموذج */
  provider?: string;
}

/** معرّف طلب فريد — يمنع ازدواج الحفظ عند تكرار الإرسال أو إعادة الاتصال */
function newClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface MsgSource {
  fileId: string;
  fileName: string;
  pageNumber: number | null;
  snippet: string;
  /** يظهر في وضع التطوير فقط */
  similarity?: number;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  /** حالة قصيرة أثناء الوضع المحمي («جارٍ التحقق…») — ليست جزءًا من الرد */
  status?: string;
  /** النموذج الفعلي الذي أجاب — يُعرض في وضع التطوير فقط */
  model?: string;
  /** مصادر RAG المستند إليها الرد */
  sources?: MsgSource[];
}

export interface Attachment {
  id: string;
  name: string;
  status: string;
  /**
   * لازم للتفريق: الصور تنتهي عند status="ready" ولا تدخل RAG (بلا OCR).
   * بدونه كانت الشارة تقول «تم استخراج النص» لصورة، والرسالة تَعِد بمرحلة RAG
   * لا تأتي أبدًا — لأن anyReady يشترط ready_for_rag الذي لا تبلغه الصورة.
   */
  mime?: string | null;
  ragTotal?: number | null;
  ragDone?: number | null;
  ragError?: string | null;
}

interface ChatViewProps {
  conversationId: string | null;
  initialMessages: Msg[];
  initialTitle?: string;
  models: ChatModel[];
  initialModelId: string | null;
  greetingName: string;
  /** مرفقات المحادثة الجاهزة — تُحمّل من الخادم لتبقى بعد التحديث */
  initialAttachments?: Attachment[];
  /** وضع التطوير: يعرض معرّف النموذج الفعلي تحت الرد */
  devMode?: boolean;
}

interface SSEEvent {
  type: "text" | "error" | "done" | "meta" | "sources" | "status";
  /** رمز تصنيف الخطأ (v0.6.6) */
  code?: string;
  text?: string;
  error?: string;
  model?: string;
  sources?: MsgSource[];
  userMessageId?: string | null;
  assistantMessageId?: string | null;
}

export function ChatView({
  conversationId,
  initialMessages,
  initialTitle,
  models,
  initialModelId,
  greetingName,
  initialAttachments,
  devMode,
}: ChatViewProps) {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** رمز آخر خطأ — يحدد الرسالة وهل تُعرض إعادة المحاولة */
  const [errorCode, setErrorCode] = useState<ChatErrorCode | null>(null);
  const [modelId, setModelId] = useState<string | null>(
    initialModelId ?? models[0]?.id ?? null,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>(
    initialAttachments ?? [],
  );
  const [attachProgress, setAttachProgress] = useState<number | null>(null);

  const convIdRef = useRef<string | null>(conversationId);
  const abortRef = useRef<AbortController | null>(null);
  /** قفل فوري ضد الإرسال المزدوج (النقر المتكرر / Enter السريع) */
  const sendLockRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const model = models.find((m) => m.id === modelId) ?? null;
  const modelName = model ? (locale === "ar" ? model.nameAr : model.nameEn) : null;
  const noProvider = models.length === 0;

  /**
   * v0.6.6 — حفظ المسودة: ما يكتبه المستخدم لا يضيع عند إعادة المصادقة أو
   * إعادة تحميل الصفحة. المفتاح لكل محادثة، ويُمسح فور الإرسال الناجح.
   */
  const draftKey = `ysd-draft:${conversationId ?? "new"}`;
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(draftKey);
      if (saved) setInput((cur) => (cur ? cur : saved));
    } catch {
      /* التخزين المحلي قد يكون محجوبًا */
    }
    // مرة واحدة لكل محادثة
  }, [draftKey]);

  useEffect(() => {
    try {
      if (input.trim()) window.localStorage.setItem(draftKey, input);
      else window.localStorage.removeItem(draftKey);
    } catch {
      /* التخزين المحلي قد يكون محجوبًا */
    }
  }, [input, draftKey]);

  /* تمرير تلقائي ذكي: يتوقف إذا رجع المستخدم للأعلى */
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  };

  /** يرسل الطلب إلى /api/chat ويقرأ بث SSE */
  const streamRequest = useCallback(
    async (
      body: Record<string, unknown>,
      tempUserId: string | null,
    ): Promise<void> => {
      setGenerating(true);
      setError(null);
      stickRef.current = true;

      const asstTempId = `tmp-a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: asstTempId, role: "assistant", content: "", streaming: true },
      ]);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => null)) as
            | { error?: string; code?: string }
            | null;
          // 401 من الوسيط يعني انتهاء الجلسة — يُميَّز عن أعطال الشبكة
          const code = (j?.code ?? codeFromHttpStatus(res.status)) as ChatErrorCode;
          setErrorCode(code);
          setError(ERROR_MESSAGES[code] ?? j?.error ?? t("sendError"));
          return; // الرسالة معروضة ومصنّفة — لا نرميها كخطأ عام
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";

          for (const ev of events) {
            const line = ev.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let data: SSEEvent;
            try {
              data = JSON.parse(line.slice(6)) as SSEEvent;
            } catch {
              continue;
            }

            if (data.type === "text" && data.text) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstTempId ? { ...m, content: m.content + data.text } : m,
                ),
              );
            } else if (data.type === "status" && data.text) {
              // حالة الوضع المحمي — تُعرض بدل نقاط الانتظار الفارغة
              setMessages((prev) =>
                prev.map((m) => (m.id === asstTempId ? { ...m, status: data.text } : m)),
              );
            } else if (data.type === "meta" && data.model) {
              setMessages((prev) =>
                prev.map((m) => (m.id === asstTempId ? { ...m, model: data.model } : m)),
              );
            } else if (data.type === "sources" && data.sources?.length) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstTempId ? { ...m, sources: data.sources } : m,
                ),
              );
            } else if (data.type === "error" && data.error) {
              // الرسالة المصنّفة تتقدّم على نص الخادم العام
              const code = (data.code ?? "unknown") as ChatErrorCode;
              setErrorCode(code);
              setError(ERROR_MESSAGES[code] ?? data.error);
            } else if (data.type === "done") {
              // استبدال المعرّفات المؤقتة بالحقيقية من قاعدة البيانات
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id === asstTempId)
                    return {
                      ...m,
                      id: data.assistantMessageId ?? m.id,
                      streaming: false,
                    };
                  if (tempUserId && m.id === tempUserId && data.userMessageId)
                    return { ...m, id: data.userMessageId };
                  return m;
                }),
              );
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          // فشل fetch/قراءة البثّ = انقطاع شبكة بين المتصفح والخادم
          setErrorCode("network_error");
          setError(ERROR_MESSAGES.network_error || (err as Error).message || t("sendError"));
        }
      } finally {
        abortRef.current = null;
        setGenerating(false);
        // تنظيف: لا رسالة تبقى "قيد البث"، واحذف الرد الفارغ إن فشل الطلب
        setMessages((prev) =>
          prev
            .map((m) => (m.streaming ? { ...m, streaming: false } : m))
            .filter((m) => !(m.role === "assistant" && m.content === "")),
        );
        router.refresh();
      }
    },
    [router, t],
  );

  /** إنشاء المحادثة عند الحاجة (أول رسالة أو أول مرفق) */
  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const existing = convIdRef.current;
    if (existing) return existing;
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error();
      const j = (await res.json()) as { conversation: { id: string } };
      convIdRef.current = j.conversation.id;
      // تحديث الرابط دون إعادة تحميل الصفحة
      window.history.replaceState(null, "", `/chat/${j.conversation.id}`);
      return j.conversation.id;
    } catch {
      return null;
    }
  }, []);

  /** متابعة تجهيز RAG بالتقدم الحقيقي (استطلاع حالة الملف) */
  const pollRagStatus = useCallback(async (fileId: string) => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(`/api/files/${fileId}`);
      if (!res.ok) return;
      const j = (await res.json()) as {
        file?: {
          status: string;
          rag_total_chunks?: number | null;
          rag_done_chunks?: number | null;
          rag_error?: string | null;
        };
      };
      const f = j.file;
      if (!f) return;
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === fileId
            ? {
                ...a,
                status: f.status,
                ragTotal: f.rag_total_chunks,
                ragDone: f.rag_done_chunks,
                ragError: f.rag_error,
              }
            : a,
        ),
      );
      // حالات نهائية فقط. "ready" **ليست** نهائية هنا: هي حالة المستند **قبل**
      // بدء التجهيز — وإدراجها كان يوقف الاستطلاع عند أول دورة (بعد 1.5ث) قبل
      // أن يبلغ الملف chunking، فتبقى الشارة عالقة على «تم استخراج النص»
      // ورسالة انتظار RAG ظاهرة إلى الأبد رغم اكتمال التجهيز في القاعدة.
      if (["ready_for_rag", "rag_failed", "failed"].includes(f.status)) return;
    }
  }, []);

  /**
   * إعادة تجهيز ملف فشل — آمنة ضد chunks المكررة:
   * المسار idempotent عبر rag_content_hash، والـpipeline يحذف chunks الملف
   * قبل أي إدراج (lib/rag/pipeline.ts)، والوظيفة محمية بفهرس فريد جزئي.
   */
  const retryRag = useCallback(
    async (fileId: string) => {
      setAttachments((prev) =>
        prev.map((a) => (a.id === fileId ? { ...a, status: "chunking", ragError: null } : a)),
      );
      const res = await fetch(`/api/files/${fileId}/rag`, { method: "POST" });
      if (!res.ok) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === fileId ? { ...a, status: "rag_failed" } : a)),
        );
        return;
      }
      void pollRagStatus(fileId);
    },
    [pollRagStatus],
  );

  /** إرفاق ملف: رفع + ربط بالمحادثة + تجهيز تلقائي للذكاء الاصطناعي (RAG) */
  const attachFile = useCallback(
    async (file: File) => {
      setError(null);
      const convId = await ensureConversation();
      if (!convId) {
        setError(t("sendError"));
        return;
      }
      setAttachProgress(0);
      const handle = uploadWithProgress({
        file,
        conversationId: convId,
        onProgress: setAttachProgress,
      });
      const res = await handle.done;
      setAttachProgress(null);
      if (res.ok && res.file) {
        const uploaded = res.file;
        // لا نستدعي router.refresh هنا — يُعيد بناء المكوّن ويمسح حالة المرفقات؛
        // المرفقات تبقى في حالة العميل وتُحمّل من الخادم عند التحديث/التنقل
        setAttachments((prev) => [
          ...prev,
          {
            id: uploaded.id,
            name: uploaded.original_name,
            status: uploaded.status,
            mime: uploaded.mime_type,
          },
        ]);
        // المستندات الجاهزة النص: ابدأ التجهيز للذكاء الاصطناعي تلقائيًا.
        // الصور مستثناة — تنتهي عند ready ولا تدخل RAG (بلا OCR).
        if (!uploaded.mime_type.startsWith("image/") && uploaded.status === "ready") {
          // لو فشل إدراج الوظيفة، أعلن الفشل بدل ترك الاستطلاع يدور بلا طائل
          void (async () => {
            const res = await fetch(`/api/files/${uploaded.id}/rag`, { method: "POST" }).catch(
              () => null,
            );
            if (!res || !res.ok) {
              setAttachments((prev) =>
                prev.map((a) => (a.id === uploaded.id ? { ...a, status: "rag_failed" } : a)),
              );
            }
          })();
          void pollRagStatus(uploaded.id);
        }
      } else if (res.error && res.error !== "aborted") {
        setError(res.error === "network" ? t("sendError") : res.error);
      }
    },
    [ensureConversation, pollRagStatus, t],
  );

  /** إزالة ملف من سياق المحادثة دون حذفه */
  const unlinkAttachment = useCallback(async (fileId: string) => {
    await fetch(`/api/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: null }),
    });
    setAttachments((prev) => prev.filter((a) => a.id !== fileId));
  }, []);

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || generating || !modelId) return;

      // v0.6.6 — منع الإرسال المزدوج:
      // `generating` حالة React لا تُضبط إلا داخل streamRequest، أي **بعد**
      // await ensureConversation. فالنقرة الثانية أثناء ذلك الانتظار كانت تمرّ
      // من الحارس فتُرسل الرسالة مرتين. القفل هنا مرجع يُضبط فورًا في نفس
      // النبضة، فلا نافذة سباق أصلًا.
      if (sendLockRef.current) return;
      sendLockRef.current = true;

      setInput("");
      setError(null);
      if (taRef.current) taRef.current.style.height = "auto";

      try {
        const convId = await ensureConversation();
        if (!convId) {
          setError(t("sendError"));
          setInput(text); // المسودة تعود للمستخدم بدل أن تضيع
          return;
        }

        const tempUserId = `tmp-u-${Date.now()}`;
        setMessages((prev) => [...prev, { id: tempUserId, role: "user", content: text }]);
        await streamRequest(
          {
            conversationId: convId,
            modelId,
            message: text,
            // معرّف فريد للطلب: الخادم يتجاهل تكراره فلا تُحفظ الرسالة مرتين
            // حتى لو تكرر الطلب من إعادة اتصال أو شبكة بطيئة.
            clientRequestId: newClientRequestId(),
          },
          tempUserId,
        );
      } finally {
        sendLockRef.current = false;
      }
    },
    [input, generating, modelId, streamRequest, ensureConversation, t],
  );

  const regenerate = useCallback(async () => {
    const convId = convIdRef.current;
    if (!convId || generating || !modelId) return;
    // أزل الردود الأخيرة محليًا (الخادم يحذفها ناعمًا)
    setMessages((prev) => {
      const arr = [...prev];
      while (arr.length && arr[arr.length - 1]?.role === "assistant") arr.pop();
      return arr;
    });
    await streamRequest({ conversationId: convId, modelId, regenerate: true }, null);
  }, [generating, modelId, streamRequest]);

  const saveEdit = useCallback(
    async (messageId: string) => {
      const convId = convIdRef.current;
      const text = editValue.trim();
      setEditingId(null);
      if (!convId || !text || generating || !modelId) return;
      // حدّث محليًا واحذف ما بعدها (الخادم يفعل المثل)
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const head = prev.slice(0, idx + 1).map((m) =>
          m.id === messageId ? { ...m, content: text } : m,
        );
        return head;
      });
      await streamRequest(
        { conversationId: convId, modelId, message: text, editMessageId: messageId },
        null,
      );
    },
    [editValue, generating, modelId, streamRequest],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* بيئات قديمة */
    }
  }, []);

  const hour = new Date().getHours();
  const greeting = hour >= 5 && hour < 17 ? t("greetingMorning") : t("greetingEvening");
  const suggestions = t("suggestions");
  const isEmpty = messages.length === 0;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <>
      {/* ===== الشريط العلوي ===== */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-line/50">
        <MobileMenuButton />
        <div className="relative">
          <button
            onClick={() => setModelOpen((v) => !v)}
            disabled={noProvider}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] text-ink bg-raised border border-line hover:border-primary/40 transition-colors disabled:opacity-50"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary-glow" />
            {modelName ?? t("model")}
            <ChevronDown size={12} className="text-ink-faint" />
          </button>
          {modelOpen && (
            <div className="absolute top-full mt-1.5 start-0 w-60 rounded-xl bg-surface border border-line shadow-2xl p-1.5 z-20 rise">
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setModelId(m.id);
                    setModelOpen(false);
                  }}
                  className="w-full text-start rounded-lg px-3 py-2.5 hover:bg-raised transition-colors"
                >
                  <div className="text-[13px] text-ink-strong flex items-center justify-between">
                    {locale === "ar" ? m.nameAr : m.nameEn}
                    {m.id === modelId && <Check size={13} className="text-primary-glow" />}
                  </div>
                  {m.provider && (
                    <div className="text-[10.5px] text-ink-faint mt-0.5">{m.provider}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1" />
        {initialTitle && (
          <div className="hidden sm:block text-[12.5px] text-ink-faint truncate max-w-[240px]">
            {initialTitle}
          </div>
        )}
      </header>

      {noProvider && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-300">
          لم يُضبط مفتاح أي موفر ذكاء اصطناعي بعد. أضف <code dir="ltr">ANTHROPIC_API_KEY</code>{" "}
          إلى ملف <code dir="ltr">.env</code> ثم أعد تشغيل الخادم.
        </div>
      )}

      {isEmpty ? (
        /* ===== شاشة البداية ===== */
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-5 py-10">
          <div className="w-full max-w-[640px] rise">
            <div className="text-center mb-9">
              <div className="inline-flex mb-5">
                <LogoMark size={56} />
              </div>
              <h1 className="font-display text-[26px] font-bold text-ink-strong mb-2">
                {greeting}
                {greetingName ? ` يا ${greetingName}` : ""}
              </h1>
              <p className="text-[14.5px] text-ink-dim">{t("welcomeSub")}</p>
            </div>

            <AttachmentBar
              attachments={attachments}
              progress={attachProgress}
              onUnlink={(id) => void unlinkAttachment(id)}
              onRetry={(id) => void retryRag(id)}
            />
            <Composer
              input={input}
              setInput={setInput}
              onSend={() => void send()}
              onStop={stop}
              onAttach={(f) => void attachFile(f)}
              attachBusy={attachProgress !== null}
              attachLabel={t("attachFile")}
              generating={generating}
              disabled={noProvider}
              taRef={taRef}
              autoGrow={autoGrow}
              placeholder={t("composerPlaceholder")}
              sendLabel={t("send")}
              stopLabel={t("stop")}
              centered
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-6">
              {suggestions.map((s) => (
                <button
                  key={s.title}
                  onClick={() => void send(s.title)}
                  disabled={noProvider}
                  className="text-start rounded-xl border border-line/70 bg-surface/60 px-4 py-3.5 hover:border-primary/40 hover:bg-raised transition-all disabled:opacity-50"
                >
                  <div className="text-[13.5px] font-medium text-ink">{s.title}</div>
                  <div className="text-[11.5px] text-ink-faint mt-0.5">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* ===== شاشة المحادثة ===== */
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto px-4 md:px-6 py-6"
          >
            <div className="max-w-[760px] mx-auto space-y-6">
              {messages.map((m) => (
                <div key={m.id} className="rise">
                  {m.role === "user" ? (
                    editingId === m.id ? (
                      <div className="rounded-2xl border border-primary/50 bg-raised p-3">
                        <textarea
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={3}
                          className="w-full bg-transparent resize-none text-[14px] leading-relaxed text-ink-strong focus:outline-none"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                          <button
                            onClick={() => setEditingId(null)}
                            className="text-[12px] px-3 py-1.5 rounded-lg text-ink-dim hover:bg-surface transition-colors"
                          >
                            {t("cancel")}
                          </button>
                          <button
                            onClick={() => void saveEdit(m.id)}
                            className="text-[12px] px-3 py-1.5 rounded-lg text-white transition-all hover:brightness-110"
                            style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
                          >
                            {t("save")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="group flex justify-start items-start gap-2">
                        <div
                          className="max-w-[85%] rounded-2xl rounded-ss-md px-4 py-3 text-[14px] leading-[1.8] text-white whitespace-pre-wrap"
                          style={{ background: "linear-gradient(135deg,#41307E,#2E2160)" }}
                        >
                          {m.content}
                        </div>
                        {!generating && !m.id.startsWith("tmp-") && (
                          <button
                            onClick={() => {
                              setEditingId(m.id);
                              setEditValue(m.content);
                            }}
                            title={t("editMessage")}
                            className="opacity-0 group-hover:opacity-100 p-1.5 mt-1 rounded-lg text-ink-faint hover:text-ink hover:bg-raised transition-all"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                    <div className="flex gap-3">
                      <div className="mt-0.5 shrink-0">
                        <LogoMark size={28} />
                      </div>
                      <div className="min-w-0 flex-1">
                        {m.content ? (
                          <Markdown text={m.content} />
                        ) : (
                          <div className="flex items-center gap-2 py-2">
                            <div className="flex gap-1.5">
                              {[0, 1, 2].map((i) => (
                                <span
                                  key={i}
                                  className="w-1.5 h-1.5 rounded-full bg-primary-glow"
                                  style={{ animation: `pulse-dot 1.1s ${i * 0.18}s infinite` }}
                                />
                              ))}
                            </div>
                            {m.status && (
                              <span className="text-xs text-ink-faint">{m.status}</span>
                            )}
                          </div>
                        )}
                        {!m.streaming && m.sources && m.sources.length > 0 && (
                          <SourcesList sources={m.sources} devMode={devMode} />
                        )}
                        {devMode && m.model && !m.streaming && (
                          <div className="mt-1.5 text-[10px] text-ink-faint" dir="ltr">
                            {m.model}
                          </div>
                        )}
                        {!m.streaming && m.content && (
                          <div className="flex gap-1 mt-2">
                            <MsgAction
                              icon={<Copy size={12} />}
                              label={t("copy")}
                              onClick={() => void copyText(m.content)}
                            />
                            {m.id === lastAssistantId && (
                              <MsgAction
                                icon={<RefreshCw size={12} />}
                                label={t("regenerate")}
                                onClick={() => void regenerate()}
                                disabled={generating}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {error && (
                <div
                  className="rise rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300 flex items-center justify-between gap-3"
                  data-error-code={errorCode ?? "unknown"}
                >
                  <span>{error}</span>
                  {errorCode === "auth_expired" ? (
                    // إعادة التوليد بلا فائدة بعد انتهاء الجلسة — الطريق هو الدخول
                    <a
                      href="/login?reason=session_expired"
                      className="shrink-0 text-[12px] px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors"
                    >
                      {t("login")}
                    </a>
                  ) : (
                    // إعادة التوليد لا تُعيد إرسال رسالة المستخدم — لا تكرار
                    <button
                      onClick={() => void regenerate()}
                      className="shrink-0 text-[12px] px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors"
                    >
                      {t("retry")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="px-4 md:px-6 pb-4 pt-1">
            <div className="max-w-[760px] mx-auto">
              <AttachmentBar
                attachments={attachments}
                progress={attachProgress}
                onUnlink={(id) => void unlinkAttachment(id)}
                onRetry={(id) => void retryRag(id)}
              />
              <Composer
                input={input}
                setInput={setInput}
                onSend={() => void send()}
                onStop={stop}
                onAttach={(f) => void attachFile(f)}
                attachBusy={attachProgress !== null}
                attachLabel={t("attachFile")}
                generating={generating}
                disabled={noProvider}
                taRef={taRef}
                autoGrow={autoGrow}
                placeholder={t("composerPlaceholder")}
                sendLabel={t("send")}
                stopLabel={t("stop")}
              />
              <div className="text-center text-[10.5px] text-ink-faint mt-2">
                {t("disclaimer")}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function MsgAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-ink-faint hover:text-ink hover:bg-raised transition-colors disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  );
}

/* ---------- المرفقات ---------- */
function AttachmentBar({
  attachments,
  progress,
  onUnlink,
  onRetry,
}: {
  attachments: Attachment[];
  progress: number | null;
  onUnlink: (fileId: string) => void;
  onRetry?: (fileId: string) => void;
}) {
  const { t } = useI18n();
  if (attachments.length === 0 && progress === null) return null;

  const isImage = (a: Attachment) => Boolean(a.mime?.startsWith("image/"));

  const badge = (a: Attachment) => {
    // ① جاهز للسؤال
    if (a.status === "ready_for_rag")
      return { label: t("ragReady"), cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
    // ④ فشل — مع زر إعادة المحاولة أدناه
    if (a.status === "rag_failed" || a.status === "failed")
      return { label: t("ragFailed"), cls: "bg-red-500/15 text-red-400 border-red-500/30" };
    // ② تجهيز الذكاء الاصطناعي (مع النسبة)
    if (a.status === "chunking" || a.status === "embedding") {
      const pct =
        a.ragTotal && a.ragTotal > 0
          ? Math.round(((a.ragDone ?? 0) / a.ragTotal) * 100)
          : null;
      return {
        label: `${t("ragPreparing")}${pct !== null ? ` ${pct}%` : "…"}`,
        cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        spinning: true,
      };
    }
    // ③ استخراج النص جارٍ
    if (a.status === "processing" || a.status === "extracting")
      return { label: t("statusProcessing"), cls: "bg-amber-500/15 text-amber-400 border-amber-500/30", spinning: true };
    if (a.status === "ready") {
      // الصورة تنتهي هنا — لا نص ولا RAG. قول «تم استخراج النص» لها كذب صريح.
      return isImage(a)
        ? { label: t("imageNoAiContext"), cls: "bg-raised text-ink-faint border-line" }
        : { label: t("textExtracted"), cls: "bg-raised text-ink-dim border-line" };
    }
    return { label: t("statusUploaded"), cls: "bg-raised text-ink-faint border-line" };
  };

  const anyReady = attachments.some((a) => a.status === "ready_for_rag");
  // الصور لا تبلغ ready_for_rag أبدًا (بلا OCR)، فوعدها بمرحلة RAG وعدٌ لا يُنجَز.
  const allImages = attachments.length > 0 && attachments.every(isImage);
  const anyPending = attachments.some(
    (a) => !isImage(a) && !["ready_for_rag", "rag_failed", "failed"].includes(a.status),
  );

  return (
    <div className="mb-2 space-y-1.5">
      {attachments.map((a) => {
        const b = badge(a);
        return (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface/70 px-3 py-2"
          >
            {b.spinning ? (
              <Loader2 size={13} className="animate-spin text-amber-400 shrink-0" />
            ) : isImage(a) ? (
              <ImageIcon size={13} className="text-ink-faint shrink-0" />
            ) : (
              <FileText size={13} className="text-primary-glow shrink-0" />
            )}
            <span className="text-[12px] text-ink truncate flex-1" dir="ltr">
              {a.name}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md border shrink-0 ${b.cls}`}>
              {b.label}
            </span>
            {/* ④ إعادة المحاولة عند الفشل — آمنة: المسار idempotent عبر rag_content_hash
                والـpipeline يحذف chunks الملف قبل الإدراج، فلا تكرار. الصور مستثناة. */}
            {!isImage(a) && (a.status === "rag_failed" || a.status === "failed") && onRetry && (
              <button
                onClick={() => onRetry(a.id)}
                title={a.ragError ?? t("ragRetry")}
                className="p-1 rounded text-ink-faint hover:text-primary-glow shrink-0 transition-colors"
              >
                <RotateCw size={12} />
              </button>
            )}
            <button
              onClick={() => onUnlink(a.id)}
              title={t("removeFromContext")}
              className="p-1 rounded text-ink-faint hover:text-red-400 shrink-0 transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {progress !== null && (
        <div className="flex items-center gap-2 rounded-xl border border-primary/40 bg-surface/70 px-3 py-2">
          <Loader2 size={13} className="animate-spin text-primary-glow shrink-0" />
          <div className="flex-1 h-1.5 rounded-full bg-raised overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress}%`,
                background: "linear-gradient(90deg,#6C4BF0,#8B6CF6)",
              }}
            />
          </div>
          <span className="text-[10.5px] text-ink-faint" dir="ltr">
            {progress}%
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <p className="text-[10.5px] text-ink-faint leading-relaxed px-1">
          {allImages
            ? t("imageAttachmentNotice")
            : anyReady && !anyPending
              ? t("ragAttachmentReady")
              : t("attachmentNotice")}
        </p>
      )}
    </div>
  );
}

/* ---------- مصادر الرد ---------- */
function SourcesList({ sources, devMode }: { sources: MsgSource[]; devMode?: boolean }) {
  const { t } = useI18n();

  async function openSource(fileId: string) {
    const res = await fetch(`/api/files/${fileId}/download`);
    if (!res.ok) return;
    const j = (await res.json()) as { url?: string };
    if (j.url) window.open(j.url, "_blank", "noopener");
  }

  return (
    <div className="mt-3 pt-2.5 border-t border-line/40">
      <div className="text-[11px] font-medium text-ink-faint mb-1.5">{t("sources")}</div>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s, i) => (
          <button
            key={`${s.fileId}-${i}`}
            onClick={() => void openSource(s.fileId)}
            title={s.snippet}
            className="group flex items-center gap-1.5 max-w-full rounded-lg border border-line bg-raised/70 px-2.5 py-1.5 text-start hover:border-primary/40 transition-colors"
          >
            <FileText size={11} className="text-primary-glow shrink-0" />
            <span className="text-[11.5px] text-ink truncate" dir="ltr">
              {s.fileName}
            </span>
            {s.pageNumber != null && (
              <span className="text-[10px] text-ink-faint shrink-0">
                {t("page")} {s.pageNumber}
              </span>
            )}
            {devMode && s.similarity !== undefined && (
              <span className="text-[9.5px] text-ink-faint shrink-0" dir="ltr">
                {s.similarity.toFixed(2)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- شريط الكتابة ---------- */
function Composer({
  input,
  setInput,
  onSend,
  onStop,
  onAttach,
  attachBusy,
  attachLabel,
  generating,
  disabled,
  taRef,
  autoGrow,
  placeholder,
  sendLabel,
  stopLabel,
  centered,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAttach: (file: File) => void;
  attachBusy: boolean;
  attachLabel: string;
  generating: boolean;
  disabled?: boolean;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  autoGrow: () => void;
  placeholder: string;
  sendLabel: string;
  stopLabel: string;
  centered?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`rounded-2xl border bg-surface/90 backdrop-blur transition-all ${
        centered
          ? "border-primary/40 shadow-[0_0_50px_rgba(108,75,240,.12)]"
          : "border-line focus-within:border-primary/50"
      }`}
    >
      <textarea
        ref={taRef}
        value={input}
        rows={1}
        disabled={disabled}
        onChange={(e) => {
          setInput(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={placeholder}
        className="w-full bg-transparent resize-none px-4 pt-3.5 pb-1 text-[14px] leading-relaxed placeholder-ink-faint text-ink-strong focus:outline-none disabled:opacity-50"
        style={{ maxHeight: 180 }}
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={disabled || attachBusy}
          title={attachLabel}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-faint hover:text-ink hover:bg-raised transition-colors disabled:opacity-40"
        >
          {attachBusy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Paperclip size={14} />
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAttach(f);
            e.target.value = "";
          }}
        />
        <div className="flex-1" />
        {generating ? (
          <button
            onClick={onStop}
            className="h-9 px-4 rounded-xl text-[13px] font-medium text-ink-strong bg-raised border border-line hover:border-primary/40 transition-colors flex items-center gap-2"
          >
            <Square size={11} fill="currentColor" />
            {stopLabel}
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!input.trim() || disabled}
            className="h-9 px-4 rounded-xl text-[13px] font-medium text-white transition-all disabled:opacity-35 hover:brightness-110 flex items-center gap-1.5"
            style={{ background: "linear-gradient(135deg,#6C4BF0,#4E2ED4)" }}
          >
            {sendLabel}
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
