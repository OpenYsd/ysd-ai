/**
 * نصوص أسطح الفشل (v0.9.12، المرحلة 6A) — **بلا استيرادٍ واحد**.
 *
 * ── لماذا لا تُقرأ من `lib/i18n.tsx` ──
 *
 * طبقة اللغة سياقُ React: تحتاج `I18nProvider` فوقها، و`useI18n` **ترمي**
 * إن غاب. وحدُّ الخطأ يُرسم بالضبط حين ينهار ما فوقه — و`global-error`
 * يحلّ محلّ التخطيط الجذريّ نفسه، فلا مزوّد هناك أصلًا.
 *
 * فصفحةُ خطأٍ تعتمد على السياق تصير خطأً داخل خطأ: تنهار وهي تعرض
 * الانهيار، فلا يرى المستخدم شيئًا إطلاقًا. وهذه الوحدة بيانات ودالّتان،
 * ولا تستورد شيئًا — فلا شيء فيها يمكن أن يسقط.
 *
 * وبقيّة المنتج تبقى على `lib/i18n.tsx` كما هي: هذا استثناءُ حدِّ الخطأ
 * وحده، لا مسارٌ ثانٍ للترجمة.
 */

export type FailureLocale = "ar" | "en";

/**
 * ★ العربية هي الافتراض، والإنجليزية تحتاج تصريحًا.
 *
 * نفس قاعدة `app/layout.tsx`: `=== "en"` وإلا `ar`. ولو اختلفت القاعدتان
 * لَرأى المستخدم صفحة خطأٍ بلغةٍ غير لغة التطبيق الذي كان يستعمله.
 */
export function normalizeFailureLocale(raw: string | null | undefined): FailureLocale {
  return raw === "en" ? "en" : "ar";
}

/**
 * يقرأ اللغة من الوثيقة — **ولا يرمي في أي حال**.
 *
 * `document.documentElement.lang` يكتبه التخطيط الجذريّ على الخادم قبل
 * الرسم، ويُحدّثه `setLocale` عند التبديل. فهو مصدرٌ حاضرٌ بلا سياق ولا
 * كوكي ولا رحلة. وخارج المتصفّح — أو لو غاب — تُرجَع العربية.
 */
export function readDocumentLocale(): FailureLocale {
  try {
    if (typeof document === "undefined") return "ar";
    return normalizeFailureLocale(document.documentElement.lang);
  } catch {
    return "ar";
  }
}

/** اتجاه الكتابة — يُشتق من اللغة، ولا يُقرأ من مكانٍ ثانٍ قد يخالفها */
export function failureDir(locale: FailureLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

interface Bilingual {
  readonly ar: string;
  readonly en: string;
}

/**
 * ★ ما يُقال، وما لا يُقال.
 *
 * لا رسالة استثناء، ولا `digest`، ولا أثر مكدّس، ولا اسم مزوّد، ولا اسم
 * متغيّر بيئة. المستخدم لا يملك أن يفعل بأيٍّ منها شيئًا، وكلّها تصف
 * الداخل لمن ليس من أهله.
 *
 * والنصّ يقول ما وقع وما العمل — لا أكثر.
 */
export const FAILURE_COPY = {
  errorTitle: {
    ar: "حدث خطأ غير متوقع",
    en: "Something went wrong",
  },
  errorBody: {
    ar: "تعذّر عرض هذه الصفحة. يمكنك المحاولة مرة أخرى، وإذا استمرت المشكلة فتواصل مع الدعم.",
    en: "This page could not be displayed. You can try again — and if the problem continues, contact support.",
  },
  notFoundTitle: {
    ar: "الصفحة غير موجودة",
    en: "Page not found",
  },
  notFoundBody: {
    ar: "الرابط الذي فتحته لا يشير إلى صفحة في YSD AI. تحقّق من الرابط أو ارجع إلى البداية.",
    en: "The link you opened does not point to a page in YSD AI. Check the address, or head back to the start.",
  },
  retry: { ar: "إعادة المحاولة", en: "Try again" },
  goHome: { ar: "العودة إلى YSD AI", en: "Back to YSD AI" },
  goSupport: { ar: "الدعم والمساعدة", en: "Help & support" },
  appName: { ar: "YSD AI", en: "YSD AI" },
} as const satisfies Record<string, Bilingual>;

export type FailureCopyKey = keyof typeof FAILURE_COPY;

/** يختار النصّ — دالّةٌ صغيرة تُغني عن `copy[k][locale]` في كل موضع */
export function failureText(key: FailureCopyKey, locale: FailureLocale): string {
  return FAILURE_COPY[key][locale];
}
