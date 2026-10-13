/**
 * بديلُ `speechSynthesis` للاختبار — jsdom لا يملك واحدًا.
 *
 * ★ الأحداثُ يسوقها الاختبار
 *
 *   `start` / `end` / `fail` تُستدعى صراحةً، فترتيبُ الأحداث معلومٌ لا
 *   مرهونٌ بمؤقّت. والبدءُ التلقائيّ (على مهمّةٍ صغرى) اختيارٌ يُطفأ حين
 *   يُراد قياسُ ما قبل البدء.
 *
 * ★ والإلغاءُ يُطلق حدثَه متأخّرًا — كما تفعل المتصفّحات
 *
 *   `cancel()` لا يُسكت العبارةَ الملغاة: يصلها خطأُ `canceled` (Chrome)
 *   أو نهايةٌ (Safari) **بعد** أن تكون الجلسةُ التالية قد بدأت. وهذا هو
 *   السباقُ الذي يجب أن يصمد له المُتحكِّم.
 *
 * ★ وتركُه غيرَ مثبَّتٍ هو حالةُ المتصفّح الذي لا يدعم القراءة.
 */
import { vi } from "vitest";

export interface FakeVoice {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
  voiceURI: string;
}

export function voice(name: string, lang: string, opts: { network?: boolean; default?: boolean } = {}): FakeVoice {
  return { name, lang, localService: !opts.network, default: opts.default ?? false, voiceURI: name };
}

export const AR_SA = voice("Arabic Saudi", "ar-SA");
export const AR_EG = voice("Arabic Egypt", "ar-EG");
export const EN_US = voice("English US", "en-US", { default: true });
export const EN_GB = voice("English UK", "en-GB");
export const DEFAULT_VOICES: FakeVoice[] = [EN_GB, EN_US, AR_EG, AR_SA];

type Handler = ((event: { error?: string }) => void) | null;

export class FakeUtterance {
  text: string;
  lang = "";
  voice: FakeVoice | null = null;
  volume = 1;
  rate = 1;
  pitch = 1;
  onstart: Handler = null;
  onend: Handler = null;
  onerror: Handler = null;
  constructor(text: string) {
    this.text = text;
  }
}

export class FakeSynth {
  voices: FakeVoice[];
  speaking = false;
  pending = false;
  /** كلُّ عبارةٍ سُلّمت إلى `speak()` بالترتيب */
  spoken: FakeUtterance[] = [];
  cancels = 0;
  getVoicesCalls = 0;
  /** يُطلق `start` على مهمّةٍ صغرى بعد `speak()` — محرّكٌ سليم */
  autoStart = true;
  /** ما يصل العبارةَ الملغاة بعد `cancel()` */
  lateCancelEvent: "error" | "end" | "none" = "error";
  /** `speak()` ترمي — محرّكٌ معطوب */
  throwOnSpeak = false;
  onvoiceschanged: (() => void) | null = null;
  private queue: FakeUtterance[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(voices: FakeVoice[] = DEFAULT_VOICES) {
    this.voices = voices;
  }

  getVoices(): FakeVoice[] {
    this.getVoicesCalls += 1;
    return this.voices;
  }

  speak(utterance: FakeUtterance): void {
    if (this.throwOnSpeak) throw new Error("engine down");
    this.spoken.push(utterance);
    this.queue.push(utterance);
    this.pending = true;
    if (this.autoStart) queueMicrotask(() => this.start(utterance));
  }

  cancel(): void {
    this.cancels += 1;
    const dropped = this.queue;
    this.queue = [];
    this.speaking = false;
    this.pending = false;
    for (const utterance of dropped) {
      if (this.lateCancelEvent === "error") queueMicrotask(() => utterance.onerror?.({ error: "canceled" }));
      if (this.lateCancelEvent === "end") queueMicrotask(() => utterance.onend?.({}));
    }
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "voiceschanged") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "voiceschanged") this.listeners.delete(listener);
  }

  // ---- يسوقها الاختبار ----

  /** أفي الطابور عبارةٌ لم تنتهِ ولم تُلغَ؟ */
  inFlight(utterance: FakeUtterance): boolean {
    return this.queue.includes(utterance);
  }

  start(utterance: FakeUtterance): void {
    if (!this.queue.includes(utterance)) return;
    this.speaking = true;
    this.pending = this.queue.length > 1;
    utterance.onstart?.({});
  }

  end(utterance: FakeUtterance): void {
    const at = this.queue.indexOf(utterance);
    if (at === -1) return;
    this.queue.splice(at, 1);
    this.speaking = false;
    this.pending = this.queue.length > 0;
    utterance.onend?.({});
  }

  fail(utterance: FakeUtterance, error: string): void {
    const at = this.queue.indexOf(utterance);
    if (at !== -1) this.queue.splice(at, 1);
    this.speaking = false;
    this.pending = this.queue.length > 0;
    utterance.onerror?.({ error });
  }

  /** حدثٌ يصل عبارةً خرجت من الطابور — متأخّرٌ عن جلسته */
  lateEnd(utterance: FakeUtterance): void {
    utterance.onend?.({});
  }

  lateError(utterance: FakeUtterance, error: string): void {
    utterance.onerror?.({ error });
  }

  loadVoices(voices: FakeVoice[]): void {
    this.voices = voices;
    for (const listener of [...this.listeners]) listener();
    this.onvoiceschanged?.();
  }

  get voiceListeners(): number {
    return this.listeners.size;
  }

  get last(): FakeUtterance {
    const utterance = this.spoken[this.spoken.length - 1];
    if (!utterance) throw new Error("nothing was spoken");
    return utterance;
  }
}

/** يُثبّت البديلَين على النافذة — ويُزالان بـ`vi.unstubAllGlobals()` */
export function installFakeSpeech(voices: FakeVoice[] = DEFAULT_VOICES): FakeSynth {
  const synth = new FakeSynth(voices);
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return synth;
}

/** يُفرغ المهامَّ الصغرى المعلّقة */
export async function microtasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
