export const metadata = { title: "سياسة الخصوصية — YSD AI" };

export default function PrivacyPage() {
  return (
    <article className="prose-invert max-w-none text-[13px] text-ink leading-relaxed space-y-3">
      <h1 className="text-lg font-semibold text-ink-strong">سياسة الخصوصية</h1>
      <p className="text-ink-faint text-[11px]">النسخة: 2026-07-15</p>
      <p>
        تحترم YSD AI خصوصيتك. توضّح هذه السياسة البيانات التي نجمعها وكيفية استخدامها خلال
        النسخة التجريبية الخاصة.
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">ما نجمعه</h2>
      <p>
        بريدك الإلكتروني واسمك الظاهر (للحساب)، ومحادثاتك وملفاتك (لتقديم الخدمة)، وبيانات
        استهلاك مجمّعة (رسائل، Tokens) لإدارة الحدود. لا نبيع بياناتك.
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">الملفات والمعالجة</h2>
      <p>
        تُخزَّن ملفاتك في تخزين خاص، وتُعالَج محليًا على خادمنا لتوليد البحث الدلالي دون إرسال
        محتواها لأي خدمة خارجية. رسائل المحادثة تُرسَل لموفّر النموذج لتوليد الرد.
      </p>
      <h2 className="text-[14px] font-medium text-ink-strong">حقوقك</h2>
      <p>
        يمكنك حذف محادثاتك وملفاتك في أي وقت، وطلب حذف بيانات حسابك عبر إدارة المنصة.
      </p>
      <p className="text-ink-faint">وثيقة مبدئية للنسخة التجريبية.</p>
    </article>
  );
}
