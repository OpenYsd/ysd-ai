import Link from "next/link";
import { LEGAL_BUNDLE_VERSION } from "@/lib/legal";

/**
 * العنوان بلا لاحقة — `title.template` في التخطيط الجذريّ يضيف «— YSD AI».
 * وكتابتُها هنا أيضًا تُنتج «… — YSD AI — YSD AI» في تبويب المتصفّح.
 */
export const metadata = { title: "شروط الاستخدام" };

/**
 * ★ النسخة من `lib/legal` لا نصًّا مكتوبًا (المرحلة 6E).
 *
 * كانت مكتوبةً هنا وفي الوثيقة الأخرى وفي الترحيل — ثلاثةُ مواضع يسهل
 * أن يُبدَّل أحدها ويبقى الباقي يعرض تاريخًا مضى. و`tests/v128` يطابق
 * هذا الثابت بقيمة الترحيل، فالانحراف يسقط بدل أن يمرّ.
 */
export default function TermsPage() {
  return (
    <article className="prose-invert max-w-none text-[13px] text-ink leading-relaxed space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong">شروط الاستخدام</h1>
      <p className="text-ink-faint text-[11px]">النسخة: {LEGAL_BUNDLE_VERSION}</p>
      <p>
        باستخدامك منصة YSD AI (النسخة التجريبية الخاصة) فإنك توافق على هذه الشروط. المنصة
        مقدَّمة «كما هي» خلال فترة التجربة، وقد تتغير الميزات أو تتوقف مؤقتًا.
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">الاستخدام المقبول</h2>
      <p>
        تلتزم بعدم إساءة استخدام المنصة، أو محاولة تجاوز حدود الاستخدام، أو رفع محتوى غير قانوني.
        قد يُعلَّق حسابك أو يُحظر عند مخالفة هذه الشروط. وإن رأيت أن ذلك وقع بالخطأ، فيمكنك
        مراجعتنا عبر{" "}
        <Link href="/support" className="text-primary-glow hover:brightness-125 transition-all">
          صفحة الدعم
        </Link>
        .
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">المحتوى والذكاء الاصطناعي</h2>
      <p>
        قد تحتوي مخرجات الذكاء الاصطناعي على أخطاء؛ تحقّق من المعلومات المهمة. أنت مسؤول عن
        الملفات التي ترفعها والمحتوى الذي تنشئه.
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">الحدود</h2>
      <p>
        تخضع الحسابات لحدود استخدام (رسائل، ملفات، تخزين) تُعرض في صفحة الاستهلاك، وقد تتغير خلال التجربة.
      </p>
      <p className="text-ink-faint">
        هذه وثيقة مبدئية للنسخة التجريبية وليست استشارة قانونية.
      </p>
    </article>
  );
}
