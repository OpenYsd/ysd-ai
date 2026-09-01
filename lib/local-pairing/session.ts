/**
 * رمزُ الجلسة — **في الذاكرة وحدَها**.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لا يُكتب في مخزنٍ ولا كعكةٍ ولا عنوان
 *
 *  رمزٌ محفوظٌ يُسرَق من نسخةٍ احتياطيّة، أو من قرصٍ مُستخرَج، أو من ملحقٍ
 *  يقرأ `localStorage`. وإحياؤه بعد إغلاق اللسان يعني أنّ إغلاقَ المتصفّح
 *  لا يُنهي شيئًا.
 *
 *  فما هنا متغيّرٌ في وحدةٍ: يموت بإغلاق اللسان، وبإعادة التحميل، وبانتهاء
 *  مهلته. وثمنُه أنّ إعادةَ التحميل تستدعي مصادقةً جديدة — وهي صامتةٌ
 *  بالمفتاح المحفوظ، فلا يراها المستخدم أصلًا.
 *
 *  ★ ولا يُطبع في سجلّ
 *
 *  وحتّى في الخطأ: الأخطاءُ تحمل تصنيفًا لا قيمة. فسجلُّ المتصفّح يُنسخ
 *  في تقارير الأعطال ويُلصق في المحادثات.
 * ══════════════════════════════════════════════════════════════════
 */

export interface ActiveSession {
  token: string;
  expiresAt: number;
  clientId: string;
  engineId: string;
  origin: string;
}

/**
 * ★ هامشٌ قبل الانتهاء.
 *
 * رمزٌ يبقى له ثانيتان قد ينتهي بين قرار الإرسال ووصول الطلب. فيُعدّ
 * منتهيًا مبكّرًا، فتقع المصادقةُ الجديدة قبل الفشل لا بعده.
 */
export const SESSION_RENEW_MARGIN_MS = 30_000;

let current: ActiveSession | null = null;

export function setSession(session: ActiveSession): void {
  current = session;
}

/** يعيد الجلسةَ الصالحةَ الآن — أو `null`. ولا يجدّد بنفسه. */
export function getSession(now: number = Date.now()): ActiveSession | null {
  if (!current) return null;
  if (current.expiresAt - SESSION_RENEW_MARGIN_MS <= now) return null;
  return current;
}

/** يعيد ما هو محفوظٌ بلا فحصِ مهلة — للتشخيص والاختبار وحدهما */
export function peekSession(): ActiveSession | null {
  return current;
}

export function clearSession(): void {
  current = null;
}

/**
 * أتخصُّ هذه الجلسةُ هذا المحرّكَ وهذا الاعتماد؟
 *
 * ★ فجلسةٌ صدرت لمحرّكٍ آخر لا تُستعمل هنا ولو كانت حيّة. والمحرّكُ
 *   سيرفضها على أيّ حال، لكنّ إرسالَها أصلًا يُسرّب رمزًا إلى طرفٍ لم
 *   يُصدره.
 */
export function sessionBelongsTo(engineId: string, clientId: string, now: number = Date.now()): boolean {
  const s = getSession(now);
  return Boolean(s && s.engineId === engineId && s.clientId === clientId);
}
