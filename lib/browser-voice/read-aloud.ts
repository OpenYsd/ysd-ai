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
 *  ★ ولا نصَّ يُسلَّم لصوتٍ ليس من أصوات الجهاز إلا بموافقة
 *
 *  صوتٌ يذكر المتصفّحُ أنّه عبر الشبكة، أو لا يذكر عنه شيئًا، أو يختاره
 *  المحرّكُ من قائمةٍ لا تُعرف: قد يُنقل معه نصُّ الرد إلى مزوّد الصوت في
 *  المتصفّح. فقبل **كلّ** تسليمٍ يُنظر في الصوت المختار؛ فإن لم يكن من
 *  أصوات الجهاز ولم يوافق المستخدم بعدُ، وقفت الجلسةُ على «بانتظار
 *  الموافقة» ولم يُستدعَ `speak`. الموافقةُ والرفضُ ضغطتان منه، ويبقيان
 *  في الذاكرة ما بقيت الصفحة — لا يُحفظان ولا يُفترضان.
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

/** `consent`: الجلسةُ واقفةٌ تنتظر قرارَ المستخدم في صوتٍ ليس من أصوات الجهاز — ولم يُسلَّم شيء */
export type ReadAloudStatus = "idle" | "consent" | "loading" | "speaking" | "error";

/**
 * قرارُ المستخدم في الأصوات التي ليست من أصوات الجهاز — للصفحة المفتوحة كلِّها.
 *
 * `undecided`: لم يُسأل بعد، فيُسأل قبل أوّل تسليم. `granted`: وافق.
 * `declined`: اختار أصواتَ الجهاز وحدَها.
 */
export type NetworkVoiceConsent = "undecided" | "granted" | "declined";

export type ReadAloudError =
  | "unsupported"
  | "no_voice_ar"
  | "no_voice_en"
  /** اختار المستخدمُ أصواتَ الجهاز وحدَها، وليس بينها ما ينطق لغةَ الرد */
  | "device_only_ar"
  | "device_only_en"
  | "blocked"
  | "network"
  | "failed";

export interface ReadAloudState {
  readonly status: ReadAloudStatus;
  /** صاحبُ الجلسة الجارية أو آخرِ جلسة — `null` قبل أيّ قراءة */
  readonly owner: symbol | null;
  readonly error: ReadAloudError | null;
  /** أيُقرأ الآن بصوتٍ ليس من أصوات الجهاز (عبر الشبكة أو لا يُعرف) — بعد موافقة؟ */
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
  /**
   * قرارٌ ابتدائيّ — **للاختبار وحدَه**. المُتحكِّمُ المشترك يُنشأ بلا خيارات،
   * فيبدأ «لم يُسأل» ولا يوافق عن المستخدم أحد.
   */
  networkVoiceConsent?: NetworkVoiceConsent;
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
  /** اللغةُ كما حُسمت من النصّ — منها يُعاد الاختيارُ بعد كلّ قرار */
  private detected: SpeechLanguage = "ar";
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
  /** قرارُ المستخدم في الأصوات التي ليست من أصوات الجهاز — في الذاكرة، ما بقيت الصفحة */
  private consent: NetworkVoiceConsent;

  constructor(options: ReadAloudOptions = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.allowNetworkVoices = options.allowNetworkVoices ?? ALLOW_NETWORK_VOICES;
    this.consent = options.networkVoiceConsent ?? "undecided";
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

  /** القرارُ الحاضر — للعرض والاختبار؛ لا يُغيَّر إلا بضغطةٍ من المستخدم */
  getNetworkVoiceConsent(): NetworkVoiceConsent {
    return this.consent;
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
    this.detected = detectSpeechLanguage(speechText);
    this.language = this.detected;
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

  /**
   * ★ موافقةٌ صريحة — من ضغطة «أوافق» وحدَها.
   *
   * تُسجَّل للصفحة المفتوحة، وتُستأنف الجلسةُ الواقفة من مقطعها في الضغطة
   * نفسِها (فهي الإيماءةُ التي يشترطها المتصفّح للنطق).
   */
  allowNetworkVoice(owner: symbol): void {
    if (this.state.status !== "consent" || this.state.owner !== owner) return;
    this.consent = "granted";
    this.resume();
  }

  /**
   * ★ رفضٌ صريح: أصواتُ الجهاز وحدَها — من ضغطةٍ وحدَها.
   *
   * والجلسةُ واقفة: تُستأنف بأصوات الجهاز، فإن لم يكن بينها ما ينطق لغةَ
   * الرد اعتُذر بذلك.
   *
   * وبعد موافقةٍ سبقت هو **سحبٌ لها**: أثناء قراءةٍ بصوتٍ ليس من أصوات الجهاز
   * تسكت القراءةُ فورًا؛ وبعد انتهاء قراءةِ صاحبها يُسجَّل للقادم بلا نداءٍ
   * آخر للمحرّك — فلا يلزم لسحب الموافقة أن يُسلَّم ردٌّ آخر. وقراءةٌ جاريةٌ
   * بصوت الجهاز لا يقطعها ولا يُسجَّل معها شيء: لا زرَّ له هناك.
   */
  declineNetworkVoice(owner: symbol): void {
    const state = this.state;
    if (state.owner !== owner) return;
    if (state.status === "consent") {
      this.consent = "declined";
      this.resume();
      return;
    }
    if (this.consent !== "granted") return;
    const reading = state.status === "loading" || state.status === "speaking";
    if (reading && state.networkVoice) {
      this.consent = "declined";
      this.stop();
    } else if (state.status === "idle") {
      this.consent = "declined";
    }
  }

  /**
   * ★ يُعاد السؤال — من ضغطة «تغيير الاختيار» بعد رفضٍ لم يُبقِ ما يُقرأ به.
   *
   * لا يوافق عن المستخدم: يمحو الرفضَ ويبدأ من جديد، فيُسأل قبل أيّ تسليم.
   */
  reconsiderNetworkVoice(owner: symbol, speechText: string, scope: string | null = null): void {
    if (this.consent === "declined") this.consent = "undecided";
    this.speak(owner, speechText, scope);
  }

  /** إيقافٌ فوريّ — من الزرّ، ومن مغادرة الصفحة. وهو إلغاءُ السؤال أيضًا: لا يُعدّ رفضًا ولا موافقة */
  stop(): void {
    const status = this.state.status;
    const active = status === "loading" || status === "speaking";
    this.invalidate();
    if (status === "consent") {
      // لم يُسمع شيء: يعود الزرُّ «استمع»، والقرارُ على حاله
      this.set(IDLE_STATE);
      return;
    }
    if (!active) return;
    silence(lookupEnv());
    this.set({ status: "idle", owner: this.state.owner, error: null, networkVoice: false });
  }

  /** الجلسةُ الواقفة على السؤال تمضي من مقطعها بعد القرار */
  private resume(): void {
    const session = this.session;
    const owner = this.state.owner;
    this.set({ status: "loading", owner, error: null, networkVoice: false });
    // مشتركٌ أوقف أو بدأ جلسةً أخرى عند ذلك الإعلان: `speakChunk` يُهمل جلسةً لم تعد الحاضرة
    this.speakChunk(session, this.index);
  }

  /** الجلسةُ تقف على السؤال قبل تسليم هذا المقطع — ولا شيءَ في المحرّك */
  private askConsent(index: number): void {
    this.index = index;
    this.clearStartTimer();
    this.utterance = null;
    this.set({ status: "consent", owner: this.state.owner, error: null, networkVoice: false });
  }

  /** أيُختار الآن صوتٌ ليس من أصوات الجهاز؟ — السياسةُ أوّلًا، ثم ما لم يرفضه المستخدم */
  private mayPickNetwork(): boolean {
    return this.allowNetworkVoices && this.consent !== "declined";
  }

  /**
   * صوتُ لغة الرد — ولغتُه.
   *
   * نصٌّ بلا حروفٍ تحسم لغتَه (أرقامٌ ورموز) يُقرأ بما حضر من صوت: فإن لم
   * يكن للّغة المفترضة صوت، أو لم يكن صوتُها من أصوات الجهاز وللأخرى صوتٌ
   * منها، أُخذت الأخرى — لا يُنقل «2 + 2 = 4» إلى مزوّدٍ وصوتُ الجهاز يقرؤه.
   */
  private pickMain(
    voices: SpeechSynthesisVoice[],
    policy: { allowNetwork: boolean },
  ): { main: ReturnType<typeof pickVoice<SpeechSynthesisVoice>>; language: SpeechLanguage } {
    let language = this.detected;
    let main = pickVoice(voices, language, policy);
    if (voices.length > 0 && !this.languageCertain) {
      const other: SpeechLanguage = language === "ar" ? "en" : "ar";
      const alternative = pickVoice(voices, other, policy);
      if (alternative && (main === null || (main.network && !alternative.network))) {
        language = other;
        main = alternative;
      }
    }
    return { main, language };
  }

  /**
   * لا صوتَ للمقطع الأوّل والأصواتُ حاضرة: أهو غيابُ الصوت، أم أثرُ الرفض؟
   *
   * يُنظر فيما كان يُختار لولا الرفض — **ولغتِه**: نصٌّ بلا حروفٍ تحسم لغتَه
   * («2 + 2 = 4») يُقرأ بصوت أيٍّ من اللغتين. فلو سُئل عن لغته المفترضة وحدَها
   * لقيل «لا صوتَ عربيًّا في متصفّحك» والمانعُ اختيارُ المستخدم لا غيابُ
   * الصوت، ولَما عُرض عليه أن يغيّره.
   */
  private missingMain(voices: SpeechSynthesisVoice[]): ReadAloudError {
    if (this.allowNetworkVoices && this.consent === "declined") {
      const open = this.pickMain(voices, { allowNetwork: true });
      if (open.main !== null) return open.language === "ar" ? "device_only_ar" : "device_only_en";
    }
    return this.language === "ar" ? "no_voice_ar" : "no_voice_en";
  }

  /** لا صوتَ يُقرأ به مقطعٌ: أهو غيابُ الصوت، أم أثرُ اختيار «أصوات الجهاز فقط»؟ */
  private missingVoice(voices: SpeechSynthesisVoice[], language: SpeechLanguage): ReadAloudError {
    if (this.allowNetworkVoices && this.consent === "declined") {
      // قائمةٌ لا تُعرف، أو فيها صوتٌ للّغة ليس من أصوات الجهاز: الرفضُ هو ما منع القراءة
      const refused = voices.length === 0 || pickVoice(voices, language, { allowNetwork: true }) !== null;
      if (refused) return language === "ar" ? "device_only_ar" : "device_only_en";
    }
    return language === "ar" ? "no_voice_ar" : "no_voice_en";
  }

  /**
   * زرٌّ يغادر الشجرة.
   *
   * إن كان صاحبَ جلسةٍ جارية فلا تُقطع فورًا: المحادثةُ الجديدة يُعاد
   * تركيبُها بعد أوّل ردّ، والزرُّ البديل يظهر في الدفعة نفسِها. فتُمهَل
   * لحظةً ليتبنّاها. وإن لم يتبنَّها أحد — تنقّلٌ، أو إعادةُ توليد، أو
   * حذف — أُوقفت.
   *
   * والجلسةُ الواقفةُ على سؤال الموافقة مثلُ الجارية: السؤالُ الذي فتحه
   * المستخدمُ لا يختفي من تلقاء نفسه بإعادة التركيب تلك. يتبنّاه الزرُّ
   * البديل للردّ نفسِه في المحادثة نفسِها، وإلا زال بلا قرار.
   *
   * @param hadFocus أكان التركيزُ على الزرّ حين غادر؟
   */
  release(owner: symbol, hadFocus = false): void {
    if (this.state.owner !== owner) return;
    const status = this.state.status;
    const active = status === "loading" || status === "speaking" || status === "consent";
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
    const policy = { allowNetwork: this.mayPickNetwork() };
    let main: ReturnType<typeof pickVoice<SpeechSynthesisVoice>>;
    if (index === 0) {
      // من اللغة المحسومة في كلّ مرّة: فالمقطعُ الأوّل يُعاد النظرُ فيه بعد الموافقة والرفض
      const picked = this.pickMain(voices, policy);
      this.language = picked.language;
      main = picked.main;
      if (main === null && voices.length > 0) {
        // أصواتٌ حاضرة وليس فيها ما ينطق لغةَ الرد: اعتذارٌ بسببه، لا هذيان
        this.fail(this.missingMain(voices));
        return;
      }
    } else {
      main = pickVoice(voices, this.language, policy);
    }
    // والنصُّ غيرُ المحسوم يُقرأ كلُّه بالصوت الذي اختير له، لا بصوتٍ لكلّ مقطع
    const choiceFor = (part: SpeechChunk) => (this.languageCertain ? (pickVoice(voices, part.lang, policy) ?? main) : main);
    const choice = choiceFor(chunk);
    if (choice === null && !policy.allowNetwork) {
      /**
       * بأصوات الجهاز وحدَها لا يُترك الاختيارُ للمحرّك — في أيّ مقطع.
       *
       * صوتٌ يختاره هو (قائمةٌ لا تُعرف، أو تبدّلت والقراءةُ جارية) لا يُعلم
       * أهو من أصوات الجهاز. فتسليمُه النصَّ ينقض السياسةَ أو اختيارَ المستخدم.
       */
      this.fail(this.missingVoice(voices, chunk.lang));
      return;
    }
    if (policy.allowNetwork && this.consent !== "granted") {
      /**
       * ★ ★ ★ السؤالُ قبل التسليم — وهذا موضعُه الوحيد.
       *
       * `null` صوتٌ يختاره المحرّك (لا تُعرف القائمة)، و`network` صوتٌ لم يذكر
       * المتصفّحُ أنّه من أصوات الجهاز. وعند المقطع الأوّل يُنظر في المقاطع
       * كلِّها: فيُسأل المستخدمُ قبل أن يُسمع شيء، لا في وسط الرد. والنظرُ عند
       * كلّ مقطعٍ بعده يحرس قائمةً تبدّلت والقراءةُ جارية.
       */
      const offDevice = (picked: typeof choice) => picked === null || picked.network;
      const ahead = index === 0 && this.chunks.some((part, at) => at > 0 && offDevice(choiceFor(part)));
      if (offDevice(choice) || ahead) {
        this.askConsent(index);
        return;
      }
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
    // بعد الموافقة: صوتٌ لم يُذكر أنّه من أصوات الجهاز، أو صوتٌ يختاره المحرّك — يُعلَّم ما دامت القراءة
    if ((choice === null || choice.network) && !this.state.networkVoice) this.set({ ...this.state, networkVoice: true });
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
