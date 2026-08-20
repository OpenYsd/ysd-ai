import "server-only";

/**
 * النماذج الأساسية المسموح بها للتدريب (v0.9.9، المرحلة 4B-A).
 *
 * ── لماذا قائمةٌ في الشيفرة لا حقلٌ يُملأ ──
 *
 * لأن البديل أن يكتب أحدٌ في الواجهة عنوانًا أو مسارًا فيصير مصدرُ أوزانٍ
 * تُدرَّب عليها بيانات الناس شيئًا يختاره من يفتح الصفحة. والقائمة في
 * الشيفرة تمرّ من مراجعةٍ ودَفعٍ ونشر — والحقل لا يمرّ من شيء.
 *
 * ── وما تغيّر في هذه المرحلة ──
 *
 * كان الملفّ يقول إن حدّ إعادة الإنتاج **ناقص**: لا مراجعةَ ثابتة لأيّ
 * نموذج. وقد ثُبِّت أوّلها الآن — `openai/gpt-oss-20b` — بالتحقّق من
 * المستودع الرسميّ، لا نقلًا عن ذاكرة ولا عن نصّ طلب.
 *
 * و`120b` تبقى بلا مراجعة: التحقّق عملٌ يُفعل لا يُفترض، ولم يُفعل لها.
 *
 * ── ومعنى «مثبَّت» لا يُقاس بالطول ──
 *
 * كان الفحص `length > 0` — فـ`"main"` تمرّ. و`main` **مؤشّرٌ متحرّك**:
 * يشير اليوم إلى التزامةٍ وغدًا إلى أخرى. فمواصفةٌ تقول «دُرِّب على main»
 * لا تقول شيئًا. والفحص الآن على الشكل وعلى **قائمة ما تحقّقنا منه**.
 */

export type BaseModelSource = "huggingface";

/** التزامةُ Git كاملة — أربعون خانةً ستّ عشريّة، لا سبعٌ ولا اسمُ فرع */
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export interface BaseModelEntry {
  /** المفتاح الثابت في مواصفتنا — لا يتغيّر ولو تغيّر اسم المستودع */
  id: string;
  family: string;
  source: BaseModelSource;
  /** معرّف المستودع عند المصدر — اسمٌ لا عنوان */
  upstreamRef: string;

  /**
   * ★ المراجعة التي تأخذها مهمّةٌ **جديدة**.
   *
   * و`null` تعني: لم يُتحقَّق بعد. ولا تُملأ بتخمين — قيمةٌ تبدو دقيقة ولا
   * تشير إلى شيء أسوأ من فراغٍ معلوم.
   */
  defaultRevision: string | null;

  /**
   * ★ وما تحقّقنا منه — وهو غير الشكل.
   *
   * ── لماذا قائمةٌ لا قيمةٌ واحدة ──
   *
   * لأن مهمّةً بُنيت اليوم تحمل مراجعةَ اليوم، وقد يتقدّم الفهرس غدًا. فإن
   * اشترط حارس التنفيذ أن تساوي المراجعةُ المخزَّنة الفهرسَ الحاليّ، ماتت
   * كل مهمّةٍ قديمة مع أوّل تحديث — وهي صحيحةٌ تاريخيًّا لا خاطئة.
   *
   * وإن اكتفى بالشكل وحده، مرّت أيّ أربعين خانةً يكتبها أحد. والقائمة تفرّق
   * بين «سلسلةٍ تشبه التزامة» و«التزامةٍ رأيناها بأنفسنا في المستودع
   * الرسميّ».
   *
   * وإخراجُ مراجعةٍ منها فعلٌ مقصود: يقول إنها لم تعد صالحةً للتسليم.
   */
  verifiedRevisions: readonly string[];

  /** رخصةٌ تحقّقنا منها عند تلك المراجعة — أو `null` */
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
    /**
     * ★ مثبَّتة — وهذا ما تحقّقتُ منه من المستودع الرسميّ (2026-08-20):
     *
     *   المستودع    `openai/gpt-oss-20b` · المنظّمة `openai` · عامّ وغير مقيَّد
     *   المراجعة    تُحلّ إلى نفسها عند الاستعلام بها صراحةً
     *   وليست اسمًا  الفروع `[main]` والوسوم `[]` — ولا واحدٌ منها بهذا الاسم
     *   الملفّات    config · generation_config · tokenizer(+_config) ·
     *              model.safetensors.index · LICENSE · وثلاث شرائح أوزان
     *   الرخصة      apache-2.0، وملفّ LICENSE قائمٌ عند المراجعة نفسها
     *
     * والتحقّق بالوصف وحده: لم تُنزَّل بايتةُ أوزانٍ واحدة (نحو ١٢٫٨ ج.ب).
     * ويُعاد بـ`npm run verify:base-models` عند الحاجة — لا مع كل طلب.
     */
    defaultRevision: "6cee5e81ee83917806bbde320786a8fb61efebee",
    verifiedRevisions: ["6cee5e81ee83917806bbde320786a8fb61efebee"],
    license: "apache-2.0",
  },
  {
    id: "openai/gpt-oss-120b",
    family: "gpt-oss",
    source: "huggingface",
    upstreamRef: "openai/gpt-oss-120b",
    /**
     * ★ غير مثبَّتة — عمدًا.
     *
     * أوّل مسار تدريبٍ يُبنى على 20B، ولم يُتحقَّق من 120B. وتثبيتُها لأنها
     * «على الأرجح مثلها» ادّعاءُ عملٍ لم يُفعل.
     */
    defaultRevision: null,
    verifiedRevisions: [],
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
 * ★ هل هذه المراجعة تزامةٌ ثابتةٌ **تحقّقنا منها**؟
 *
 * وشرطان لا واحد: الشكل — أربعون خانةً ستّ عشريّة — والوجود في قائمة ما
 * رأيناه. فالأوّل يردّ `main` و`latest` والسبعَ خاناتٍ والعناوين؛ والثاني
 * يردّ أربعين خانةً كتبها أحدٌ من عنده.
 */
export function isVerifiedRevision(entry: BaseModelEntry, revision: unknown): boolean {
  if (typeof revision !== "string" || !COMMIT_SHA.test(revision)) return false;
  return entry.verifiedRevisions.includes(revision);
}

/**
 * ★ هل يُنشأ من هذا النموذج شيءٌ جديد؟
 *
 * أي: أله مراجعةٌ افتراضية مثبَّتة ومتحقَّق منها. ولا يُقاس بالطول —
 * `"main"` سلسلةٌ غير فارغة، وهي **أسوأ** من الفراغ: تُوهم بتثبيتٍ لم يقع.
 */
export function isBaseModelPinned(entry: BaseModelEntry): boolean {
  return isVerifiedRevision(entry, entry.defaultRevision);
}

/**
 * ★ الهوّية كما تدخل البصمة — مرتَّبةٌ فرضًا لا عَرَضًا.
 *
 * والمراجعة تُمرَّر صراحةً لا تُقرأ من الفهرس: البصمة تصف **ما وُقّع عليه**
 * في المهمّة، لا ما صار عليه الفهرس بعدها. ولو قُرئت من الفهرس لتغيّرت
 * بصمةُ مهمّةٍ قديمة كلّما تقدّم الفهرس — وهي لم تتغيّر.
 */
export function canonicalBaseModel(entry: BaseModelEntry, revision: string | null): string {
  return [entry.id, entry.source, entry.upstreamRef, revision ?? ""].join("\t");
}

/**
 * وصفٌ آمن للعرض — اسمٌ ومصدرٌ وحالُ التثبيت. ولا عنوان ولا مراجعةٌ تُعرض:
 * أربعون خانةً لا تقول لقارئٍ شيئًا، و«مثبَّت» تقول كل شيء.
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
