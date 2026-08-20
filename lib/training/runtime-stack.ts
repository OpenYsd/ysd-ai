import "server-only";

/**
 * مكدّس تشغيل التدريب (v0.9.10، المرحلة 4B-1) — **مثبَّتٌ وغير مُتحقَّقٍ منه بعد**.
 *
 * ── ما ثبت من المصادر الرسمية ──
 *
 * (١) البنية: `config.json` عند المراجعة المثبَّتة يقول
 *     `architectures: ["GptOssForCausalLM"]` و`transformers_version: "4.55.0.dev0"`.
 *     فـTransformers دون 4.55 لا تعرف هذه البنية أصلًا.
 *
 * (٢) الضبط مدعوم: بطاقة النموذج الرسمية تقول «Fine-tunable»، وأن `20b`
 *     يُضبط على عتادٍ استهلاكيّ و`120b` على عقدة H100 واحدة.
 *
 * (٣) والمسار: `huggingface/trl` يحمل `examples/scripts/sft_gpt_oss.py`
 *     رسميًّا — يستورد `Mxfp4Config` من Transformers، و`SFTTrainer` و
 *     `get_peft_config` من TRL، ويطلب حزمة `kernels`.
 *
 * (٤) و**المهمّ**: ذلك المثال يمرّر `Mxfp4Config(dequantize=True)`. أي أن
 *     أوزان الخبراء المضغوطة MXFP4 **تُفكّ إلى bf16 قبل التدريب**. فرقمُ
 *     «١٦ ج.ب» في البطاقة رقمُ **استدلال** لا تدريب: عشرون مليار معامل في
 *     بايتين ≈ ٤٢ ج.ب للأوزان وحدها، قبل حالة المُحسِّن والتنشيطات.
 *
 *     ومن هنا جاء اختيار A100-80GB: لا لأنه الأفضل، بل لأنه أوّل حجمٍ
 *     يتّسع لِما نعرف أنه سيقع.
 *
 * ── وما لم يثبت — ويُقال ولا يُبتلع ──
 *
 * أن هذه النسخ **بعينها** تعمل معًا لـgpt-oss. كلٌّ منها إصدارٌ منشور
 * تحقّقتُ من وجوده، والمثال الرسميّ يعيش على `main` من TRL لا على إصدارٍ
 * مرقَّم. فالتوافق دعوى تحتاج تشغيلًا يُثبتها، ولم يقع.
 *
 * ولذلك `verified: false` — وحارس الجاهزية يمنع التنفيذ بها. وتحويلُها
 * إلى `true` عملٌ يُفعل: تشغيلةٌ واحدة تنجح، لا سطرٌ يُبدَّل.
 *
 * ولو كتبتُ `verified: true` اليوم لكانت دعوى لا يسندها شيء — وهي أخطر من
 * غيابها، لأن من يقرؤها يبني عليها.
 */

/** نسخة عقد المكدّس — تُرفع إن تغيّرت النسخ أو معناها */
export const RUNTIME_STACK_VERSION = "ysd-training-runtime-v1";

export interface RuntimeStack {
  version: string;
  python: string;
  /**
   * ★ نسخٌ مثبَّتة — ولا `latest` ولا `main`.
   *
   * فمكدّسٌ يقول «الأحدث» يبني اليوم شيئًا وغدًا آخر، ويجعل «أعِد إنتاج
   * هذا التدريب» جملةً بلا معنى.
   */
  packages: Readonly<Record<string, string>>;
  /**
   * ★ هل جُرِّب هذا المكدّس فعلًا على gpt-oss؟
   *
   * `false` تعني: النسخ موجودة، والتوافق لم يُثبَت. وحارس الجاهزية يمنع
   * التنفيذ حتى يُثبَت.
   */
  verified: boolean;
  /** ما استندنا إليه — أسماءُ مصادر لا عناوينُ اعتماد */
  evidence: readonly string[];
}

export const TRAINING_RUNTIME_STACK: RuntimeStack = {
  version: RUNTIME_STACK_VERSION,
  python: "3.11",
  packages: Object.freeze({
    torch: "2.13.0",
    transformers: "5.15.1",
    trl: "1.10.0",
    peft: "0.20.0",
    accelerate: "1.14.0",
    datasets: "5.0.1",
    /** يطلبها المثال الرسميّ صراحةً لنواة MoE */
    kernels: "0.10.3",
  }),
  verified: false,
  evidence: Object.freeze([
    "openai/gpt-oss-20b@6cee5e8 config.json: GptOssForCausalLM, transformers_version 4.55.0.dev0",
    "openai/gpt-oss-20b@6cee5e8 model card: fine-tunable; 20b on consumer hardware",
    "huggingface/trl examples/scripts/sft_gpt_oss.py: SFTTrainer + get_peft_config + Mxfp4Config(dequantize=True)",
    "pypi.org: every pinned version exists as a published release",
  ]),
};

/** أدنى نسخةٍ تعرف بنية `GptOssForCausalLM` — من `config.json` نفسه */
export const MIN_TRANSFORMERS_MAJOR_MINOR = "4.55";

/**
 * ★ صيغةٌ معياريّة للمكدّس — مرتَّبةٌ فرضًا لا عَرَضًا.
 *
 * والمفاتيح تُرتَّب أبجديًّا صراحةً: ترتيبُ كتابتها عَرَضٌ يتغيّر في أوّل
 * مراجعة، فتتغيّر كل بصمةٍ قديمة بلا أن يتغيّر مكدّس.
 */
export function canonicalRuntimeStack(stack: RuntimeStack = TRAINING_RUNTIME_STACK): string {
  const names = Object.keys(stack.packages).sort();
  const lines = [
    `runtimeVersion\t${stack.version}`,
    `python\t${stack.python}`,
    ...names.map((n) => `pkg\t${n}\t${stack.packages[n]}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** ولا نسخةَ تعني «الأحدث» — حارسٌ على القيم نفسها لا على نيّة كاتبها */
const MOVING = /^(latest|main|master|nightly|dev|\*|)$/i;

export function isPinnedVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (MOVING.test(value.trim())) return false;
  return /^\d+\.\d+(\.\d+)?([.-]?[A-Za-z0-9]+)?$/.test(value.trim());
}

export function isStackPinned(stack: RuntimeStack = TRAINING_RUNTIME_STACK): boolean {
  return (
    isPinnedVersion(stack.python) &&
    Object.values(stack.packages).every((v) => isPinnedVersion(v))
  );
}
