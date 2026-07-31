/**
 * حالة التسجيل المشتقّة (v0.8.0) — مصدر واحد للواجهة والخادم.
 *
 * المشرف كان يرى منطقيّتين منفصلتين (require_invite وallow_registration)
 * وعليه أن يستنتج الأثر النهائي بنفسه — وتركيبة `require_invite=false` مع
 * `allow_registration=false` تعني «مغلق» وهو ما لا يقوله أي من الاسمين.
 * الحالة المشتقّة تُحسب هنا مرة واحدة وتُعرض نصًّا صريحًا.
 *
 * المنطق مطابق لما يفرضه handle_new_user في ترحيل 0021 — والإنفاذ الحقيقي
 * هناك، وهذا للعرض والرسائل فقط.
 */

export type RegistrationMode = "invite_only" | "open" | "closed";

/**
 * @param requireInvite قيمة platform_settings.require_invite (غيابها ⇒ true)
 * @param allowRegistration قيمة allow_registration (غيابها ⇒ false — فشل مغلق)
 */
export function deriveRegistrationMode(
  requireInvite: boolean | null | undefined,
  allowRegistration: boolean | null | undefined,
): RegistrationMode {
  // الدعوة تسبق كل شيء: مفعّلة ⇒ invite_only أيًّا كانت allow_registration
  if (requireInvite ?? true) return "invite_only";
  // بلا دعوة: الفتح صريح أو لا تسجيل. الغياب يفشل مغلقًا — إعداد متناقض
  // (ألغيت الدعوة ولم تفتح التسجيل) الرفض فيه أسلم من الفتح.
  return (allowRegistration ?? false) ? "open" : "closed";
}

export const REGISTRATION_MODE_LABEL: Record<RegistrationMode, string> = {
  open: "التسجيل مفتوح",
  invite_only: "التسجيل بالدعوة فقط",
  closed: "التسجيل مغلق",
};

export const REGISTRATION_MODE_HINT: Record<RegistrationMode, string> = {
  open: "أي زائر يستطيع إنشاء حساب دون دعوة.",
  invite_only: "لا يُنشأ حساب إلا بدعوة صالحة — ولو كان «السماح بالتسجيل المفتوح» مفعّلًا.",
  closed: "لا يُنشأ أي حساب جديد، بما في ذلك عبر لوحة الإدارة.",
};

/**
 * رموز فشل التسجيل — مجموعة مغلقة.
 *
 * استثناءات plpgsql تصل من GoTrue كـ500 بجسم فارغ، فلو عُرضت كما هي لرأى
 * المستخدم «خطأ في الخادم» على خطأ مدخلات مفهوم. التحويل هنا يجعل كل حالة
 * متوقّعة رسالةً عربية، ولا يخرج منه اسم دالة ولا قيد ولا SQL ولا stack trace.
 */
export type SignupErrorCode =
  | "registration_closed"
  | "invite_required_or_invalid"
  | "consent_required"
  | "email_invalid"
  | "password_weak"
  | "email_exists"
  | "rate_limited"
  | "unknown";

export const SIGNUP_ERROR_MESSAGE: Record<SignupErrorCode, string> = {
  registration_closed: "التسجيل مغلق حاليًا.",
  invite_required_or_invalid: "رمز الدعوة غير صالح أو انتهت صلاحيته.",
  consent_required: "يلزم الموافقة على الشروط وسياسة الخصوصية.",
  email_invalid: "البريد الإلكتروني غير صالح.",
  password_weak: "كلمة المرور ضعيفة — استخدم 8 أحرف على الأقل.",
  email_exists: "هذا البريد مسجَّل بالفعل.",
  rate_limited: "محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة.",
  unknown: "تعذّر إنشاء الحساب. حاول مرة أخرى.",
};

/** ما يصل من Supabase Auth — نقرأ منه الرمز والحالة فقط */
export interface RawAuthFailure {
  status?: number | null;
  code?: string | null;
  message?: string | null;
}

/**
 * يحوّل فشل Auth إلى رمز آمن.
 *
 * استثناءات المُحفّز تصل بـ500 ورسالة فارغة أو نصّ قاعدة، فنبحث عن اسم
 * الاستثناء داخلها. وما لا نعرفه يصير "unknown" — لا يُمرَّر نصّ المزوّد.
 */
export function classifySignupError(err: RawAuthFailure | null | undefined): SignupErrorCode {
  if (!err) return "unknown";
  const code = String(err.code ?? "").toLowerCase();
  const msg = String(err.message ?? "").toLowerCase();
  const status = err.status ?? 0;

  if (status === 429 || code.includes("rate_limit")) return "rate_limited";
  if (code === "email_exists" || code === "user_already_exists" || status === 422) {
    return "email_exists";
  }
  if (code === "email_address_invalid" || code === "validation_failed") return "email_invalid";
  if (code === "weak_password" || msg.includes("password")) return "password_weak";

  // استثناءات المُحفّز — الاسم وحده يعبر، لا نصّ القاعدة
  if (msg.includes("registration_closed")) return "registration_closed";
  if (msg.includes("invite_required_or_invalid")) return "invite_required_or_invalid";
  if (msg.includes("consent_required")) return "consent_required";

  return "unknown";
}
