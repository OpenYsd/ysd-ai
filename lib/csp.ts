/**
 * سياسة أمن المحتوى — بـ`nonce` لكل طلب (v0.9.17، المرحلة 6F).
 *
 * ── لماذا انتقلت من `next.config` إلى هنا ──
 *
 * السياسة في `headers()` تُبنى مرّةً عند البناء، فلا يمكن أن تحمل قيمةً
 * تتغيّر مع كل طلب. و`nonce` بلا تغيّرٍ ليس nonce — بل كلمةُ سرٍّ ثابتة
 * يقرؤها أوّلُ مهاجمٍ يفتح «مصدر الصفحة» ثم يوقّع بها ما يشاء.
 *
 * فصار البناءُ هنا، والاستدعاءُ من الوسيط الذي يرى كلَّ طلبٍ على حدة.
 *
 * ── وكيف يصل الـnonce إلى وسوم Next ──
 *
 * لا نكتبه بأيدينا على مكوّنات متفرّقة. الوسيط يضع السياسة في **ترويسة
 * الطلب**، وNext يقرؤها ويستخرج الـnonce ويضعه على كل وسمٍ يحقنه هو
 * (حمولة RSC، ومُقلِع الحزم). وهذا هو المسار الذي يدعمه الإطار — وما
 * يُضاف يدويًّا يفترق عنه يوم يتغيّر الإطار.
 *
 * ── وما لم يتغيّر ──
 *
 * `object-src 'none'` و`base-uri 'self'` و`frame-ancestors 'none'`
 * و`form-action 'self'` — وهي أعلى ما في السياسة قيمةً — كما كانت حرفًا
 * بحرف. هذه المرحلة تسحب `'unsafe-inline'` من `script-src` ولا تُرخي غيره.
 *
 * ── و`style-src` يبقى ──
 *
 * ما زال فيه `'unsafe-inline'`: أنماطُ Next وTailwind السطرية تحتاجه،
 * وسحبُه يحتاج عملًا مستقلًّا. والهدف هنا تنفيذُ الشيفرة لا التنسيق —
 * وقولُ ذلك أصدق من إيحاءٍ بأن السياسة أُحكمت كلُّها.
 */

/** ١٦ بايتًا = ١٢٨ بتًا من العشوائية المعمّاة — لا وقتٌ ولا `Math.random` */
const NONCE_BYTES = 16;

/**
 * يُولّد nonce لطلبٍ واحد.
 *
 * `crypto.getRandomValues` متاحٌ في بيئة Edge وفي Node معًا. ولا يُشتقّ من
 * وقتٍ ولا من عدّاد: قيمةٌ تُخمَّن ليست حاجزًا، وnonce مخمَّنٌ أسوأ من لا
 * شيء لأنه يُوهم بالحماية.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * مصادر Supabase — المتصفّح يخاطب GoTrue وPostgREST والتخزين مباشرةً،
 * فبلا هذا المصدر تسقط المصادقة كلُّها. والنطاق البديل محصورٌ بالمزوّد.
 */
function supabaseSources(rawUrl: string | undefined): string {
  const out = new Set(["https://*.supabase.co", "wss://*.supabase.co"]);
  try {
    if (rawUrl) {
      const { origin, host } = new URL(rawUrl);
      out.add(origin);
      out.add(`wss://${host}`);
    }
  } catch {
    /* إعدادٌ فاسد لا يُوسّع السياسة — يبقى نطاق المزوّد وحده */
  }
  return [...out].join(" ");
}

export interface CspOptions {
  /** التطوير وحده يحتاج `'unsafe-eval'` — والإنتاج لا يُمنحه «احتياطًا» */
  isDev?: boolean;
  supabaseUrl?: string | undefined;
}

export function buildContentSecurityPolicy(nonce: string, options: CspOptions = {}): string {
  const isDev = options.isDev ?? process.env.NODE_ENV !== "production";
  const supabase = supabaseSources(options.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL);

  /**
   * ★ `'unsafe-eval'` في التطوير وحده — وإعادةُ التحميل الساخنة تحتاجه.
   *
   * ولا `'strict-dynamic'`: هو يُلغي `'self'` في المتصفّحات المتوافقة، فيصير
   * كلُّ ما لا يُحمّله سكربتٌ موقَّع مرفوضًا. وذلك تشديدٌ حقيقيّ لكنه يحتاج
   * إثباتًا مستقلًّا — وسياسةٌ تُنشر بلا إثبات تُسقط التطبيق بلا JavaScript.
   */
  const script = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    // الأساس والكائنات والتأطير — أعلى قيمة أمنية في هذه السياسة
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    script,
    // خطوط Google تُستورَد من `globals.css` بـ@import
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // data: للصور المضمّنة، blob: لمعاينة ما يرفعه المستخدم قبل الحفظ
    `img-src 'self' data: blob: ${supabase}`,
    `connect-src 'self' ${supabase}`,
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** الترويسة التي يقرأ منها Next الـnonce ليضعه على وسومه */
export const CSP_HEADER = "content-security-policy";
/** وترويسةٌ صريحة للمكوّنات الخادمية التي تحتاجه مباشرةً */
export const NONCE_HEADER = "x-nonce";
