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
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  Square,
} from "lucide-react";
import { uploadWithProgress } from "@/components/files/upload";
import { useI18n } from "@/lib/i18n";
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

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  /** النموذج الفعلي الذي أجاب — يُعرض في وضع التطوير فقط */
  model?: string;
}

interface ChatViewProps {
  conversationId: string | null;
  initialMessages: Msg[];
  initialTitle?: string;
  models: ChatModel[];
  initialModelId: string | null;
  greetingName: string;
  /** وضع التطوير: يعرض معرّف النموذج الفعلي تحت الرد */
  devMode?: boolean;
}

interface SSEEvent {
  type: "text" | "error" | "done" | "meta";
  text?: string;
  error?: string;
  model?: string;
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
  devMode,
}: ChatViewProps) {
  const { t, locale } = useI18n();
  const router = useRouter();

  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(
    initialModelId ?? models[0]?.id ?? null,
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [attachments, setAttachments] = useState<
    { id: string; name: string; status: string }[]
  >([]);
  const [attachProgress, setAttachProgress] = useState<number | null>(null);

  const convIdRef = useRef<string | null>(conversationId);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const model = models.find((m) => m.id === modelId) ?? null;
  const modelName = model ? (locale === "ar" ? model.nameAr : model.nameEn) : null;
  const noProvider = models.length === 0;

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
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "request failed");
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
            } else if (data.type === "meta" && data.model) {
              setMessages((prev) =>
                prev.map((m) => (m.id === asstTempId ? { ...m, model: data.model } : m)),
              );
            } else if (data.type === "error" && data.error) {
              setError(data.error);
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
          setError((err as Error).message || t("sendError"));
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

  /** إرفاق ملف: رفع + ربط بالمحادثة فقط — لا يدخل سياق النموذج قبل RAG */
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
        setAttachments((prev) => [
          ...prev,
          { id: res.file!.id, name: res.file!.original_name, status: res.file!.status },
        ]);
        router.refresh();
      } else if (res.error && res.error !== "aborted") {
        setError(res.error === "network" ? t("sendError") : res.error);
      }
    },
    [ensureConversation, router, t],
  );

  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || generating || !modelId) return;
      setInput("");
      setError(null);
      if (taRef.current) taRef.current.style.height = "auto";

      const convId = await ensureConversation();
      if (!convId) {
        setError(t("sendError"));
        setInput(text);
        return;
      }

      const tempUserId = `tmp-u-${Date.now()}`;
      setMessages((prev) => [...prev, { id: tempUserId, role: "user", content: text }]);
      await streamRequest(
        { conversationId: convId, modelId, message: text },
        tempUserId,
      );
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
              notice={t("attachmentNotice")}
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
                          <div className="flex gap-1.5 py-2">
                            {[0, 1, 2].map((i) => (
                              <span
                                key={i}
                                className="w-1.5 h-1.5 rounded-full bg-primary-glow"
                                style={{ animation: `pulse-dot 1.1s ${i * 0.18}s infinite` }}
                              />
                            ))}
                          </div>
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
                <div className="rise rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-300 flex items-center justify-between gap-3">
                  <span>{error}</span>
                  <button
                    onClick={() => void regenerate()}
                    className="shrink-0 text-[12px] px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors"
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="px-4 md:px-6 pb-4 pt-1">
            <div className="max-w-[760px] mx-auto">
              <AttachmentBar
                attachments={attachments}
                progress={attachProgress}
                notice={t("attachmentNotice")}
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
  notice,
}: {
  attachments: { id: string; name: string; status: string }[];
  progress: number | null;
  notice: string;
}) {
  if (attachments.length === 0 && progress === null) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface/70 px-3 py-2"
        >
          <FileText size={13} className="text-primary-glow shrink-0" />
          <span className="text-[12px] text-ink truncate flex-1" dir="ltr">
            {a.name}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-md border shrink-0 ${
              a.status === "ready"
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : a.status === "failed"
                  ? "bg-red-500/15 text-red-400 border-red-500/30"
                  : "bg-raised text-ink-faint border-line"
            }`}
          >
            {a.status}
          </span>
        </div>
      ))}
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
        <p className="text-[10.5px] text-ink-faint leading-relaxed px-1">{notice}</p>
      )}
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
