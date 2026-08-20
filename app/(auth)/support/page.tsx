import { SupportView } from "@/components/support/support-view";
import { readSupportContact, normalizeSupportTopic } from "@/lib/public-support";

/**
 * العنوان بلا لاحقة — `title.template` في التخطيط الجذريّ يضيف «— YSD AI».
 * وكتابتُها هنا أيضًا تُنتج «… — YSD AI — YSD AI» في تبويب المتصفّح.
 */
export const metadata = { title: "الدعم والمساعدة" };

/**
 * `/support` — عامّة بلا جلسة (مسجَّلة في `PUBLIC_PATHS` بالوسيط).
 *
 * من يُوقَف حسابه، أو تنقطع عنه الخدمة، أو يريد حذف بياناته — كلّهم
 * يحتاجون هذه الصفحة **قبل** أن يستطيعوا الدخول أو بعد أن مُنعوا منه.
 * فاشتراطُ جلسةٍ عليها يغلق البابَ في وجه من فُتح له أصلًا.
 *
 * ── و`?topic=` رمزٌ من مجموعةٍ مغلقة (المرحلة 6C) ──
 *
 * زرُّ «الإبلاغ عن مشكلة» في المحادثة يصل هنا بموضوعٍ يشرح السياق. والقيمة
 * **لا تُعرض أبدًا**: تُطابَق بقائمةٍ معروفة وتُترجم إلى نصٍّ من القاموس،
 * وما لا يطابق يُهمَل. فلا يُعكَس إلى الصفحة حرفٌ كتبه من فتح الرابط.
 */
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string | string[] }>;
}) {
  const { topic } = await searchParams;
  const raw = Array.isArray(topic) ? topic[0] : topic;
  return (
    <SupportView contact={readSupportContact()} topic={normalizeSupportTopic(raw)} />
  );
}
