/**
 * وجهة الدعم العامّة (v0.9.12، المرحلة 6A) — **مصدرٌ واحد، ولا اختراع**.
 *
 * ── لماذا وحدة مستقلّة ──
 *
 * النصوص التي تقول للمستخدم «تواصل مع إدارة المنصة» موزّعة على صفحاتٍ
 * ومسارات. ولو كُتب العنوان في كلٍّ منها لصار تغييرُه يومًا بحثًا في
 * المستودع — وما يُنسى منه يبقى يرسل الناس إلى صندوقٍ لا يقرأه أحد.
 * فالوجهة تُقرأ من هنا وحدها، والصفحات تسأل ولا تعرف.
 *
 * ── ولماذا لا قيمة افتراضية ──
 *
 * عنوانٌ مخترع (`support@…`) أسوأ من لا عنوان: يبدو للمستخدم قناةً قائمة،
 * فيكتب شكواه ويصمت منتظرًا ردًّا من صندوقٍ غير موجود. وغيابُ الإعداد
 * يُقال صراحةً — `configured: false` — وتقول الواجهة الحقيقة بدله.
 *
 * ── ولماذا `NEXT_PUBLIC_` ──
 *
 * صفحة الدعم تُرسم في المتصفّح، فالوجهة تصل العميل حتمًا. وهي **عامّة
 * بطبيعتها**: عنوانٌ نريد أن يعرفه كل مستخدم. ولا يدخل هنا شيءٌ من أسرار
 * الخادم — لا مفتاح، ولا رابط خدمة، ولا متغيّر بيئةٍ خاصّ.
 *
 * والوصول ساكنٌ حرفيًّا (`process.env.NEXT_PUBLIC_YSD_SUPPORT_EMAIL`) لا
 * ديناميكيًّا: Next.js لا يحقن في حزمة المتصفح إلا الوصول الساكن، وقراءةٌ
 * بمفتاحٍ محسوب تُعيد `undefined` في العميل بلا أي خطأ يُنبّه.
 */

/** اسم المتغيّر — للتوثيق وللتقارير، لا للقراءة به */
export const SUPPORT_EMAIL_ENV = "NEXT_PUBLIC_YSD_SUPPORT_EMAIL";

/** مسار صفحة الدعم العامّة — يُشار إليه من هنا لا بنصٍّ مكرّر */
export const SUPPORT_PATH = "/support";

export interface SupportContact {
  /** هل ضُبطت وجهةٌ صالحة فعلًا؟ */
  configured: boolean;
  /** العنوان كما ضُبط — أو `null` */
  email: string | null;
  /** رابط `mailto:` جاهز — أو `null` */
  mailto: string | null;
}

/**
 * ★ تحقّقٌ متحفّظ — والمرفوض يُعامَل كغير مضبوط.
 *
 * الحدّ 254 حرفًا (سقف عنوان البريد)، والنمط يمنع الفراغ وسطر السطر
 * والزوايا والاقتباس — فلا يستطيع أحدٌ حقن ترويسةٍ في `mailto:` عبر قيمة
 * بيئة، ولا حقن وسمٍ في الصفحة.
 */
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

const UNCONFIGURED: SupportContact = Object.freeze({
  configured: false,
  email: null,
  mailto: null,
});

/**
 * يقرأ وجهة الدعم — أو يُعلن أنها غير مضبوطة.
 *
 * `raw` معاملٌ صريح ليختبَر بلا عبث ببيئة العملية؛ وقيمته الافتراضية هي
 * الوصول الساكن الوحيد في المشروع كلّه.
 */
export function readSupportContact(
  raw: string | undefined = process.env.NEXT_PUBLIC_YSD_SUPPORT_EMAIL,
): SupportContact {
  if (typeof raw !== "string") return UNCONFIGURED;
  const email = raw.trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return UNCONFIGURED;
  if (!EMAIL_PATTERN.test(email)) return UNCONFIGURED;
  return { configured: true, email, mailto: `mailto:${email}` };
}

/** هل تُعرض قناةُ تواصلٍ فعليّة؟ — سؤالٌ واحد تسأله كل واجهة */
export function isSupportConfigured(
  raw: string | undefined = process.env.NEXT_PUBLIC_YSD_SUPPORT_EMAIL,
): boolean {
  return readSupportContact(raw).configured;
}

/**
 * مواضيع الدعم — **مجموعة مغلقة** (v0.9.14، المرحلة 6C).
 *
 * ── لماذا لا نصّ حرّ ──
 *
 * `?topic=` يكتبه من يفتح الرابط. وعرضُه كما جاء يجعل الصفحة تردّد كلامَ
 * الغريب — وهي صفحةٌ عامّة يصل إليها من أُوقف حسابه، أي أخصبُ أرضٍ لرسالة
 * احتيالٍ مزروعة في رابط.
 *
 * فالقيمة تُطابَق بهذه القائمة، وتُترجم إلى نصٍّ من القاموس. وما لا يطابق
 * يصير `null` — ولا يُعكَس منه حرف.
 *
 * ── ولا يحمل الرابط من المحادثة شيئًا ──
 *
 * لا نصّ رسالة، ولا معرّف رسالة أو محادثة أو مستخدم، ولا اسم نموذج. ما
 * يُوضع في عنوانٍ يُسجَّل في وكلاء وسجلّاتِ خوادم لا نملكها.
 */
export const SUPPORT_TOPICS = ["bad-answer", "account-deletion"] as const;

export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/** يطابق الرمز بالقائمة — أو `null`، ولا يُعيد ما وصله أبدًا */
export function normalizeSupportTopic(raw: unknown): SupportTopic | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (SUPPORT_TOPICS as readonly string[]).includes(value)
    ? (value as SupportTopic)
    : null;
}
