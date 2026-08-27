/**
 * عميلُ الصوت المحلّيّ — الحلقةُ المحلّية وحدها.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ وجهةٌ واحدة لا غير
 *
 *  كلُّ نداءٍ هنا يذهب إلى `LOCAL_ENGINE_ORIGIN` وحده. ولا مزوّدَ سحابيّ
 *  ولا مفتاحَ واجهة ولا سقوطَ إلى بديلٍ مدفوع — فإن تعذّر المحرّكُ فالجوابُ
 *  خطأٌ مُعلَن، والميزةُ تُخفى. وذلك عقدُ الصور نفسُه، حرفًا بحرف.
 *
 *  ★ ولا يُعاد التوليدُ ولا النطقُ تلقائيًّا
 *
 *  إعادةُ المحاولة تُضاعف انتظارَ المستخدم وتُهدر معالجَ جهازه. والفحصُ
 *  وحده يُعاد مرّةً واحدة، لأن أوّل نداءٍ من صفحةِ HTTPS إلى الحلقة
 *  المحلّية يستلزم تفاوضَ Private Network Access — وقد قِيس أنه يتجاوز
 *  المهلةَ القصيرة أوّلَ مرّة ثم يصير مِلّي‌ثوانٍ.
 * ══════════════════════════════════════════════════════════════════
 */
import { LOCAL_ENGINE_ORIGIN, type SpeakLanguage } from "@/lib/local-voice/flag";

const HEALTH_TIMEOUT_MS = 2_500;
const HEALTH_RETRY_TIMEOUT_MS = 6_000;
const HEALTH_RETRY_DELAY_MS = 200;
const HEALTH_MAX_ATTEMPTS = 2;
const CAPABILITIES_TIMEOUT_MS = 15_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const SYNTHESIZE_TIMEOUT_MS = 120_000;

export interface VoiceCapabilities {
  /**
   * ★ «رمزٌ خاطئ» تُفصل عن «المحرّكُ ساقط».
   *
   * كانتا حالةً واحدة، فكان المستخدمُ يُقال له «غيرُ متاح» وهو يملك محرّكًا
   * يعمل ورمزًا أخطأ في لصقه — فلا يعرف أين يبحث. والتمييزُ هنا هو ما
   * يجعل الرسالةَ في الواجهة تدلّ على الفعل الصحيح.
   */
  status: "ready" | "unauthorized" | "unavailable" | "not_running";
  sttAvailable: boolean;
  ttsAvailable: boolean;
  model?: string;
  device?: string;
  maxDurationMs?: number;
  maxBytes?: number;
  acceptedMime?: string[];
  voices?: Array<{ language: string; displayName: string }>;
}

export interface TranscriptResult {
  ok: boolean;
  text?: string;
  language?: string;
  audioMs?: number;
  durationMs?: number;
  code?: string;
}

export interface SynthesisResult {
  ok: boolean;
  id?: string;
  durationMs?: number;
  segments?: string[];
  code?: string;
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

/**
 * أيعمل المحرّك؟
 *
 * ★ ولا تُعاد المحاولةُ على رمزِ حالة.
 *
 * فرمزُ الحالة يعني أن المحرّكَ حيٌّ وأجاب — وتكرارُ الطلب لا يغيّر جوابَه،
 * وإنما يُضاعف الانتظار. والإعادةُ للأخطاء المرميّة وحدها (مهلة/شبكة)،
 * وهي حالةُ التفاوض الأولى.
 */
export async function probeVoiceEngine(): Promise<boolean> {
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const ms = attempt === 0 ? HEALTH_TIMEOUT_MS : HEALTH_RETRY_TIMEOUT_MS;
    const { signal, done } = withTimeout(ms);
    try {
      const res = await fetch(`${LOCAL_ENGINE_ORIGIN}/health`, { signal, cache: "no-store" });
      done();
      return res.ok;
    } catch {
      done();
      if (attempt + 1 < HEALTH_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY_MS));
      }
    }
  }
  return false;
}

export async function fetchVoiceCapabilities(token: string): Promise<VoiceCapabilities> {
  const { signal, done } = withTimeout(CAPABILITIES_TIMEOUT_MS);
  try {
    const res = await fetch(`${LOCAL_ENGINE_ORIGIN}/voice/capabilities`, {
      signal,
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    done();
    /** المحرّكُ أجاب ورفض الرمز — حيٌّ لا ساقط، والرسالةُ تختلف */
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized", sttAvailable: false, ttsAvailable: false };
    }
    if (!res.ok) return { status: "unavailable", sttAvailable: false, ttsAvailable: false };
    const body = (await res.json()) as {
      stt?: { available?: boolean; model?: string; device?: string; maxDurationMs?: number; maxBytes?: number; acceptedMime?: string[] };
      tts?: { available?: boolean; voices?: Array<{ language: string; displayName: string }> };
    };
    return {
      status: "ready",
      sttAvailable: Boolean(body.stt?.available),
      ttsAvailable: Boolean(body.tts?.available),
      model: body.stt?.model,
      device: body.stt?.device,
      maxDurationMs: body.stt?.maxDurationMs,
      maxBytes: body.stt?.maxBytes,
      acceptedMime: body.stt?.acceptedMime,
      voices: body.tts?.voices,
    };
  } catch {
    done();
    return { status: "not_running", sttAvailable: false, ttsAvailable: false };
  }
}

/** يُفرَّغ الصوتُ محليًّا. والبايتاتُ لا تغادر الحلقةَ المحلّية */
export async function transcribeLocally(token: string, blob: Blob): Promise<TranscriptResult> {
  const { signal, done } = withTimeout(TRANSCRIBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LOCAL_ENGINE_ORIGIN}/voice/transcribe`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": blob.type || "audio/webm",
      },
      body: blob,
    });
    done();
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return { ok: false, code: String(body?.code ?? "VOICE_NOT_AVAILABLE") };
    return {
      ok: true,
      text: String(body?.text ?? ""),
      language: body?.language as string | undefined,
      audioMs: body?.audioMs as number | undefined,
      durationMs: body?.durationMs as number | undefined,
    };
  } catch {
    done();
    /** ★ لا بديلَ سحابيّ — الفشلُ يُعلَن ولا يُستبدل */
    return { ok: false, code: "VOICE_NOT_AVAILABLE" };
  }
}

export async function synthesizeLocally(
  token: string,
  text: string,
  language: SpeakLanguage,
  rate = 1,
): Promise<SynthesisResult> {
  const { signal, done } = withTimeout(SYNTHESIZE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LOCAL_ENGINE_ORIGIN}/voice/synthesize`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      /** ★ لغةٌ من قائمةٍ مغلقة — والعميلُ لا يُسمّي صوتًا البتّة */
      body: JSON.stringify({ text, language, rate }),
    });
    done();
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return { ok: false, code: String(body?.code ?? "TTS_NOT_READY") };
    return {
      ok: true,
      id: body?.id as string | undefined,
      durationMs: body?.durationMs as number | undefined,
      segments: body?.segments as string[] | undefined,
    };
  } catch {
    done();
    return { ok: false, code: "TTS_NOT_READY" };
  }
}

/** بايتاتُ الصوت بمعرّفٍ مُبهَم — ولا مسارَ يخرج من المحرّك */
export async function fetchVoiceAudio(token: string, id: string): Promise<Blob | null> {
  try {
    const res = await fetch(`${LOCAL_ENGINE_ORIGIN}/voice/audio/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

export async function cancelVoice(token: string): Promise<void> {
  try {
    await fetch(`${LOCAL_ENGINE_ORIGIN}/voice/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* الإلغاءُ محاولةٌ مهذّبة — وفشلُه لا يُبلَّغ به المستخدم */
  }
}

/**
 * رسالةٌ عربيّةٌ لكلِّ رمزِ فشل.
 *
 * ★ ولا تقترح أيٌّ منها بديلًا سحابيًّا ولا مدفوعًا.
 */
export function messageForVoiceError(code: string | undefined): string {
  switch (code) {
    case "INSUFFICIENT_SYSTEM_RAM":
      return "ذاكرةُ الجهاز غيرُ كافية الآن لتفريغ الصوت محليًّا.";
    case "LOCAL_MODEL_MISSING":
      return "نموذجُ التفريغ المحلّيّ غيرُ مثبَّت على هذا الجهاز.";
    case "AUDIO_TOO_LONG":
      return "التسجيلُ أطولُ من الحدّ المسموح (دقيقة واحدة).";
    case "AUDIO_TOO_LARGE":
      return "حجمُ التسجيل أكبرُ من الحدّ المسموح.";
    case "UNSUPPORTED_AUDIO_TYPE":
      return "صيغةُ الصوت غيرُ مدعومة في هذا المتصفّح.";
    case "AUDIO_DECODE_FAILED":
      return "تعذّر قراءةُ التسجيل — أعد المحاولة.";
    case "VOICE_BUSY":
      return "هناك عمليةُ صوتٍ جارية — انتظر لحظة.";
    case "VOICE_CANCELLED":
      return "أُلغيت العملية.";
    case "TTS_NOT_READY":
      return "لا يوجد صوتٌ محلّيٌّ مثبَّت لهذه اللغة على جهازك.";
    case "STT_NOT_READY":
    case "VOICE_NOT_AVAILABLE":
    default:
      return "المحرّكُ المحلّيّ لا يعمل — الصوتُ غيرُ متاح.";
  }
}

/**
 * أيُّ لغةٍ يُنطق بها هذا النصّ؟
 *
 * حكمٌ بسيطٌ على الخطّ الغالب — والمحرّكُ يقطّع المختلطَ بنفسه، فلا حاجةَ
 * هنا إلا لاختيار الصوت الأساس.
 */
export function pickSpeakLanguage(text: string): SpeakLanguage {
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    if (/[؀-ۿ]/.test(ch)) arabic += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  return arabic >= latin ? "ar-SA" : "en-US";
}
