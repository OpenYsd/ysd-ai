/**
 * Allowlist النماذج المجانية المعتمدة على OpenRouter.
 *
 * لا نمرر "openrouter/free" (الموجّه العشوائي) للإنتاج أبدًا — بعض نماذجه
 * تُخرج ردودًا مختلطة اللغات. بدلًا منه: سلسلة نماذج مُختارة ومُختبرة فعليًا
 * مع العربية (بث حقيقي + قياس نقاء الأحرف ≥ 92٪ عربي).
 *
 * آخر تحقق: 2026-07-12 عبر scripts/probe-arabic-models.mjs
 * لإعادة التحقق أو تحديث القائمة عند تغيّر النماذج المجانية:
 *   node scripts/probe-arabic-models.mjs
 */

/** المعرّف المنطقي الظاهر في الواجهة — يُحل خادميًا إلى السلسلة أدناه */
export const YSD_FREE_MODEL_ID = "ysd/free";

/** أساسي ثم احتياطي أول ثم احتياطي ثانٍ */
export const FREE_MODEL_CHAIN: readonly string[] = [
  "google/gemma-4-31b-it:free", // عربي 93٪ · سياق 262k
  "openai/gpt-oss-120b:free", // عربي 92٪ · سياق 131k
  "nvidia/nemotron-3-super-120b-a12b:free", // عربي 95٪ · سياق 1M
];
