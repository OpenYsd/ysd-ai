import { SupportView } from "@/components/support/support-view";
import { readSupportContact } from "@/lib/public-support";

export const metadata = { title: "الدعم والمساعدة — YSD AI" };

/**
 * `/support` — عامّة بلا جلسة (مسجَّلة في `PUBLIC_PATHS` بالوسيط).
 *
 * من يُوقَف حسابه، أو تنقطع عنه الخدمة، أو يريد حذف بياناته — كلّهم
 * يحتاجون هذه الصفحة **قبل** أن يستطيعوا الدخول أو بعد أن مُنعوا منه.
 * فاشتراطُ جلسةٍ عليها يغلق البابَ في وجه من فُتح له أصلًا.
 *
 * والوجهة تُقرأ على الخادم وتُمرَّر — فلا تبني الواجهة عنوانًا ولا تقرأ بيئة.
 */
export default function SupportPage() {
  return <SupportView contact={readSupportContact()} />;
}
