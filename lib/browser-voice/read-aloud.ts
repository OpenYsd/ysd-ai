/**
 * مُتحكِّمُ القراءة بصوت المتصفّح — جلسةٌ واحدة في النافذة كلِّها.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا مُتحكِّمٌ واحد لا حالةٌ في كلّ زرّ
 *
 *  `speechSynthesis` طابورٌ واحد للنافذة. فلو ملك كلُّ زرٍّ حالتَه لتكلّم
 *  ردّان معًا، أو أوقف أحدُهما صاحبَه وظلّ يعرض «إيقاف». فالحالةُ هنا،
 *  والأزرارُ تقرؤها.
 *
 *  ★ ومَن صاحبُ الجلسة
 *
 *  رمزٌ يخصّ **نسخةَ الزرّ المركَّبة**، لا معرّفُ الرسالة: فالمعرّفُ يتبدّل
 *  عند اكتمال البثّ، والردُّ المُعاد توليدُه يرث معرّفَ سابقه، والمتوقّفُ
 *  يبقى بمعرّفٍ مؤقّت. والرمزُ لا يلتبس.
 *
 *  ★ والسباقُ الذي يُغلق بالعدّاد
 *
 *  `cancel()` لا يُسكت أحداثَ العبارة الملغاة: تصل نهايتُها أو خطؤها بعد
 *  أن بدأت جلسةٌ جديدة. فلكلّ جلسةٍ رقم، وكلُّ حدثٍ يحمل رقمَ جلسته
 *  وموضعَ مقطعه — وما لم يطابق الحاضرَ يُهمَل. فنهايةُ الردّ القديم لا
 *  تُطفئ الردَّ الجديد.
 *
 *  ★ ولا يُنطق شيءٌ إلا بضغطة
 *
 *  `speak()` تُستدعى من معالج النقر وحدَه. لا تأثيرَ يستدعيها، ولا ردٌّ
 *  محفوظٌ ولا مُعادٌ توليدُه يُقرأ من تلقاء نفسه.
 *
 *  ★ ولا شيءَ على مستوى الوحدة
 *
 *  لا `window` ولا `speechSynthesis` يُلمسان عند التحميل: الوحدةُ تُحمَّل
 *  على الخادم وفي الحزمة المطفأة. يُبحث عن الواجهة عند الاستدعاء، فيرى
 *  الاختبارُ بديلَه، والخادمُ لا يسقط.
 * ══════════════════════════════════════════════════════════════════
 */
import { chunkSpeechText, countScripts, detectSpeechLanguage, type SpeechChunk, type SpeechLanguage } from "@/lib/browser-voice/speech-text";
import { ALLOW_NETWORK_VOICES, DEFAULT_LANG_TAG, pickVoice } from "@/lib/browser-voice/voices";

export type ReadAloudStatus = "idle" | "loading" | "speaking" | "error";

export type ReadAloudError =
  | "unsupported"
  | "no_voice_ar"
  | "no_voice_en"
  | "blocked"
  | "network"
  | "failed";

export interface ReadAloudState {
  readonly status: ReadAloudStatus;
  /** صاحبُ الجلسة الجارية أو آخرِ جلسة — `null` قبل أيّ قراءة */
  readonly owner: symbol | null;
  readonly error: ReadAloudError | null;
  /** أذكر المتصفّحُ أنّ الصوت المختار ليس على الجهاز؟ */
  readonly networkVoice: boolean;
}

export const IDLE_STATE: ReadAloudState = Object.freeze({
  status: "idle",
  owner: null,
  error: null,
  networkVoice: false,
});

export interface ReadAloudTimings {
  /** مهلةُ بدء المقطع: بعدها يُعدّ المحرّكُ صامتًا */
  startTimeoutMs: number;
  /** أقصى انتظارٍ لقائمة الأصوات حين تأتي فارغة */
  voicesWaitMs: number;
  /** فسحةٌ بعد `cancel()` قبل عبارةٍ جديدة — بعضُ المحرّكات يبتلعها إن لاحقته */
  cancelSettleMs: number;
  /** مهلةُ تبنّي جلسةٍ فُكّ زرُّها — بعدها تُوقَف */
  adoptGraceMs: number;
  /** سقفُ مقطعٍ افتُرض بدؤه بلا حدث بدء — بعده يُعدّ المحرّكُ صامتًا */
  assumedStartCeilingMs: number;
}

export const DEFAULT_TIMINGS: ReadAloudTimings = Object.freeze({
  startTimeoutMs: 6000,
  voicesWaitMs: 1200,
  cancelSettleMs: 80,
  adoptGraceMs: 250,
  /**
   * مقطعُ نثرٍ من 180 حرفًا يُنطق في نحو ربع دقيقة. ومقطعٌ كلُّه أرقامٌ أطولُ
   * نطقًا من كتابته بأضعاف — فالسقفُ دقيقتان: لا يقطع قراءةً سليمة على محرّكٍ
   * لا يُطلق حدثَ البدء، ولا يترك محرّكًا عالقًا إلى الأبد.
   */
  assumedStartCeilingMs: 120000,
});

export interface ReadAloudOptions {
  timings?: Partial<ReadAloudTimings>;
  allowNetworkVoices?: boolean;
}

interface SpeechEnv {
  synth: SpeechSynthesis;
  Utterance: typeof SpeechSynthesisUtterance;
}

/** يُبحث عن الواجهة عند كلّ استدعاء — لا تُحفظ عند التحميل */
function lookupEnv(): SpeechEnv | null {
  const scope = globalThis as unknown as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };
  const synth = scope.speechSynthesis;
  const Utterance = scope.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== "function") return null;
  if (typeof synth.speak !== "function" || typeof synth.cancel !== "function") return null;
  return { synth, Utterance };
}

function readVoices(env: SpeechEnv): SpeechSynthesisVoice[] {
  try {
    const voices = typeof env.synth.getVoices === "function" ? env.synth.getVoices() : [];
    // محرّكٌ يُعيد غيرَ قائمة لا يُسقط الضغطة
    return Array.isArray(voices) ? voices : [];
  } catch {
    return [];
  }
}

function isBusy(env: SpeechEnv): boolean {
  try {
    return Boolean(env.synth.speaking || env.synth.pending);
  } catch {
    return false;
  }
}

function isSpeaking(env: SpeechEnv): boolean {
  try {
    return Boolean(env.synth.speaking);
  } catch {
    return false;
  }
}

function silence(env: SpeechEnv | null): void {
  try {
    env?.synth.cancel();
  } catch {
    /* محرّكٌ يرفض الإلغاء لا يُسقط الواجهة */
  }
}

/** رمزُ خطأ المتصفّح ⇒ سببٌ يُعرض — وما أُلغي عمدًا ليس خطأً */
function errorFor(code: string | undefined, language: SpeechLanguage): ReadAloudError {
  switch (code) {
    case "not-allowed":
      return "blocked";
    case "network":
      return "network";
    case "language-unavailable":
    case "voice-unavailable":
      return language === "ar" ? "no_voice_ar" : "no_voice_en";
    default:
      return "failed";
  }
}

/** أرقامٌ عربيّة-هنديّة وفارسيّة: نصٌّ بلا حروفٍ يحملها عربيٌّ عند اختيار الصوت */
const ARABIC_INDIC_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/;

export class ReadAloudController {
  private state: ReadAloudState = IDLE_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly timings: ReadAloudTimings;
  private readonly allowNetworkVoices: boolean;

  /** رقمُ الجلسة — يزيد عند كلّ بدءٍ أو إيقاف، فيُهمَل كلُّ حدثٍ أقدم */
  private session = 0;
  private chunks: SpeechChunk[] = [];
  private index = 0;
  /** النصُّ المقروء في الجلسة — به وحدَه يُتبنّى ما عبر إعادةَ التركيب */
  private text = "";
  /**
   * نطاقُ الجلسة — المحادثةُ التي بدأت فيها.
   *
   * النصُّ وحدَه لا يكفي للتبنّي: ردّان بنصٍّ واحد في محادثتين (تحيّةٌ، أو
   * اعتذارٌ معتاد) يجعلان القراءةَ تعبر إلى محادثةٍ لم يضغط فيها أحد.
   */
  private scope: string | null = null;
  private language: SpeechLanguage = "ar";
  /** ألِلنصّ حروفٌ تحسم لغتَه؟ — «2 + 2 = 4» لا لغةَ له، فيُقرأ بما حضر من صوت */
  private languageCertain = true;
  /** مرجعٌ يُبقي العبارةَ حيّة: بعضُ المتصفّحات يجمعها قبل أن يُطلق نهايتَها */
  private utterance: SpeechSynthesisUtterance | null = null;

  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** أكان التركيزُ على الزرّ الذي أُفلت؟ — فيعود إلى بديله إن تبنّى، ولا يُنتزع من غيره */
  private releasedWithFocus = false;
  private stopWaitingForVoices: (() => void) | null = null;
  private pageHideBound = false;
  private warmed = false;
  /** قائمةٌ بقيت فارغةً بعد انتظار: لا يُنتظر لها ثانيةً في هذه الصفحة */
  private voiceListEmpty = false;

  constructor(options: ReadAloudOptions = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.allowNetworkVoices = options.allowNetworkVoices ?? ALLOW_NETWORK_VOICES;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadAloudState => this.state;

  isSupported(): boolean {
    return lookupEnv() !== null;
  }

  /**
   * يوقظ قائمةَ الأصوات — ولا ينطق.
   *
   * أوّلُ `getVoices()` في بعض المتصفّحات تُعيد فارغًا وتبدأ التحميل. فيُطلب
   * عند ظهور الزرّ، لتكون القائمةُ حاضرةً عند الضغط.
   */
  warmUp(): void {
    if (this.warmed) return;
    const env = lookupEnv();
    if (!env) return;
    this.warmed = true;
    readVoices(env);
  }

  /**
   * ★ من معالج النقر وحدَه.
   *
   * @param owner رمزُ نسخة الزرّ — صاحبُ الجلسة.
   * @param speechText ناتجُ `toSpeechText` لنصّ الرسالة.
   * @param scope المحادثةُ التي فيها الزرّ — بها يُحصر التبنّي بعد إعادة التركيب.
   */
  speak(owner: symbol, speechText: string, scope: string | null = null): void {
    /**
     * عبارةٌ سلّمها هذا المُتحكِّم ولم تنتهِ تُلغى — ولو قال المحرّكُ إنّه ساكت.
     *
     * محرّكٌ لا يُحدّث `speaking` و`pending` يصطفّ فيه الردُّ الجديد خلف القديم،
     * والقديمُ ماضٍ في القراءة.
     */
    const handed = this.utterance !== null;
    const session = this.invalidate();
    const env = lookupEnv();
    if (!env) {
      this.set({ status: "error", owner, error: "unsupported", networkVoice: false });
      return;
    }
    const chunks = chunkSpeechText(speechText);
    if (chunks.length === 0) {
      silence(env);
      this.set(IDLE_STATE);
      return;
    }
    this.chunks = chunks;
    this.index = 0;
    this.text = speechText;
    this.scope = scope;
    this.language = detectSpeechLanguage(speechText);
    const scripts = countScripts(speechText);
    // والأرقامُ العربيّة-الهنديّة تحسم العربيّة: صوتٌ إنجليزيّ لا ينطق ما كُتب بها
    this.languageCertain = scripts.arabic !== scripts.latin || ARABIC_INDIC_DIGIT.test(speechText);

    const busy = handed || isBusy(env);
    // المستمعُ قبل الإعلان: مشتركٌ يوقف عند «جارٍ التحميل» لا يترك مستمعًا بلا جلسة
    this.bindPageHide();
    this.set({ status: "loading", owner, error: null, networkVoice: false });
    if (session !== this.session) return;

    if (busy) {
      // جلسةٌ سابقة ما زالت تتكلّم — من هذا المُتحكِّم أو من مستندٍ سبق
      silence(env);
      this.deferTimer = setTimeout(() => {
        this.deferTimer = null;
        this.begin(session);
      }, this.timings.cancelSettleMs);
      return;
    }
    this.begin(session);
  }

  /** إيقافٌ فوريّ — من الزرّ، ومن مغادرة الصفحة */
  stop(): void {
    const active = this.state.status === "loading" || this.state.status === "speaking";
    this.invalidate();
    if (!active) return;
    silence(lookupEnv());
    this.set({ status: "idle", owner: this.state.owner, error: null, networkVoice: false });
  }

  /**
   * زرٌّ يغادر الشجرة.
   *
   * إن كان صاحبَ جلسةٍ جارية فلا تُقطع فورًا: المحادثةُ الجديدة يُعاد
   * تركيبُها بعد أوّل ردّ، والزرُّ البديل يظهر في الدفعة نفسِها. فتُمهَل
   * لحظةً ليتبنّاها. وإن لم يتبنَّها أحد — تنقّلٌ، أو إعادةُ توليد، أو
   * حذف — أُوقفت.
   *
   * @param hadFocus أكان التركيزُ على الزرّ حين غادر؟
   */
  release(owner: symbol, hadFocus = false): void {
    if (this.state.owner !== owner) return;
    const active = this.state.status === "loading" || this.state.status === "speaking";
    if (!active) {
      this.invalidate();
      this.set(IDLE_STATE);
      return;
    }
    if (this.releaseTimer !== null) return;
    this.releasedWithFocus = hadFocus;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      this.releasedWithFocus = false;
      const session = this.session;
      this.stop();
      // مشتركٌ بدأ جلسةً أخرى عند إعلان الإيقاف: لا تُمحى حالتُها
      if (this.session === session + 1) this.set(IDLE_STATE);
    }, this.timings.adoptGraceMs);
  }

  /**
   * زرٌّ رُكّب. إن كانت جلسةٌ يتيمةٌ تقرأ **هذا النصَّ بعينه في هذه المحادثة
   * بعينها** فهو صاحبُها.
   *
   * ★ يتبنّى ولا يبدأ: لا قراءةَ تنشأ من هنا.
   *
   * @returns أتبنّى؟ — ليُعيد الزرُّ البديل التركيزَ الذي ذهب مع سابقه.
   */
  adopt(owner: symbol, speechText: string, scope: string | null = null): boolean {
    if (this.releaseTimer === null) return false;
    if (speechText !== this.text || scope !== this.scope) return false;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.set({ ...this.state, owner });
    return true;
  }

  /**
   * أكان التركيزُ على الزرّ الذي أُفلت قبل هذا التبنّي؟ — يُسأل مرّةً واحدة.
   *
   * «التركيزُ على جسم الصفحة» لا يكفي دليلًا: إعادةُ التركيب تُذهب كلَّ تركيزٍ
   * في المحادثة، ومنه تركيزُ مَن كان يكتب رسالتَه التالية. فلا يُعاد إلى الزرّ
   * البديل إلا ما كان على سابقه.
   */
  takeReleasedFocus(): boolean {
    const had = this.releasedWithFocus;
    this.releasedWithFocus = false;
    return had;
  }

  /** يُبطل كلَّ ما سبق: مؤقّتاتٍ ومستمعين وأحداثَ عباراتٍ قديمة */
  private invalidate(): number {
    this.session += 1;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    if (this.deferTimer !== null) clearTimeout(this.deferTimer);
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.startTimer = null;
    this.deferTimer = null;
    this.releaseTimer = null;
    // ولا يبقى «كان التركيزُ عليه» معلَّقًا بعد تسليمٍ أُبطل
    this.releasedWithFocus = false;
    this.stopWaitingForVoices?.();
    this.stopWaitingForVoices = null;
    this.utterance = null;
    this.unbindPageHide();
    return this.session;
  }

  private begin(session: number): void {
    if (session !== this.session) return;
    const env = lookupEnv();
    if (!env) {
      this.fail("unsupported");
      return;
    }
    const voices = readVoices(env);
    if (voices.length === 0 && !this.voiceListEmpty) {
      this.waitForVoices(session, env);
      return;
    }
    this.speakChunk(session, 0);
  }

  /** قائمةٌ فارغة: تُنتظر مرّةً واحدة، ثم يُمضى بما حضر */
  private waitForVoices(session: number, env: SpeechEnv): void {
    const proceed = () => {
      if (session !== this.session) return;
      this.stopWaitingForVoices?.();
      this.stopWaitingForVoices = null;
      const current = lookupEnv();
      if (current && readVoices(current).length === 0) this.voiceListEmpty = true;
      this.speakChunk(session, 0);
    };
    const onVoices = () => {
      if (readVoices(env).length > 0) proceed();
    };
    const timer = setTimeout(proceed, this.timings.voicesWaitMs);
    const target = env.synth;
    const evented = typeof target.addEventListener === "function";
    if (evented) target.addEventListener("voiceschanged", onVoices);
    else target.onvoiceschanged = onVoices;
    this.stopWaitingForVoices = () => {
      clearTimeout(timer);
      try {
        if (evented) target.removeEventListener("voiceschanged", onVoices);
        else if (target.onvoiceschanged === onVoices) target.onvoiceschanged = null;
      } catch {
        /* لا يُسقط الإيقافَ محرّكٌ بلا مستمعين */
      }
    };
  }

  private speakChunk(session: number, index: number): void {
    if (session !== this.session) return;
    const env = lookupEnv();
    const chunk = this.chunks[index];
    if (!env || !chunk) {
      this.fail(env ? "failed" : "unsupported");
      return;
    }
    const voices = readVoices(env);
    const policy = { allowNetwork: this.allowNetworkVoices };
    let main = pickVoice(voices, this.language, policy);
    if (index === 0 && voices.length > 0 && !this.languageCertain) {
      /**
       * نصٌّ بلا حروفٍ تحسم لغتَه (أرقامٌ ورموز) يُقرأ بما حضر من صوت.
       *
       * فإن لم يكن للّغة المفترضة صوت، أو كان صوتُها عبر الشبكة وللأخرى صوتٌ
       * على الجهاز، أُخذت الأخرى: لا يُنقل «2 + 2 = 4» إلى مزوّدٍ وصوتُ الجهاز
       * يقرؤه.
       */
      const other: SpeechLanguage = this.language === "ar" ? "en" : "ar";
      const alternative = pickVoice(voices, other, policy);
      if (alternative && (main === null || (main.network && !alternative.network))) {
        this.language = other;
        main = alternative;
      }
    }
    if (index === 0 && main === null && voices.length > 0) {
      // أصواتٌ حاضرة وليس فيها ما ينطق لغةَ الرد: اعتذارٌ بسببه، لا هذيان
      this.fail(this.language === "ar" ? "no_voice_ar" : "no_voice_en");
      return;
    }
    // والنصُّ غيرُ المحسوم يُقرأ كلُّه بالصوت الذي اختير له، لا بصوتٍ لكلّ مقطع
    const choice = this.languageCertain ? (pickVoice(voices, chunk.lang, policy) ?? main) : main;
    if (choice === null && !this.allowNetworkVoices) {
      /**
       * برفض أصوات الشبكة لا يُترك الاختيارُ للمحرّك — في أيّ مقطع.
       *
       * صوتٌ يختاره هو (قائمةٌ لا تُعرف، أو تبدّلت والقراءةُ جارية) لا يُعلم
       * أهو على الجهاز. فتسليمُه النصَّ ينقض السياسة.
       */
      this.fail(chunk.lang === "ar" ? "no_voice_ar" : "no_voice_en");
      return;
    }

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new env.Utterance(chunk.text);
      if (choice) {
        utterance.voice = choice.voice;
        utterance.lang = choice.langTag;
      } else {
        utterance.lang = DEFAULT_LANG_TAG[chunk.lang];
      }
    } catch {
      this.fail("failed");
      return;
    }

    const live = () => session === this.session && index === this.index;
    utterance.onstart = () => {
      if (!live()) return;
      this.markStarted();
    };
    utterance.onend = () => {
      if (!live()) return;
      this.clearStartTimer();
      if (index + 1 < this.chunks.length) this.speakChunk(session, index + 1);
      else this.finish();
    };
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      if (!live()) return;
      const code = event?.error as string | undefined;
      // أُلغيت من خارجنا (تبويبٌ آخر، أو المتصفّح): توقّفٌ لا عطب
      if (code === "canceled" || code === "interrupted") this.finish();
      else this.fail(errorFor(code, chunk.lang));
    };

    this.index = index;
    this.utterance = utterance;
    if (choice?.network && !this.state.networkVoice) this.set({ ...this.state, networkVoice: true });
    // مشتركٌ أوقف أو بدأ جلسةً أخرى عند ذلك الإعلان: لا تُسلَّم عبارةٌ لجلسةٍ انتهت
    if (!live()) return;

    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!live()) return;
      if (!isSpeaking(env)) {
        // لا حدثَ بدءٍ ولا كلام: المحرّكُ صامت
        this.fail("failed");
        return;
      }
      /**
       * حدثُ البدء لم يصل والمحرّكُ يقول إنّه يتكلّم.
       *
       * `speaking` في بعض المحرّكات صادقٌ ما دام في الطابور شيء — ولو لم
       * يُسمع صوت. فيُفترض البدء (محرّكاتٌ تتكلّم بلا حدث بدء)، ولا يُترك
       * الافتراضُ بلا سقف: مقطعٌ لم ينتهِ ولم يُخطئ في أضعاف زمنه محرّكٌ عالق.
       */
      this.markStarted();
      // مشتركٌ أوقف أو بدأ جلسةً أخرى عند إعلان «يتكلّم»: لا يُسلَّح سقفٌ لجلسةٍ انتهت
      if (!live()) return;
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        if (live()) this.fail("failed");
      }, this.timings.assumedStartCeilingMs);
    }, this.timings.startTimeoutMs);

    try {
      env.synth.speak(utterance);
    } catch {
      this.fail("failed");
    }
  }

  private markStarted(): void {
    this.clearStartTimer();
    if (this.state.status !== "speaking") this.set({ ...this.state, status: "speaking" });
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /** اكتملت القراءة أو أُوقفت من خارجنا — يبقى صاحبُها ليعرض «إعادة الاستماع» */
  private finish(): void {
    const owner = this.state.owner;
    this.invalidate();
    this.set({ status: "idle", owner, error: null, networkVoice: false });
  }

  private fail(error: ReadAloudError): void {
    const owner = this.state.owner;
    this.invalidate();
    silence(lookupEnv());
    this.set({ status: "error", owner, error, networkVoice: false });
  }

  private readonly onPageHide = (): void => {
    this.stop();
  };

  /** الانتقالُ بتحميلٍ كامل لا يُفكّ فيه مكوّن — فيُسكَت الصوتُ عند مغادرة الصفحة */
  private bindPageHide(): void {
    if (this.pageHideBound) return;
    const scope = globalThis as unknown as { addEventListener?: Window["addEventListener"] };
    if (typeof scope.addEventListener !== "function") return;
    scope.addEventListener("pagehide", this.onPageHide);
    this.pageHideBound = true;
  }

  private unbindPageHide(): void {
    if (!this.pageHideBound) return;
    const scope = globalThis as unknown as { removeEventListener?: Window["removeEventListener"] };
    scope.removeEventListener?.("pagehide", this.onPageHide);
    this.pageHideBound = false;
  }

  private set(next: ReadAloudState): void {
    const prev = this.state;
    if (
      prev.status === next.status &&
      prev.owner === next.owner &&
      prev.error === next.error &&
      prev.networkVoice === next.networkVoice
    ) {
      return;
    }
    // الخاملُ الأوّل مرجعٌ واحد: به يطابق الخادمُ المتصفّحَ عند أوّل رسم
    this.state = next === IDLE_STATE ? IDLE_STATE : Object.freeze({ ...next });
    for (const listener of [...this.listeners]) listener();
  }
}

let shared: ReadAloudController | null = null;

/** المُتحكِّمُ الواحد للنافذة — يُنشأ عند أوّل طلب، لا عند تحميل الوحدة */
export function getReadAloud(): ReadAloudController {
  if (shared === null) shared = new ReadAloudController();
  return shared;
}

/** للاختبار: يُسكت الجاريَ ويبدأ بمُتحكِّمٍ جديد */
export function resetReadAloudForTests(options?: ReadAloudOptions): ReadAloudController {
  shared?.stop();
  shared = new ReadAloudController(options);
  return shared;
}
