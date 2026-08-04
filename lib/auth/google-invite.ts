import { createHash } from "node:crypto";

/**
 * تسجيل Google بالدعوة — الثوابت والتطبيع المشتركة بين المسار والصفحة.
 *
 * التطبيع هنا **يجب أن يطابق** `public.normalized_email_hash` في ترحيل 0024.
 * لو تباعدا لصار كل تصريح غير قابل للاستهلاك: يُنشأ بهاش ويُبحث عنه بهاش آخر،
 * فيُرفض كل مستخدم بلا سبب مفهوم. اختبارٌ يثبّت تطابق النصّين.
 */

/** trim ثم lowercase — كما تفعل Google بالبريد */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** sha256 للبريد المُطبَّع — لا يُخزَّن البريد الخام إطلاقًا */
export function emailHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

/**
 * فحص صيغة بسيط — الغرض منع الإدخال العابث لا التحقق من التسليم.
 * Google هي المتحقّق الفعلي؛ أي تشدّد هنا يرفض بريدًا صالحًا بلا فائدة.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeEmail(email));
}

/** أجل التصريح — يطابق ما يفرضه 0024 سقفًا */
export const AUTHORIZATION_TTL_SECONDS = 600;

/**
 * كوكي «تسجيل Google جارٍ» — **علامة فقط، بلا بريد ولا كود ولا معرّف تصريح**.
 *
 * غايتها الوحيدة تمييز فشلٍ بعد تدفّق الدعوة عن فشلِ من لم يبدأه أصلًا: الأول
 * غالبًا اختار حساب Google خطأً فيستحق رسالة تقول ذلك، والثاني يستحق «اطلب
 * دعوة». القاعدة لا تفرّق بينهما — كلاهما «لا تصريح لهذا البريد».
 *
 * ولماذا كوكي لا شريط عنوان ولا localStorage: الأول يظهر للمستخدم ويصل سجلّات
 * المزوّد، والثاني يقرأه أي سكربت في الصفحة. الكوكي HttpOnly لا يقرأه سكربت،
 * ولا يحمل ما يُسرَّب أصلًا.
 *
 * SameSite=Lax مقصود: العودة من Google تنقّلٌ علوي بـGET، وLax يرسل الكوكي معه.
 * وStrict كان سيمنعه فتضيع العلامة في الحالة الوحيدة التي وُجدت لأجلها.
 */
export const GOOGLE_SIGNUP_PENDING_COOKIE = "ysd_gsp";

export function pendingCookie(value: "1" | "", maxAge: number): string {
  return [
    `${GOOGLE_SIGNUP_PENDING_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}
