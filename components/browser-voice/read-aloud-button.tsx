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
 *  التأثيراتُ هنا توقظ قائمةَ الأصوات وتتبنّى وتُفلت وتنقل التركيز — ولا
 *  تبدأ قراءة. فالردُّ المحفوظ والمُعادُ توليدُه يظهران صامتَين.
 *
 *  ★ ولا صوتَ ليس من أصوات الجهاز إلا بموافقة
 *
 *  إن لم يذكر المتصفّحُ أنّ صوتًا يلزم للرد من أصوات الجهاز، وقف المُتحكِّمُ
 *  قبل أن يُسلِّم نصًّا، وظهر تحت الزرّ سؤالٌ بخيارين: «أصوات الجهاز فقط»
 *  ثم «أوافق». والتركيزُ يذهب إلى **السؤال نفسِه** لا إلى زرٍّ من زرَّيه:
 *  فلا ضغطةٌ ممتدّة على «استمع» ولا ضغطةُ `Enter` ثانيةٌ تصير قرارًا — لا
 *  موافقةً ولا رفضًا. والزرُّ نفسُه و`Escape` يلغيان السؤال بلا قرار.
 *
 *  ★ وللقرار رجعة حيث يُستعمل
 *
 *  من وافق يجد «أصوات الجهاز فقط» تحت الرد الذي قُرئ بصوتٍ ليس من أصوات
 *  الجهاز — ما دامت قراءتُه وبعد انتهائها — فلا يلزم لسحب الموافقة أن
 *  يُسلَّم ردٌّ آخر. ومن رفض ثم منع رفضُه قراءةَ ردٍّ يجد «تغيير الاختيار».
 *  وما سوى ذلك يبقى القرارُ إلى إعادة تحميل الصفحة.
 *
 *  ★ ولا يُعرض مع الصوت المحلّيّ
 *
 *  القرارُ في وحدة وضع الصوت: إن اشتعلت رايةُ الصوت المحلّيّ غاب هذا
 *  المكوّنُ كلُّه — لا عقدةَ ولا تأثيرَ ولا لمسةَ لواجهة الصوت.
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
import { READ_ALOUD_AVAILABLE } from "@/lib/browser-voice/mode";
import { getReadAloud, IDLE_STATE, type ReadAloudError, type ReadAloudState } from "@/lib/browser-voice/read-aloud";
import { isSupportedSpeechLanguage, toSpeechText } from "@/lib/browser-voice/speech-text";


/** سببُ العطب ⇒ مفتاحُه في القاموس — يُترجَم عند الرسم، فيتبع لغةَ الواجهة إن تبدّلت */
const ERROR_TEXT = {
  unsupported: "readAloudUnsupported",
  no_voice_ar: "readAloudNoArabicVoice",
  no_voice_en: "readAloudNoEnglishVoice",
  device_only_ar: "readAloudDeviceOnlyArabic",
  device_only_en: "readAloudDeviceOnlyEnglish",
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
  if (!READ_ALOUD_AVAILABLE) return null;
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
  /** أالتركيزُ داخل سؤال الموافقة؟ — فيعود إلى السؤال إن أُعيد تركيبُ الزرّ وهو مفتوح */
  const promptFocused = useRef(false);
  const consentRef = useRef<HTMLDivElement | null>(null);
  /**
   * أقُرئ هذا الرد — في آخر قراءةٍ له — بصوتٍ ليس من أصوات الجهاز؟
   *
   * فيبقى زرُّ سحب الموافقة تحته بعد انتهاء القراءة: مَن أراد سحبَها لا يُضطرّ
   * إلى قراءة ردٍّ آخر بذلك الصوت ليجد الزرّ.
   */
  const [usedOffDevice, setUsedOffDevice] = useState(false);
  const noteId = useId();
  const consentId = useId();
  const consentTextId = useId();

  const state = useSyncExternalStore(readAloud.subscribe, readAloud.getSnapshot, idleOnServer);
  /** أهذا الزرُّ صاحبُ جلسةٍ واقفةٍ على سؤال الموافقة؟ */
  const asking = state.owner === owner && state.status === "consent";
  /** أيُقرأ هذا الرد الآن بصوتٍ ليس من أصوات الجهاز؟ */
  const offDeviceNow =
    state.owner === owner && (state.status === "loading" || state.status === "speaking") && state.networkVoice;

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
    // والتركيزُ داخل السؤال مثلُه على الزرّ: السؤالُ يُتبنّى مع جلسته، فيعود إليه
    return () => readAloud.release(owner, focused.current || promptFocused.current);
  }, [readAloud, owner, speechText, scope]);

  useEffect(() => {
    /**
     * السؤالُ ظهر: يُرى ويُبلَغ.
     *
     * إن كان التركيزُ ما زال على الزرّ انتقل إلى **السؤال نفسِه** (المجموعةُ
     * المسمّاةُ بنصّه) — لا إلى زرٍّ من زرَّيه: فيُقرأ السؤالُ لمن يستعمل قارئًا
     * آليًّا، ويدخل مجالَ الرؤية، ولا تصير ضغطةُ `Enter` ثانيةٌ قرارًا. وإن ذهب
     * التركيزُ إلى غيره (مَن عاد يكتب رسالتَه والسؤالُ تأخّر بانتظار قائمة
     * الأصوات) فلا يُنتزع منه: يُمرَّر السؤالُ إلى مجال الرؤية وحسب.
     */
    if (!asking) {
      // أُغلق السؤال: وما نُزع وهو مركَّز لا يُطلق `blur`، فتُصفَّر العلامةُ هنا
      promptFocused.current = false;
      return;
    }
    if (focused.current) consentRef.current?.focus();
    else consentRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [asking]);

  useEffect(() => {
    if (offDeviceNow) setUsedOffDevice(true);
  }, [offDeviceNow]);

  // ردٌّ ليس فيه ما يُقرأ (كودٌ كلُّه): لا زرَّ يَعِد بما لا يكون
  if (!speechText) return null;

  const mine = state.owner === owner;
  const active = mine && (state.status === "loading" || state.status === "speaking");
  const failed = mine && state.status === "error" && state.error !== null;
  /** قراءةٌ لهذا الرد انتهت أو أوقفها المستخدم — لا عطب، ولا سؤالٌ لم يُجَب */
  const played = mine && !active && !failed && !asking;
  const noted = active && state.networkVoice;
  /** رفضَ ثم لم يجد بين أصوات الجهاز ما يُقرأ به: يُعرض عليه أن يغيّر اختيارَه */
  const refused = failed && (state.error === "device_only_ar" || state.error === "device_only_en");
  /** وافق وقُرئ هذا الرد بصوتٍ ليس من أصوات الجهاز — الآن أو للتوّ: له أن يسحب موافقتَه من هنا */
  const withdrawable = noted || (played && usedOffDevice);

  const label = active ? t("readAloudStop") : played ? t("readAloudReplay") : t("readAloudListen");
  const phase = asking ? "consent" : active ? state.status : failed ? "error" : played ? "ended" : "idle";

  /**
   * ★ يُسأل المُتحكِّمُ لحظةَ الضغط، لا ما رُسم.
   *
   * ضغطتان متلاحقتان قد تسبق ثانيتُهما إعادةَ الرسم. فلو حُكم بما في
   * الرسم لبدأت الثانيةُ جلسةً أخرى بدل أن توقف الأولى. والسؤالُ المفتوح
   * مثلُ القراءة الجارية: الضغطةُ الثانية تُلغيه، لا تسأل ثانيةً ولا توافق.
   */
  const engagedNow = () => {
    const now = readAloud.getSnapshot();
    return now.owner === owner && (now.status === "loading" || now.status === "speaking" || now.status === "consent");
  };
  /** يعود التركيزُ إلى الزرّ قبل أن يُنزع ما تحته: وإلا سقط إلى جسم الصفحة وضاع `Escape` */
  const returnFocus = () => buttonRef.current?.focus({ preventScroll: true });
  /** مفتاحٌ مضغوطٌ باستمرار لا يصير قرارًا: التكرارُ لا يضغط زرًّا */
  const ignoreKeyRepeat = (event: { repeat: boolean; key: string; preventDefault: () => void }) => {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
  };
  const choiceClass =
    "text-[11.5px] px-2 py-1 rounded-md border border-line text-ink-dim hover:text-ink hover:bg-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-read-aloud=""
        data-read-aloud-state={phase}
        aria-busy={active && state.status === "loading" ? true : undefined}
        aria-describedby={noted ? noteId : undefined}
        aria-expanded={asking ? true : undefined}
        aria-controls={asking ? consentId : undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onClick={() => {
          if (engagedNow()) {
            readAloud.stop();
            return;
          }
          setAttempt((n) => n + 1);
          setUsedOffDevice(false);
          readAloud.speak(owner, speechText, scope);
        }}
        onKeyDown={(event) => {
          // مفتاحٌ مضغوطٌ باستمرار لا يُبدّل بين القراءة والإيقاف عشرين مرّةً في الثانية
          if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
          else if (event.key === "Escape" && engagedNow()) readAloud.stop();
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
      {refused ? (
        <div data-read-aloud-choice="" className="order-last basis-full flex flex-wrap gap-1.5 mt-1">
          <button
            type="button"
            data-read-aloud-consent-action="reconsider"
            onKeyDown={ignoreKeyRepeat}
            onClick={() => {
              returnFocus();
              setAttempt((n) => n + 1);
              readAloud.reconsiderNetworkVoice(owner, speechText, scope);
            }}
            className={choiceClass}
          >
            {t("readAloudConsentReconsider")}
          </button>
        </div>
      ) : null}
      {asking ? (
        <div
          id={consentId}
          ref={consentRef}
          role="group"
          tabIndex={-1}
          aria-labelledby={consentTextId}
          data-read-aloud-consent=""
          onFocus={() => {
            promptFocused.current = true;
          }}
          onBlur={(event) => {
            // التنقّلُ بين زرَّي السؤال ليس خروجًا منه
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) promptFocused.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // إلغاءٌ بلا قرار: يعود التركيزُ إلى الزرّ، ويُسأل ثانيةً عند الضغطة التالية
            returnFocus();
            readAloud.stop();
          }}
          className="order-last basis-full flex flex-col gap-1.5 mt-1 rounded-md text-[12px] leading-relaxed text-ink-dim
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-glow"
        >
          <p id={consentTextId}>{t("readAloudConsentBody")}</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-read-aloud-consent-action="decline"
              onKeyDown={ignoreKeyRepeat}
              onClick={() => {
                returnFocus();
                setAttempt((n) => n + 1);
                readAloud.declineNetworkVoice(owner);
              }}
              className={choiceClass}
            >
              {t("readAloudConsentDecline")}
            </button>
            <button
              type="button"
              data-read-aloud-consent-action="allow"
              onKeyDown={ignoreKeyRepeat}
              onClick={() => {
                returnFocus();
                setAttempt((n) => n + 1);
                readAloud.allowNetworkVoice(owner);
              }}
              className={choiceClass}
            >
              {t("readAloudConsentAllow")}
            </button>
          </div>
        </div>
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
      {withdrawable ? (
        <div data-read-aloud-choice="" className="order-last basis-full flex flex-wrap gap-1.5 mt-1">
          <button
            type="button"
            data-read-aloud-consent-action="withdraw"
            onKeyDown={ignoreKeyRepeat}
            onClick={() => {
              returnFocus();
              setUsedOffDevice(false);
              readAloud.declineNetworkVoice(owner);
            }}
            className={choiceClass}
          >
            {t("readAloudConsentDecline")}
          </button>
        </div>
      ) : null}
    </>
  );
}
