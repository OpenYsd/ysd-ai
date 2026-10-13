"use client";

/**
 * «استمع» — قراءةُ ردّ المساعد بصوت المتصفّح.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ زرٌّ واحد يتبدّل اسمُه
 *
 *  «استمع» ثم «إيقاف القراءة» ثم «إعادة الاستماع» — على العنصر نفسِه.
 *  فمن يتنقّل بلوحة المفاتيح لا يفقد موضعَه حين تتبدّل الحالة: الزرُّ
 *  الذي ضغطه هو الذي يوقف، وهو الذي يعيد. و«إعادة الاستماع» بعد قراءةٍ
 *  انتهت أو أوقفها المستخدم؛ وبعد أيّ عطبٍ يبقى الاسمُ «استمع».
 *
 *  ★ والحالةُ ليست هنا
 *
 *  تُقرأ من المُتحكِّم الواحد. فلا يتكلّم ردّان، ولا يعرض زرٌّ «إيقاف»
 *  وقد سكت صاحبُه.
 *
 *  ★ ولا يُنطق شيءٌ إلا بضغطة
 *
 *  التأثيراتُ هنا توقظ قائمةَ الأصوات وتتبنّى وتُفلت — ولا تبدأ قراءة.
 *  فالردُّ المحفوظ والمُعادُ توليدُه يظهران صامتَين.
 *
 *  ★ ونصُّ الرد لا يُرسم مرّةً ثانية
 *
 *  لا نسخةَ مخفيّة منه ولا وصفَ يحمله: يُسلَّم إلى المتصفّح نصًّا، ولا
 *  يدخل الصفحةَ من هذا المكوّن حرفٌ منه.
 *
 *  ★ والمتصفّحُ الذي لا يقرأ يُقال له ذلك
 *
 *  الإخفاءُ حقُّ الراية المطفأة وحدَها. أمّا المشتعلةُ على متصفّحٍ لا
 *  يدعم القراءة فالزرُّ فيها زرٌّ عاديّ، وضغطُه يذكر السبب. ولا يُعلَّم
 *  «معطَّلًا» وهو يُضغط: ذلك يقول للقارئ الآليّ ما ليس صحيحًا.
 *
 *  ★ ولا فرقَ بين الخادم والمتصفّح عند أوّل رسم
 *
 *  لا شيءَ يُسأل عنه المتصفّحُ يدخل الرسمَ الأوّل: قائمةُ الأصوات تُوقَظ بعد
 *  التركيب، ولا تُقرأ حالةٌ قبل الضغط. فما يرسمه الخادمُ هو ما يرسمه
 *  المتصفّحُ أوّلَ مرّة.
 * ══════════════════════════════════════════════════════════════════
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, RotateCcw, Square, Volume2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isBrowserVoiceEnabled } from "@/lib/browser-voice/flag";
import { getReadAloud, IDLE_STATE, type ReadAloudError, type ReadAloudState } from "@/lib/browser-voice/read-aloud";
import { isSupportedSpeechLanguage, toSpeechText } from "@/lib/browser-voice/speech-text";

const browserVoiceEnabled = isBrowserVoiceEnabled();

/** سببُ العطب ⇒ مفتاحُه في القاموس — يُترجَم عند الرسم، فيتبع لغةَ الواجهة إن تبدّلت */
const ERROR_TEXT = {
  unsupported: "readAloudUnsupported",
  no_voice_ar: "readAloudNoArabicVoice",
  no_voice_en: "readAloudNoEnglishVoice",
  blocked: "readAloudBlocked",
  network: "readAloudNetwork",
  failed: "readAloudFailed",
} as const satisfies Record<ReadAloudError, string>;

const idleOnServer = (): ReadAloudState => IDLE_STATE;

interface ReadAloudProps {
  /** نصُّ الرسالة الخام (Markdown) — لا نصُّ الصفحة */
  text: string;
  /** المحادثةُ التي فيها الرد — بها يُحصر تبنّي القراءة بعد إعادة التركيب */
  scope: string | null;
}

export function ReadAloudButton({ text, scope }: ReadAloudProps) {
  if (!browserVoiceEnabled) return null;
  return <ReadAloudControl text={text} scope={scope} />;
}

function ReadAloudControl({ text, scope }: ReadAloudProps) {
  const { t } = useI18n();
  const readAloud = getReadAloud();
  /** ما يُقرأ من الرد — وفارغٌ إن لم يكن فيه ما يُقرأ، أو كان بلغةٍ لا صوتَ يصحّ لها هنا */
  const speechText = useMemo(() => {
    const plain = toSpeechText(text);
    return isSupportedSpeechLanguage(plain) ? plain : "";
  }, [text]);

  /** رمزُ هذه النسخة — صاحبُ الجلسة، لا معرّفُ الرسالة */
  const [owner] = useState(() => Symbol("read-aloud"));
  /** يزيد مع كلّ ضغطة: فالتنبيهُ نفسُه يُعاد إدراجُه ويُقرأ ثانيةً إن تكرّر العطب */
  const [attempt, setAttempt] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  /**
   * أالتركيزُ على هذا الزرّ؟
   *
   * يُتتبَّع بحدثَيه لا بسؤال الصفحة عند الفكّ: العنصرُ يُنزع قبل أن يجري
   * التنظيف، فلا يبقى في الصفحة ما يدلّ على أنّ التركيز كان عليه. وReact لا
   * يُوصل `blur` وهو ينزع العنصر، ومتصفّحٌ لا يُطلقه أصلًا لا يغيّر شيئًا —
   * فتبقى العلامةُ صادقة.
   */
  const focused = useRef(false);
  const noteId = useId();

  const state = useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, idleOnServer);

  useEffect(() => {
    readAloud.warmUp();
  }, [readAloud]);

  useEffect(() => {
    /**
     * الزرُّ السابق ذهب بتركيزه: يُعاد إلى بديله.
     *
     * ولا يُعاد إلا ما كان على الزرّ نفسِه، وما دام لم يركّز أحدٌ على شيءٍ بعد:
     * إعادةُ التركيب تُذهب تركيزَ مَن كان يكتب رسالتَه التالية أيضًا، ولا يصحّ
     * أن ينتقل ضغطُه التالي إلى «إيقاف القراءة».
     */
    if (readAloud.adopt(owner, speechText, scope) && readAloud.takeReleasedFocus()) {
      const active = document.activeElement;
      if (active === null || active === document.body) buttonRef.current?.focus({ preventScroll: true });
    }
    return () => readAloud.release(owner, focused.current);
  }, [readAloud, owner, speechText, scope]);

  // ردٌّ ليس فيه ما يُقرأ (كودٌ كلُّه): لا زرَّ يَعِد بما لا يكون
  if (!speechText) return null;

  const mine = state.owner === owner;
  const active = mine && (state.status === "loading" || state.status === "speaking");
  const failed = mine && state.status === "error" && state.error !== null;
  /** قراءةٌ لهذا الرد انتهت أو أوقفها المستخدم — لا عطب */
  const played = mine && !active && !failed;
  const noted = active && state.networkVoice;

  const label = active ? t("readAloudStop") : played ? t("readAloudReplay") : t("readAloudListen");
  const phase = active ? state.status : failed ? "error" : played ? "ended" : "idle";

  /**
   * ★ يُسأل المُتحكِّمُ لحظةَ الضغط، لا ما رُسم.
   *
   * ضغطتان متلاحقتان قد تسبق ثانيتُهما إعادةَ الرسم. فلو حُكم بما في
   * الرسم لبدأت الثانيةُ جلسةً أخرى بدل أن توقف الأولى.
   */
  const readingNow = () => {
    const now = readAloud.getSnapshot();
    return now.owner === owner && (now.status === "loading" || now.status === "speaking");
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-read-aloud=""
        data-read-aloud-state={phase}
        aria-busy={active && state.status === "loading" ? true : undefined}
        aria-describedby={noted ? noteId : undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onClick={() => {
          if (readingNow()) {
            readAloud.stop();
            return;
          }
          setAttempt((n) => n + 1);
          readAloud.speak(owner, speechText, scope);
        }}
        onKeyDown={(event) => {
          // مفتاحٌ مضغوطٌ باستمرار لا يُبدّل بين القراءة والإيقاف عشرين مرّةً في الثانية
          if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
          else if (event.key === "Escape" && readingNow()) readAloud.stop();
        }}
        className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md text-ink-faint
                   hover:text-ink hover:bg-raised transition-colors
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
      >
        {active ? (
          <Square size={12} aria-hidden />
        ) : played ? (
          <RotateCcw size={12} aria-hidden />
        ) : (
          <Volume2 size={12} aria-hidden />
        )}
        {label}
      </button>
      {failed && state.error ? (
        <p
          key={attempt}
          role="alert"
          data-read-aloud-error={state.error}
          className="order-last basis-full flex items-start gap-1.5 mt-1 text-[12px] leading-relaxed text-ink-dim"
        >
          <AlertTriangle size={12} aria-hidden className="mt-1 shrink-0" />
          <span>{t(ERROR_TEXT[state.error])}</span>
        </p>
      ) : null}
      {noted ? (
        <p
          id={noteId}
          role="note"
          data-read-aloud-note=""
          className="order-last basis-full mt-1 text-[11.5px] leading-relaxed text-ink-faint"
        >
          {t("readAloudNetworkNote")}
        </p>
      ) : null}
    </>
  );
}
