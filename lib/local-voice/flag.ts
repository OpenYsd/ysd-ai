/**
 * رايةُ الصوت المحلّيّ — مصدرٌ واحد للحقيقة.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ رايةُ وقتِ بناء، لا وقتِ تشغيل
 *
 *  `NEXT_PUBLIC_*` يستبدلها المُجمِّعُ نصًّا في حزمة المتصفّح. فضبطُها في
 *  لوحة الاستضافة **لا يكفي**: يجب أن تُمرَّر `--build-arg` ويُعاد البناء.
 *  وقد وقع ذلك فعلًا في رايةِ الصور (الطور 3H): رآها الخادمُ ولم يرَها
 *  المتصفّح، فبَدت اللوحةُ مضبوطةً والميزةُ غائبة.
 *
 *  ★ والاسمُ يُكتب حرفيًّا
 *
 *  `process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE` كاملًا، لا يُركَّب من أجزاء
 *  ولا يُقرأ من متغيّرٍ وسيط — فالاستبدالُ يقع على الشكل الحرفيّ وحده.
 * ══════════════════════════════════════════════════════════════════
 */
import { LOCAL_ENGINE_ORIGIN, LOCAL_ENGINE_PORT } from "@/lib/local-image/flag";

/**
 * ★ المنفذُ والأصلُ يُعادان من مكانهما، ولا يُكرَّران.
 *
 * فنسختان من العنوان تفترقان يومًا: تُصلَح إحداهما وتبقى الأخرى، فتفتح
 * السياسةُ عنوانًا ويطلب العميلُ آخر. والصوتُ يسكن المحرّكَ نفسَه.
 */
export { LOCAL_ENGINE_ORIGIN, LOCAL_ENGINE_PORT };

/**
 * ★ `"1"` حرفيًّا وحدها تُشعل.
 *
 * فقيمةٌ مثل `"false"` أو `"0"` أو فراغٌ تُبقيها مطفأة. والاكتفاءُ بوجود
 * المتغيّر يجعل `LOCAL_VOICE=false` يُشعلها — وهو عكسُ ما يقرؤه الناظر.
 */
const ENABLED_VALUE = "1";

/** اسمُ المتغيّر — يُذكر في الوثائق والاختبارات بلا تكرارِ الحرف */
export const LOCAL_VOICE_ENV_VAR = "NEXT_PUBLIC_YSD_LOCAL_VOICE";

/**
 * أمشتعلةٌ هي؟
 *
 * @param env بيئةٌ تُحقن صراحةً في الاختبارات؛ وبغيابها يُقرأ الشكلُ الحرفيّ.
 */
export function isLocalVoiceEnabled(env?: Record<string, string | undefined>): boolean {
  if (env) return env.NEXT_PUBLIC_YSD_LOCAL_VOICE === ENABLED_VALUE;
  return process.env.NEXT_PUBLIC_YSD_LOCAL_VOICE === ENABLED_VALUE;
}

/** مفتاحُ رمزِ المحرّك — هو نفسُه الذي تستعمله الصورُ، فلا رمزَ ثانٍ */
export { ENGINE_TOKEN_KEY } from "@/lib/local-image/flag";

/** حدودُ المحرّك كما يعلنها — تُكرَّر هنا للواجهة قبل أن تسأل */
export const MAX_RECORDING_MS = 60_000;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** لغاتُ النطق المسموحة — قائمةٌ مغلقة يطابقها المحرّك */
export const SPEAK_LANGUAGES = ["ar-SA", "en-US"] as const;
export type SpeakLanguage = (typeof SPEAK_LANGUAGES)[number];
