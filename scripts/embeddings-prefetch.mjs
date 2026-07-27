#!/usr/bin/env node
/**
 * تنزيل نموذج Embeddings إلى كاش ثابت — يُشغَّل **وقت بناء الصورة**.
 *
 *   npm run embeddings:prefetch
 *
 * السبب: نظام ملفات الحاويات السحابية زائل. بدون هذا يُنزَّل النموذج (~112MB)
 * عند أول طلب RAG بعد كل نشر أو إعادة تشغيل — تأخير ~18ث على مستخدم حقيقي،
 * واعتماد على الإنترنت في مسار حيّ. بخبزه في الصورة: أول RAG بلا أي تنزيل.
 *
 * المسار من YSD_MODEL_CACHE (أو ./.cache/transformers محليًا). يجب أن يطابق
 * ما يقرؤه lib/rag/embeddings.ts وقت التشغيل.
 *
 * **يفشل بصوت عالٍ**: لو لم يكتمل التنزيل نُنهي بخطأ فيفشل البناء، بدل صورة
 * تُبنى بنجاح ثم تنكسر عند أول استخدام للمستخدم.
 */
import fs from "node:fs";
import path from "node:path";

const MODEL_ID = "Xenova/multilingual-e5-small";
const DIMS = 384;

const cacheDir = process.env.YSD_MODEL_CACHE
  ? path.resolve(process.env.YSD_MODEL_CACHE)
  : path.resolve(".cache/transformers");

console.log(`[prefetch] النموذج: ${MODEL_ID}`);
console.log(`[prefetch] الكاش:   ${cacheDir}`);

fs.mkdirSync(cacheDir, { recursive: true });

const { pipeline, env } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;
// السماح بالتنزيل هنا صراحةً — هذه هي اللحظة الوحيدة المسموح فيها
env.allowRemoteModels = true;

let extractor;
try {
  extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
} catch (err) {
  console.error(`[prefetch] فشل التنزيل: ${err?.message ?? err}`);
  process.exit(1);
}

// تحقّق وظيفي لا مجرّد وجود ملفات: نولّد متجهًا فعليًا ونتأكد من أبعاده
try {
  const out = await extractor("اختبار", { pooling: "mean", normalize: true });
  const dims = out?.dims?.[out.dims.length - 1] ?? out?.data?.length;
  if (dims !== DIMS) {
    console.error(`[prefetch] أبعاد غير متوقعة: ${dims} (المتوقع ${DIMS})`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[prefetch] فشل التحقق الوظيفي: ${err?.message ?? err}`);
  process.exit(1);
}

// تحقّق أن الملفات كُتبت فعلًا في الكاش
const bytes = (function size(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? size(p) : fs.statSync(p).size;
  }
  return total;
})(cacheDir);

const MB = bytes / (1024 * 1024);
if (MB < 20) {
  console.error(`[prefetch] الكاش أصغر من المتوقع (${MB.toFixed(1)}MB) — تنزيل ناقص`);
  process.exit(1);
}

console.log(`[prefetch] تم ✅ — ${MB.toFixed(1)}MB · ${DIMS} بُعدًا`);
