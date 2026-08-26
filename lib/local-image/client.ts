/**
 * عميلُ المحرّك المحلّيّ — من المتصفّح إلى جهاز المستخدم مباشرةً.
 *
 * ── ما لا يمرّ من هنا ──
 *
 * ★ لا شيءَ يذهب إلى خادم YSD.
 *
 * الطلبُ يخرج من الصفحة إلى `127.0.0.1` ولا يمرّ بخادمنا أصلًا. فالوصفُ
 * والبذرةُ والبايتاتُ تبقى في الجهاز بحكم الطريق لا بحكم الوعد.
 *
 * ── ولا سقوطَ إلى السحابة ──
 *
 * كلُّ خطأٍ هنا يُترجم إلى رسالةٍ محلّية. ولا مسارَ في هذا الملفّ يقود إلى
 * مزوّدٍ مدفوع — وهي أكثرُ اللحظات إغراءً بذلك: المستخدمُ ينتظر صورةً
 * والمحرّكُ لا يعمل.
 */

import { LOCAL_ENGINE_ORIGIN } from "./flag";

export type EngineStatus =
  | "connected"
  | "not_running"
  | "unverified_hardware"
  | "insufficient_resources"
  | "unauthorized";

export interface EnginePreset {
  width: number;
  height: number;
  steps: number;
  label: string;
  warning?: string;
  measuredSpillMb?: number;
}

export interface EngineCapabilities {
  status: EngineStatus;
  /** أرقامٌ مجمّعة فقط — لا اسمَ جهازٍ ولا رقمَ تسلسليّ ولا مسار */
  hardware?: { vendor: string; vramTotal: number; vramFree: number; ramTotal: number; ramFree: number };
  profile?: { id: string; eligible: boolean; reasons: string[]; referenceDeviceTested?: string; eligibilityBasis?: string };
  presets?: { default: EnginePreset | null; quality: EnginePreset | null };
  message?: string;
}

/**
 * مهلةُ الحياة قصيرة: محرّكٌ غيرُ عاملٍ يجب أن يُعرف بسرعة لا أن يُعلّق الواجهة.
 * و`/health` لا يقرأ عتادًا ولا يلمس البطاقة، فيردّ في مِلّي‌ثوانٍ.
 */
const HEALTH_TIMEOUT_MS = 2500;

/**
 * ★ ومهلةُ القدرات أطول — لأنّها تقيس الجهاز فعلًا.
 *
 * `/capabilities` يقرأ ذاكرةَ البطاقة الحرّة ويسأل العاملَ عن حالته. وقد
 * كان يقرأ سجلَّ التعريف عبر PowerShell في كلّ نداء فيبلغ 3.1 ثانية.
 *
 * وكانت المهلةُ الواحدة (2.5 ث) تُجهِض ذلك الطلبَ فتقول الواجهةُ «المحرّكُ
 * لا يعمل» — وهو يعمل ويردّ على `/health` في ثلاثِ مِلّي‌ثوان. أي أنّ
 * تشخيصًا كاذبًا وُلد من مهلةٍ واحدةٍ فُرضت على نداءين مختلفَي الطبيعة.
 *
 * وقد عولج الجذرُ في المحرّك (تُخبَّأ قراءةُ العتاد)، ويبقى هذا الفصلُ
 * حارسًا: أوّلُ نداءٍ بعد الإقلاع يظلّ أبطأ من البقيّة.
 */
const CAPABILITIES_TIMEOUT_MS = 15_000;
const GENERATE_TIMEOUT_MS = 300_000;

/**
 * ★ محاولةٌ ثانية للفحص وحده — ومهلتُها أطول.
 *
 * ── العطبُ المقيس ──
 *
 * أوّلُ نداءٍ من صفحةِ HTTPS إلى الحلقة المحلّية يستلزم تفاوضَ
 * Private Network Access. وقد رُصد على التجربة: المحاولةُ الأولى تُجهَض
 * عند 2.5 ث فتقول الواجهةُ «المحرّكُ لا يعمل» — والمحرّكُ سليم، وما إن
 * يتمّ التفاوضُ حتى تعود النداءاتُ في 4–71 مِلّي‌ثانية.
 *
 * ★ ولماذا لا يكفي إطالةُ المهلة وحدها؟
 *
 * لأنّ الإجهاضَ يُلغي التفاوضَ في منتصفه، فلا يُخبَّأ شيء. فمهلةٌ واحدة
 * طويلة تُصلح الحالةَ الباردة لكنها تُبطئ كلَّ فشلٍ آخر بلا داعٍ.
 *
 * ★ ولماذا لا تُطال المحاولةُ الأولى؟
 *
 * لأنّ الحالةَ الشائعة — محرّكٌ غيرُ مثبَّت — تفشل برفضِ اتّصالٍ فوريّ لا
 * بمهلة. فالأولى تبقى قصيرةً ليظلّ ذلك الجوابُ سريعًا، والثانيةُ تُعطى
 * سعةً للتفاوض البارد وحده.
 *
 * والحدُّ الأقصى للانتظار مقيّد: 2500 + 200 + 6000 = 8.7 ثانية، ولا
 * يقع إلا حين يكون ثمّة من يستمع ويتباطأ.
 */
const HEALTH_RETRY_TIMEOUT_MS = 6000;
const HEALTH_RETRY_DELAY_MS = 200;
/** ★ محاولتان لا ثالثة — ولا حلقةَ إعادةٍ تُطيل الانتظار بلا سقف */
const HEALTH_MAX_ATTEMPTS = 2;

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${LOCAL_ENGINE_ORIGIN}${path}`, { ...init, signal: ctrl.signal, mode: "cors" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * فحصُ الحياة — بلا رمز.
 *
 * ولمَ منفصلٌ عن القدرات؟ لأنّ «المحرّك لا يعمل» و«الرمزُ خطأ» حالتان
 * مختلفتان تمامًا في العلاج، وخلطُهما يُرسل المستخدمَ في طريقٍ خطأ.
 */
export async function probeEngine(): Promise<boolean> {
  const timeouts = [HEALTH_TIMEOUT_MS, HEALTH_RETRY_TIMEOUT_MS];
  for (let attempt = 0; attempt < HEALTH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await call("/health", { method: "GET" }, timeouts[attempt] ?? HEALTH_TIMEOUT_MS);
      /**
       * ★ ردٌّ وصل ⇒ لا إعادة، مهما كان رمزُه.
       *
       * الإعادةُ لأجل عطبِ الوصول لا لأجل جوابِ التطبيق. فرمزٌ مثل 401 أو
       * 403 أو 429 أو 503 جوابٌ صحيحٌ من محرّكٍ حيّ، وتكرارُه لا يغيّره —
       * وإنما يضاعف الانتظارَ ويُخفي السبب.
       */
      return res.ok;
    } catch {
      /**
       * لم يصل ردٌّ: إجهاضُ مهلة أو عطبُ شبكة. تُعاد المحاولةُ مرّةً واحدة
       * بمهلةٍ أوسع، ثم يُسلَّم بأنّ المحرّكَ لا يعمل.
       */
      const isLast = attempt === HEALTH_MAX_ATTEMPTS - 1;
      if (isLast) return false;
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_DELAY_MS));
    }
  }
  return false;
}

export async function fetchCapabilities(token: string): Promise<EngineCapabilities> {
  let res: Response;
  try {
    res = await call("/capabilities", { headers: { authorization: `Bearer ${token}` } }, CAPABILITIES_TIMEOUT_MS);
  } catch {
    return { status: "not_running", message: "YSD Local Engine is not running." };
  }
  if (res.status === 401) return { status: "unauthorized", message: "Local engine token is invalid." };
  if (!res.ok) return { status: "not_running", message: "YSD Local Engine is not responding." };

  const data = (await res.json()) as {
    hardware?: EngineCapabilities["hardware"];
    profile?: EngineCapabilities["profile"];
    imageGeneration?: { defaultResolution: EnginePreset | null; qualityResolution: EnginePreset | null };
  };

  if (!data.profile?.eligible) {
    return {
      status: "unverified_hardware",
      hardware: data.hardware,
      profile: data.profile,
      message: "Local image generation compatibility is not verified on this device.",
    };
  }
  return {
    status: "connected",
    hardware: data.hardware,
    profile: data.profile,
    presets: {
      default: data.imageGeneration?.defaultResolution ?? null,
      quality: data.imageGeneration?.qualityResolution ?? null,
    },
  };
}

export interface GenerateResult {
  ok: boolean;
  /** عنوانُ كائنٍ في المتصفّح — لا مسارَ ملفٍّ ولا رابطَ خادم */
  objectUrl?: string;
  ms?: number;
  seed?: number;
  width?: number;
  height?: number;
  error?: string;
  message?: string;
}

/**
 * ★ ترجمةُ أخطاء المحرّك إلى ما يفهمه المستخدم.
 *
 * ولا واحدةٌ منها تقترح بديلًا مدفوعًا — ولا «جرّب السحابة».
 */
export function messageForError(error: string | undefined, detail?: string): string {
  switch (error) {
    case "hardware_profile_unverified":
      return "Local image generation compatibility is not verified on this device.";
    case "insufficient_local_resources":
      return detail === "free_system_ram"
        ? "Not enough free system memory right now. Close some apps and try again."
        : "Not enough free GPU memory right now. Close GPU-heavy apps and try again.";
    case "resolution_not_calibrated":
      return "That size has not been calibrated for this device.";
    case "resource_probe_failed":
      return "Could not read this device's memory. The engine may need a restart.";
    /**
     * ★ رمزا الترجمة متمايزان لأنّ علاجَهما مختلف.
     *
     * «غيرُ مثبَّت» يُعالَج بتنزيل المترجم، و«فشلت» يُعالَج بإصلاحه أو
     * إعادةِ تنزيله. ورسالةٌ واحدة لهما تُرسل من عنده الملفّاتُ سليمةً
     * إلى إعادةِ تنزيلٍ لا تنفعه.
     *
     * ولا يقترح أيٌّ منهما ترجمةً سحابيّة — ولا YSD نفسها: الوصفُ يبقى
     * على الجهاز، وإرسالُه إلى خادمٍ لترجمته يخرق ذلك.
     */
    case "local_translation_model_not_installed":
      return "The local Arabic translator is not installed. Arabic prompts need it; English prompts work without it.";
    case "local_prompt_translation_failed":
      return "The local translator could not process this prompt. Try rephrasing, or reinstall the translator.";
    case "busy":
      return "A generation is already running. Wait for it to finish or cancel it.";
    case "cancelled":
      return "Generation cancelled.";
    case "timeout":
      return "Generation took too long and was stopped.";
    default:
      return "YSD Local Engine could not complete this request.";
  }
}

export async function generateLocally(
  token: string,
  body: { prompt: string; negative?: string; width: number; height: number; steps: number; seed?: number },
  signal?: AbortSignal,
): Promise<GenerateResult> {
  let res: Response;
  try {
    res = await call(
      "/generate",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
      GENERATE_TIMEOUT_MS,
    );
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return { ok: false, error: "cancelled", message: messageForError("cancelled") };
    return { ok: false, error: "engine_unreachable", message: "YSD Local Engine is not running." };
  }

  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string; id?: string; ms?: number; seed?: number; width?: number; height?: number };
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error ?? `http_${res.status}`, message: messageForError(data.error, data.detail) };
  }

  /**
   * ★ البايتاتُ تُجلب من المحرّك وتُحوَّل إلى عنوان كائنٍ في الذاكرة.
   *
   * ولا يُستعمل المسارُ المحلّيّ الذي يردّه المحرّك: المتصفّحُ لا يفتح
   * `file://` من صفحةٍ على الشبكة أصلًا، والأهمُّ أنّ مسارًا مطلقًا فيه
   * اسمُ المستخدم لا يليق أن يدخل الواجهةَ ولا أن يُخزَّن.
   */
  let objectUrl: string | undefined;
  try {
    const img = await call(`/image/${data.id}`, { headers: { authorization: `Bearer ${token}` } }, CAPABILITIES_TIMEOUT_MS);
    if (img.ok) objectUrl = URL.createObjectURL(await img.blob());
  } catch {
    /* تُترك غيرَ معرّفة — والواجهةُ تقول إنّ الصورة لم تُقرأ */
  }
  if (!objectUrl) return { ok: false, error: "image_unreadable", message: "The image was generated but could not be read back." };

  return { ok: true, objectUrl, ms: data.ms, seed: data.seed, width: data.width, height: data.height };
}
