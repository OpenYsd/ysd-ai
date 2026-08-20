import "server-only";

/**
 * النماذج الأساسية المسموح بها للتدريب (v0.9.8، المرحلة 4A).
 *
 * ── لماذا قائمةٌ في الشيفرة لا حقلٌ يُملأ ──
 *
 * لأن البديل أن يكتب أحدٌ في الواجهة عنوانًا أو مسارًا فيصير مصدرُ أوزانٍ
 * تُدرَّب عليها بيانات الناس شيئًا يختاره من يفتح الصفحة. والقائمة في
 * الشيفرة تمرّ من مراجعةٍ ودَفعٍ ونشر — والحقل لا يمرّ من شيء.
 *
 * ── وحدُّ إعادة الإنتاج يُقال ولا يُبتلع ──
 *
 * «مواصفةٌ قابلة لإعادة الإنتاج» وعدٌ يُقاس. وهو هنا **ناقص**، وذلك يُكتب
 * لا يُخفى: لا يملك المشروع اليوم — ولا يُظهر المصدر — مراجعةً ثابتة
 * (`revision`) ولا بصمةَ أوزانٍ لأيٍّ من هذه النماذج.
 *
 * فما تُثبته المواصفة: **أيّ اسمٍ من أيّ مصدر**. وما لا تُثبته: **أيّ
 * أوزانٍ بعينها** — لأن صاحب المستودع يستطيع أن يدفع نسخةً جديدة تحت الاسم
 * نفسه.
 *
 * ولو كتبنا رقم مراجعةٍ من عندنا لَكان أسوأ من غيابه: قيمةٌ تبدو دقيقة
 * ولا تشير إلى شيء. فتبقى `revision: null`، و`pinned` تقول الحقيقة،
 * و`validateTrainingJobForExecution` تمنع التنفيذ حتى تُثبَّت — وذلك شرطُ
 * المرحلة 4B لا هذه.
 */

export type BaseModelSource = "huggingface";

export interface BaseModelEntry {
  /** المفتاح الثابت في مواصفتنا — لا يتغيّر ولو تغيّر اسم المستودع */
  id: string;
  family: string;
  source: BaseModelSource;
  /** معرّف المستودع عند المصدر — اسمٌ لا عنوان */
  upstreamRef: string;
  /**
   * ★ المراجعة الثابتة — `null` حتى تُثبَّت.
   *
   * ولا تُملأ بتخمين: قيمةٌ تبدو دقيقة ولا تشير إلى شيء أسوأ من فراغٍ
   * معلوم.
   */
  revision: string | null;
  /** رخصةٌ معلومة — أو `null` إن لم نتحقّق منها بأنفسنا */
  license: string | null;
}

/**
 * ★ ولا عنوان، ولا مسار ملفّ، ولا سرّ.
 *
 * `upstreamRef` اسمُ مستودعٍ لا رابط: من يبني المُنفِّذ يركّب العنوان من
 * المصدر والاسم، فلا يستطيع أحدٌ توجيه التنزيل إلى مضيفٍ آخر بتبديل حقل.
 */
const CATALOG: readonly BaseModelEntry[] = [
  {
    id: "openai/gpt-oss-20b",
    family: "gpt-oss",
    source: "huggingface",
    upstreamRef: "openai/gpt-oss-20b",
    revision: null,
    license: "apache-2.0",
  },
  {
    id: "openai/gpt-oss-120b",
    family: "gpt-oss",
    source: "huggingface",
    upstreamRef: "openai/gpt-oss-120b",
    revision: null,
    license: "apache-2.0",
  },
];

/** ★ هل هذا النموذج مسموحٌ به **الآن**؟ */
export function findBaseModel(id: string): BaseModelEntry | null {
  return CATALOG.find((m) => m.id === id) ?? null;
}

export function listBaseModels(): readonly BaseModelEntry[] {
  return CATALOG;
}

/**
 * ★ هل هوّيةُ الأوزان مثبَّتة؟
 *
 * تُستعمل في حارس التنفيذ المستقبليّ: مواصفةٌ بلا مراجعةٍ ثابتة لا تُسلَّم
 * إلى مُنفِّذ — لأن ما سيُنزَّل قد لا يكون ما وُصف.
 */
export function isBaseModelPinned(entry: BaseModelEntry): boolean {
  return typeof entry.revision === "string" && entry.revision.length > 0;
}

/**
 * ★ الهوّية كما تدخل البصمة — مرتَّبةٌ فرضًا لا عَرَضًا.
 *
 * وتضمّ `revision` ولو كانت `null`: فيوم تُثبَّت تتغيّر البصمة، وذلك
 * صحيح — مواصفةٌ على أوزانٍ معلومة ليست مواصفةً على أوزانٍ مجهولة.
 */
export function canonicalBaseModel(entry: BaseModelEntry): string {
  return [
    entry.id,
    entry.source,
    entry.upstreamRef,
    entry.revision ?? "",
  ].join("\t");
}

/**
 * وصفٌ آمن للعرض — اسمٌ ومصدرٌ وحالُ التثبيت. ولا عنوان ولا رخصةَ يُدّعى
 * التحقّق منها.
 */
export function describeBaseModel(entry: BaseModelEntry): {
  id: string;
  family: string;
  source: string;
  pinned: boolean;
} {
  return {
    id: entry.id,
    family: entry.family,
    source: entry.source,
    pinned: isBaseModelPinned(entry),
  };
}
