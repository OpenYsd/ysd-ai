import "server-only";

import { createHash } from "node:crypto";

import {
  canonicalBaseModel,
  findBaseModel,
  isBaseModelPinned,
  type BaseModelEntry,
} from "./base-models";

/**
 * مواصفة التدريب — صياغةٌ معياريّة وبصمة (v0.9.8، المرحلة 4A).
 *
 * ── ما هي المواصفة، وما ليست ──
 *
 * هي جوابٌ دقيقٌ لسؤال: **ماذا سيُدرَّب، على ماذا، وبأيّ أرقام؟** وليست
 * تشغيلًا: لا عتاد، ولا مزوّد، ولا أوزان تُحمَّل. وقيمتُها أن يستطيع أحدٌ
 * بعد سنة أن يقرأها فيعرف بالضبط ما جرى — أو ما كان سيجري.
 *
 * ── ولماذا إعداداتٌ مُسبَقة لا أرقامٌ من الواجهة ──
 *
 * أرقام التدريب ليست تفضيلًا: `epochs` كبيرة تُحفّظ النموذج عيّناتٍ بعينها
 * فيستطيع أن يُخرجها كما هي — أي أن رقمًا في حقلٍ يصير تسريبًا. فتُكتب
 * الأرقام في الشيفرة، وتمرّ من مراجعةٍ ودَفعٍ ونشر، ويختار المشرف **اسمًا**
 * لا قيمة.
 */

/**
 * ★ نسخة صيغة الإعداد — لا نسخة البرنامج.
 *
 * إن تغيّر شكل الأرقام أو معناها، صارت البصمات القديمة محسوبةً على عقدٍ
 * آخر. فتُرفع هذه، وتبقى مواصفةٌ قديمة مفهومةً بنسختها.
 */
export const TRAINING_CONFIG_VERSION = "ysd-training-config-v1";

/**
 * ★ طريقةٌ واحدة — ولا دعمَ وهميّ لعشر.
 *
 * ولم يُختَر مُنفِّذ بعد. فالمكتوب هنا ما نعرف أنّا سنشغّله إن شغّلنا:
 * ضبطٌ مُشرَف بمحوِّلات منخفضة الرتبة. وإضافةُ طريقةٍ ثانية يومًا إعدادٌ
 * جديد ورفعُ نسخة الصيغة — لا حقلٌ يُفتح اليوم لما لا يوجد.
 */
export type TrainingMethod = "lora_sft";

export interface TrainingHyperparameters {
  epochs: number;
  learningRate: number;
  batchSize: number;
  gradientAccumulation: number;
  maxSequenceLength: number;
  loraRank: number;
  loraAlpha: number;
  loraDropout: number;
}

export interface TrainingPreset {
  id: string;
  method: TrainingMethod;
  seed: number;
  hyperparameters: TrainingHyperparameters;
}

/**
 * ★ الإعدادات المُسبَقة — يملكها الخادم، ويختار المشرف اسمًا منها.
 *
 * والبذرة جزءٌ من الإعداد لا رقمٌ يُولَّد: بذرةٌ عشوائية تجعل تشغيلين على
 * المواصفة نفسها يختلفان، فتسقط دعوى إعادة الإنتاج من أوّل خطوة.
 */
const PRESETS: readonly TrainingPreset[] = [
  {
    id: "ysd-lora-v1",
    method: "lora_sft",
    seed: 20260820,
    hyperparameters: {
      /**
       * ★ دورةٌ واحدة — عمدًا.
       *
       * تكرارُ المرور على مجموعةٍ صغيرة يُحفّظ النموذج عيّناتها حرفًا حرفًا،
       * فيستطيع أن يُخرج كلام صاحبها كما كتبه. والبنك اليوم عيّنةٌ واحدة.
       */
      epochs: 1,
      learningRate: 0.0001,
      batchSize: 1,
      gradientAccumulation: 8,
      maxSequenceLength: 2048,
      loraRank: 16,
      loraAlpha: 32,
      loraDropout: 0.05,
    },
  },
];

export function findTrainingPreset(id: string): TrainingPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

export function listTrainingPresets(): readonly TrainingPreset[] {
  return PRESETS;
}

/**
 * ★ حدودٌ على الأرقام — ولو كانت من عندنا.
 *
 * فالإعدادات في الشيفرة اليوم، ومن يُضيف واحدًا غدًا قد يكتب رقمًا سهوًا.
 * والحدّ يمنع ما نعرف أنه خطأ: صفرٌ أو سالبٌ أو لا نهائيّ أو `NaN`، ودورةٌ
 * بالمئات تُحفّظ لا تُعلّم.
 */
const BOUNDS: Record<keyof TrainingHyperparameters, [number, number]> = {
  epochs: [1, 10],
  learningRate: [1e-6, 1e-2],
  batchSize: [1, 64],
  gradientAccumulation: [1, 128],
  maxSequenceLength: [128, 32768],
  loraRank: [1, 256],
  loraAlpha: [1, 512],
  loraDropout: [0, 0.5],
};

export type ConfigRejection =
  | "unknown_base_model"
  | "base_model_unpinned"
  | "unknown_preset"
  | "hyperparameter_out_of_range"
  | "invalid_seed";

/** ★ يتحقّق من إعدادٍ — ويفشل مغلقًا على كل ما ليس عددًا منتهيًا */
export function validateTrainingPreset(
  preset: TrainingPreset,
): { ok: true } | { ok: false; reason: ConfigRejection; field?: string } {
  if (!Number.isInteger(preset.seed) || preset.seed < 0 || preset.seed > 2_147_483_647) {
    return { ok: false, reason: "invalid_seed" };
  }
  for (const key of Object.keys(BOUNDS) as (keyof TrainingHyperparameters)[]) {
    const value = preset.hyperparameters[key];
    const [min, max] = BOUNDS[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      return { ok: false, reason: "hyperparameter_out_of_range", field: key };
    }
  }
  return { ok: true };
}

export interface TrainingSpecInput {
  /** بصمة بايتات الأثر — لا معرّفه: البايتات هي ما يُدرَّب عليه */
  artifactSha256: string;
  /** وبيان الإصدار — فالأثر يصف مجموعةً بعينها */
  releaseManifestHash: string;
  datasetVersion: string;
  datasetFormatVersion: string;
  sampleCount: number;
  baseModelId: string;
  presetId: string;
}

/**
 * ★ الصياغة المعياريّة — مفاتيحُ مرتَّبةٌ فرضًا لا عَرَضًا.
 *
 * ولا `JSON.stringify` لكائنٍ حرفيّ: ترتيبُ مفاتيحه عَرَضٌ من ترتيب كتابته،
 * يبقى ما بقي السطر ويتغيّر أوّل ما يُعاد ترتيبه في مراجعة — فتصير كل
 * البصمات القديمة خاطئة بلا أن تتغيّر مواصفةٌ واحدة.
 *
 * ── وما يدخل، وما لا يدخل ──
 *
 * يدخل ما يُحدّد **التدريب**: الأثر، والبيان، والنموذج الأساسيّ، والطريقة،
 * والأرقام، والبذرة، ونسخة الصيغة.
 *
 * ولا يدخل: `created_at`، ولا `created_by`، ولا معرّف المهمّة. فمواصفتان
 * كتبهما شخصان في يومين وتصفان التدريب نفسه **هما نفسها** — وبصمةٌ تختلف
 * لاختلاف الكاتب تُفقد القدرة على قول ذلك.
 */
export function buildCanonicalTrainingConfig(
  input: TrainingSpecInput,
  base: BaseModelEntry,
  preset: TrainingPreset,
  /**
   * ★ المراجعة صريحةٌ لا تُقرأ من الفهرس.
   *
   * فالبصمة تصف ما وُقّع عليه في المهمّة، لا ما صار عليه الفهرس بعدها.
   * ولو قُرئت من الفهرس لتغيّرت بصمةُ مهمّةٍ قديمة كلّما تقدّم — وهي لم
   * تتغيّر.
   */
  revision: string | null,
): string {
  const hp = preset.hyperparameters;
  /** الترتيب مكتوبٌ سطرًا سطرًا — ومن يغيّره يغيّر البصمة عن قصد */
  const lines = [
    `configVersion\t${TRAINING_CONFIG_VERSION}`,
    `artifactSha256\t${input.artifactSha256}`,
    `releaseManifestHash\t${input.releaseManifestHash}`,
    `datasetVersion\t${input.datasetVersion}`,
    `datasetFormatVersion\t${input.datasetFormatVersion}`,
    `sampleCount\t${input.sampleCount}`,
    `baseModel\t${canonicalBaseModel(base, revision)}`,
    `method\t${preset.method}`,
    `preset\t${preset.id}`,
    `seed\t${preset.seed}`,
    `epochs\t${hp.epochs}`,
    `learningRate\t${hp.learningRate}`,
    `batchSize\t${hp.batchSize}`,
    `gradientAccumulation\t${hp.gradientAccumulation}`,
    `maxSequenceLength\t${hp.maxSequenceLength}`,
    `loraRank\t${hp.loraRank}`,
    `loraAlpha\t${hp.loraAlpha}`,
    `loraDropout\t${hp.loraDropout}`,
  ];
  return `${lines.join("\n")}\n`;
}

/** بصمة المواصفة — sha256 على البايتات المعياريّة */
export function hashTrainingConfig(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type SpecResult =
  | {
      ok: true;
      base: BaseModelEntry;
      preset: TrainingPreset;
      /** المراجعة التي وُقّع عليها — تُنسخ إلى المهمّة */
      revision: string;
      canonical: string;
      configHash: string;
    }
  | { ok: false; reason: ConfigRejection; field?: string };

/**
 * ★ يبني مواصفةً كاملة — أو يرفض برمزٍ مغلق.
 *
 * والنموذج والإعداد يُقرآن من القائمتين لا من المُدخَل: ما يمرّره المستدعي
 * **اسمان**، وكلُّ ما عداهما يملكه الخادم.
 */
export function buildTrainingSpec(input: TrainingSpecInput): SpecResult {
  const base = findBaseModel(input.baseModelId);
  if (!base) return { ok: false, reason: "unknown_base_model" };

  const preset = findTrainingPreset(input.presetId);
  if (!preset) return { ok: false, reason: "unknown_preset" };

  const check = validateTrainingPreset(preset);
  if (!check.ok) return check;

  /**
   * ★ ولا يُبنى شيءٌ من نموذجٍ غير مثبَّت.
   *
   * فمواصفةٌ على أوزانٍ مجهولة مسوَّدةٌ ميّتة: تُنشأ اليوم ويردّها حارسُ
   * التنفيذ يومًا. والردّ عند الإنشاء أصدق — يقول للمشرف الآن ما سيُقال له
   * لاحقًا.
   */
  if (!isBaseModelPinned(base)) return { ok: false, reason: "base_model_unpinned" };

  /**
   * و`isBaseModelPinned` تضمن أنها سلسلة — والمحوّل لا يقرأ ذلك عبر دالّة.
   * فيُقرأ الحقل مرّةً ويُفحص، بدل تأكيدٍ بـ`!` يُخفي احتمالًا.
   */
  const revision = base.defaultRevision;
  if (revision === null) return { ok: false, reason: "base_model_unpinned" };
  const canonical = buildCanonicalTrainingConfig(input, base, preset, revision);
  return {
    ok: true,
    base,
    preset,
    revision,
    canonical,
    configHash: hashTrainingConfig(canonical),
  };
}
