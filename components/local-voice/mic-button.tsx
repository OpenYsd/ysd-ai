"use client";

/**
 * زرُّ الميكروفون — التقاطٌ وتفريغٌ محلّيّان.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يفعله ولا يفعله
 *
 *  يُسلّم النصَّ المفرَّغ إلى `onTranscript` وحسب. ولا يعرف شيئًا عن نيّة
 *  الصورة ولا عن المحادثة: النصُّ يمضي في مسارِ الإرسال القائم، فيمرّ على
 *  `detectImageIntent` الموجود كما يمرّ عليه ما يُكتب باليد.
 *
 *  ★ ولا موجِّهَ نيّةٍ ثانٍ — لا هنا ولا في أيّ ملفٍّ من هذه المرحلة.
 *
 *  ★ ويفشل مغلقًا
 *
 *  إن غاب المحرّكُ أو الرمزُ أو الميكروفون، لا يظهر الزرُّ أو يُعطَّل ويُعلَن
 *  السبب. ولا سقوطَ إلى تفريغٍ سحابيّ — وتفريغُ المتصفّح نفسُه يرسل الصوتَ
 *  إلى خوادم المزوّد، فهو ممنوعٌ هنا كالسحابة سواءً بسواء.
 * ══════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ENGINE_TOKEN_KEY,
  MAX_RECORDING_MS,
  isLocalVoiceEnabled,
} from "@/lib/local-voice/flag";
import {
  cancelVoice,
  fetchVoiceAudio,
  fetchVoiceCapabilities,
  messageForVoiceError,
  pickSpeakLanguage,
  probeVoiceEngine,
  synthesizeLocally,
  transcribeLocally,
} from "@/lib/local-voice/client";

export type MicState = "idle" | "listening" | "transcribing" | "sending" | "speaking" | "error";

interface Props {
  /** يُستدعى بالنصّ المفرَّغ — ولا شيء غيره */
  onTranscript: (text: string) => void;
  /** نصُّ آخر ردٍّ من YSD، ليُنطق محليًّا حين يصل */
  speakText?: string | null;
  /** أالمحادثةُ تُولِّد الآن؟ فيُعطَّل التسجيل */
  busy?: boolean;
}

/** الصيغةُ المفضّلة — وقد قِيس دعمُها في المتصفّحات المستهدفة */
function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export function MicButton({ onTranscript, speakText, busy }: Props) {
  const enabled = isLocalVoiceEnabled();

  const [ready, setReady] = useState<boolean | null>(null);
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [canReplay, setCanReplay] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const cancelledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const spokenRef = useRef<string | null>(null);

  const token = useCallback((): string | null => {
    try {
      return window.localStorage.getItem(ENGINE_TOKEN_KEY);
    } catch {
      return null; // تخزينٌ محجوب — تُعامل كغياب رمز
    }
  }, []);

  /**
   * ★ الفحصُ لا يجري إلا والرايةُ مشتعلة.
   *
   * فبإطفائها لا يُلمس المحرّكُ ولا تُطلب الحلقةُ المحلّية أصلًا — وهو ما
   * يجعل الإطفاءَ إرجاعًا تامًّا لا وضعًا ثالثًا.
   */
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      const up = await probeVoiceEngine();
      if (!alive) return;
      if (!up) { setReady(false); return; }
      const t = token();
      if (!t) { setReady(false); return; }
      const caps = await fetchVoiceCapabilities(t);
      if (!alive) return;
      setReady(caps.status === "ready" && caps.sttAvailable);
    })();
    return () => { alive = false; };
  }, [enabled, token]);

  /** تنظيفٌ عند التفكيك — لا مسجّلٌ عالق ولا عنوانُ كائنٍ مُسرَّب */
  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    try { recorderRef.current?.stop(); } catch { /* مفكَّكٌ سلفًا */ }
    if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
  }, []);

  const speak = useCallback(async (text: string) => {
    const t = token();
    if (!t || muted || !text.trim()) return;
    setState("speaking");
    const out = await synthesizeLocally(t, text, pickSpeakLanguage(text));
    if (!out.ok || !out.id) {
      setState("idle");
      setError(messageForVoiceError(out.code));
      return;
    }
    const blob = await fetchVoiceAudio(t, out.id);
    if (!blob) { setState("idle"); return; }
    if (lastUrlRef.current) URL.revokeObjectURL(lastUrlRef.current);
    const url = URL.createObjectURL(blob);
    lastUrlRef.current = url;
    const el = audioRef.current;
    if (el) {
      el.src = url;
      el.onended = () => setState("idle");
      void el.play().catch(() => setState("idle"));
      setCanReplay(true);
    }
  }, [muted, token]);

  /** يُنطق آخرُ ردٍّ مرّةً واحدة — ولا يُعاد نطقُه مع كل إعادة رسم */
  useEffect(() => {
    if (!enabled || !ready || muted) return;
    if (!speakText || speakText === spokenRef.current) return;
    spokenRef.current = speakText;
    void speak(speakText);
  }, [enabled, ready, muted, speakText, speak]);

  const stopTicker = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setElapsed(0);
  };

  const start = useCallback(async () => {
    setError(null);
    const t = token();
    if (!t) { setError("رمزُ المحرّك المحلّيّ غيرُ مُدخَل."); return; }
    const mime = pickMime();
    if (!mime) { setError("المتصفّحُ لا يدعم تسجيلَ الصوت."); return; }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false },
      });
    } catch {
      /** ★ الرفضُ يُعلَن نظيفًا — ولا يُقترح بديل */
      setError("لم يُسمح بالوصول إلى الميكروفون.");
      return;
    }

    cancelledRef.current = false;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream, { mimeType: mime });
    recorderRef.current = rec;

    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      stopTicker();
      if (cancelledRef.current) { setState("idle"); return; }

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      chunksRef.current = [];
      setState("transcribing");
      const out = await transcribeLocally(t, blob);
      if (!out.ok) {
        setState("error");
        setError(messageForVoiceError(out.code));
        return;
      }
      const text = (out.text ?? "").trim();
      if (!text) { setState("idle"); setError("لم يُلتقط كلام."); return; }
      /** ★ يمضي النصُّ في مسار الإرسال القائم — لا مسارَ خاصّ بالصوت */
      setState("sending");
      onTranscript(text);
      setState("idle");
    };

    rec.start();
    setState("listening");
    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      /** سقفٌ صلب: يوقف نفسَه بدل أن يُرفض عند المحرّك بعد الانتظار */
      if (ms >= MAX_RECORDING_MS) {
        try { rec.stop(); } catch { /* أُوقف سلفًا */ }
      }
    }, 200);
  }, [onTranscript, token]);

  const stop = useCallback(() => {
    cancelledRef.current = false;
    try { recorderRef.current?.stop(); } catch { /* أُوقف سلفًا */ }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    try { recorderRef.current?.stop(); } catch { /* أُوقف سلفًا */ }
    const t = token();
    if (t) void cancelVoice(t);
    setState("idle");
  }, [token]);

  const replay = useCallback(() => {
    const el = audioRef.current;
    if (el && el.src) { setState("speaking"); void el.play().catch(() => setState("idle")); }
  }, []);

  const stopSpeaking = useCallback(() => {
    const el = audioRef.current;
    if (el) { el.pause(); el.currentTime = 0; }
    setState("idle");
  }, []);

  /** ★ مطفأة أو غيرُ متاحة ⇒ لا زرَّ ولا أثر */
  if (!enabled || ready !== true) return null;

  const label: Record<MicState, string> = {
    idle: "تحدَّث",
    listening: "يستمع…",
    transcribing: "يُفرَّغ محليًا…",
    sending: "يُرسل إلى YSD…",
    speaking: "يُنطق محليًا…",
    error: "خطأ",
  };

  return (
    <div className="flex flex-col gap-1" data-testid="local-voice">
      <div className="flex items-center gap-1">
        {state === "listening" ? (
          <>
            <button
              type="button"
              onClick={stop}
              data-testid="voice-stop"
              aria-label="إيقاف التسجيل وإرسال"
              className="rounded-md px-2 py-1 text-sm"
            >
              ■ {Math.floor(elapsed / 1000)}ث
            </button>
            <button
              type="button"
              onClick={cancel}
              data-testid="voice-cancel"
              aria-label="إلغاء التسجيل"
              className="rounded-md px-2 py-1 text-sm"
            >
              ✕
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={busy || state === "transcribing" || state === "sending"}
            data-testid="voice-mic"
            aria-label="تحدَّث — يُعالج الصوت محليًا"
            className="rounded-md px-2 py-1 text-sm"
          >
            🎙
          </button>
        )}

        {state === "speaking" ? (
          <button type="button" onClick={stopSpeaking} data-testid="voice-stop-speaking" aria-label="إيقاف النطق"
            className="rounded-md px-2 py-1 text-sm">⏹</button>
        ) : null}

        {canReplay && state !== "speaking" ? (
          <button type="button" onClick={replay} data-testid="voice-replay" aria-label="إعادة سماع الرد"
            className="rounded-md px-2 py-1 text-sm">↺</button>
        ) : null}

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          data-testid="voice-mute"
          aria-pressed={muted}
          aria-label={muted ? "تشغيل النطق" : "كتم النطق"}
          className="rounded-md px-2 py-1 text-sm"
        >
          {muted ? "🔇" : "🔊"}
        </button>

        <span data-testid="voice-state" className="text-xs opacity-70">{label[state]}</span>
      </div>

      {/**
        * ★ الشطرُ الأول صادقٌ، والثاني لا يجوز إخفاؤه.
        *
        * الصوتُ محلّيٌّ فعلًا: الالتقاطُ والتفريغُ والنطقُ كلُّها على الجهاز.
        * أمّا نصُّ الردّ فيأتي من YSD كالمعتاد — والادّعاءُ بأن المحادثةَ
        * كلَّها محلّية ادّعاءٌ كاذب.
        */}
      <p className="text-[11px] leading-tight opacity-70" data-testid="voice-privacy">
        <span data-testid="voice-privacy-local">الصوت يُعالج محليًا على جهازك</span>
        {" · "}
        <span data-testid="voice-privacy-cloud">قد يُرسل النص إلى YSD لمعالجة المحادثة</span>
      </p>

      {error ? (
        <p className="text-[11px] text-red-500" role="alert" data-testid="voice-error">{error}</p>
      ) : null}
      <audio ref={audioRef} hidden data-testid="voice-audio" />
    </div>
  );
}
