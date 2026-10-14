/**
 * اختيارُ صوت المتصفّح — دالّةٌ محضة على قائمةٍ تُعطى.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الترتيب
 *
 *  ١. صوتٌ يذكر المتصفّحُ أنّه من أصوات الجهاز، قبل كلّ صوتٍ سواه.
 *  ٢. ثم اللهجةُ المفضَّلة: `ar-SA` للعربيّة، و`en-US` ثم `en-GB`
 *     للإنجليزيّة، ثم أيُّ صوتٍ للّغة نفسها.
 *  ٣. ثم الصوتُ المعتاد قبل صوت المؤثّرات (في أنظمةٍ قائمتُها تبدأ بها).
 *  ٤. ثم الصوتُ الافتراضيّ في المتصفّح، ثم ترتيبُ القائمة.
 *
 *  ★ ولا ادّعاءَ هنا
 *
 *  `localService` خبرٌ يُخبر به المتصفّحُ عن نفسه، لا برهانٌ يُتحقَّق منه.
 *  فيُفضَّل ما قيل إنّه من أصوات الجهاز، ولا يُقال للمستخدم إنّ نصَّه لم
 *  يغادر جهازَه.
 *
 *  ★ والمجهولُ يُعامل بالأحوط
 *
 *  صوتُ الجهاز ما قال المتصفّحُ عنه `localService === true` — لا غير. فما
 *  قيل إنّه عبر الشبكة، وما لم يُذكر عنه شيء (خاصّيّةٌ غائبة أو قيمةٌ ليست
 *  منطقيّة)، سواء: يُؤخَّر في الترتيب، ولا يُسلَّم نصًّا إلا بموافقة
 *  المستخدم الصريحة — وذلك شأنُ المُتحكِّم.
 *
 *  ★ والصوتُ الخطأ أسوأ من لا صوت
 *
 *  صوتٌ إنجليزيٌّ يُعطى نصًّا عربيًّا يصمت أو يهذي. فإن لم يوجد صوتٌ
 *  للّغة أُعيد `null`، والقرارُ بعدها للمُتحكِّم: يعتذر بسببٍ واضح.
 * ══════════════════════════════════════════════════════════════════
 */
import type { SpeechLanguage } from "@/lib/browser-voice/speech-text";

/** ما يلزم من `SpeechSynthesisVoice` — فتُختبر الدالّةُ بلا متصفّح */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly localService?: boolean;
  readonly default?: boolean;
}

export interface VoiceChoice<V extends VoiceLike> {
  voice: V;
  /** وسمُ اللغة كما يُكتب في `utterance.lang` — بشرطةٍ لا بشرطةٍ سفليّة */
  langTag: string;
  /** أليس مذكورًا أنّه من أصوات الجهاز؟ — عبر الشبكة، أو لا يُعرف: كلاهما يحتاج موافقة */
  network: boolean;
}

/** أيذكر المتصفّحُ أنّ هذا الصوت من أصوات الجهاز؟ — `true` وحدَها تأكيد */
export function isReportedDeviceVoice(voice: VoiceLike): boolean {
  return voice.localService === true;
}

/**
 * ★ أتُعرض على المستخدم أصواتٌ ليست من أصوات الجهاز أصلًا؟
 *
 * `true`: تُعرض — **ولا تُستعمل إلا بعد موافقته الصريحة** (المُتحكِّم يسأله
 * قبل أن يُسلَّم نصٌّ). `false`: لا تُعرض ولا يُسأل؛ لا يُختار إلا صوتٌ يذكر
 * المتصفّحُ أنّه من أصوات الجهاز، ولا يُقرأ حين لا تُعرف قائمةُ الأصوات —
 * فيُعامل ذلك كغياب الصوت. وليس هذا ضمانًا بأنّ النصَّ لا يغادر الجهاز:
 * `localService` خبرٌ من المتصفّح لا برهان. سطرٌ واحد يقلب السياسة، وهي
 * قرارُ المالك.
 */
export const ALLOW_NETWORK_VOICES = true;

/** اللهجاتُ المفضَّلة بالترتيب — وما سواها من اللغة نفسها يليها */
const PREFERRED: Record<SpeechLanguage, readonly string[]> = {
  ar: ["ar-sa"],
  en: ["en-us", "en-gb"],
};

/** الوسمُ الذي يُكتب حين لا تُعرف قائمةُ الأصوات أصلًا */
export const DEFAULT_LANG_TAG: Record<SpeechLanguage, string> = {
  ar: "ar-SA",
  en: "en-US",
};

/**
 * أصواتُ مؤثّراتٍ لا قراءة — تُؤخَّر ولا تُمنع.
 *
 * في بعض الأنظمة تبدأ قائمةُ الإنجليزيّة بها أبجديًّا. فلو حُسم التساوي
 * بترتيب القائمة وحدَه لقُرئ الردُّ بصوتٍ هزليّ حين لا يكون صوتُ النظام
 * الافتراضيُّ إنجليزيًّا. والأسماءُ من الذاكرة لا من جهاز: فهي تؤخّر فقط،
 * ولا يضرّ أن يغيب منها اسمٌ أو يزيد.
 */
const NOVELTY_VOICES = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "good news", "jester",
  "organ", "superstar", "trinoids", "whisper", "wobble", "zarvox",
]);

function isNovelty(voice: VoiceLike): boolean {
  return typeof voice.name === "string" && NOVELTY_VOICES.has(voice.name.trim().toLowerCase());
}

/** `ar_SA` (أندرويد) و`AR-sa` ⇒ `ar-sa` */
export function normalizeLangTag(tag: string): string {
  return tag.trim().replace(/_/g, "-").toLowerCase();
}

function speaks(voice: VoiceLike, language: SpeechLanguage): boolean {
  // محرّكٌ يُعيد صوتًا بلا وسم لغة: لا يُطابق شيئًا، ولا يُسقط الضغطة
  if (typeof voice.lang !== "string") return false;
  const tag = normalizeLangTag(voice.lang);
  return tag === language || tag.startsWith(`${language}-`);
}

/**
 * أفضلُ صوتٍ لهذه اللغة من هذه القائمة — أو `null` إن لم يوجد.
 */
export function pickVoice<V extends VoiceLike>(
  voices: readonly V[],
  language: SpeechLanguage,
  options: { allowNetwork?: boolean } = {},
): VoiceChoice<V> | null {
  const allowNetwork = options.allowNetwork ?? ALLOW_NETWORK_VOICES;
  const preferred = PREFERRED[language];
  let best: V | null = null;
  let bestRank: readonly number[] = [];
  for (let index = 0; index < voices.length; index++) {
    const voice = voices[index];
    if (!voice || !speaks(voice, language)) continue;
    const network = !isReportedDeviceVoice(voice);
    if (network && !allowNetwork) continue;
    const locale = preferred.indexOf(normalizeLangTag(voice.lang));
    const rank = [network ? 1 : 0, locale === -1 ? preferred.length : locale, isNovelty(voice) ? 1 : 0, voice.default ? 0 : 1, index];
    if (best === null || compare(rank, bestRank) < 0) {
      best = voice;
      bestRank = rank;
    }
  }
  if (best === null) return null;
  return {
    voice: best,
    langTag: best.lang.trim().replace(/_/g, "-"),
    network: !isReportedDeviceVoice(best),
  };
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
