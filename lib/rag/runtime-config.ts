/**
 * إعدادات تشغيل RAG المركزية + وضع الذاكرة المنخفضة.
 * YSD_LOW_MEMORY=1 يقلّل المقاطع والدفعة والتزامن لخوادم محدودة الذاكرة.
 */

export interface RagRuntimeConfig {
  lowMemory: boolean;
  /** أقصى مقاطع تُعالَج لكل ملف (فوق حد الباقة يُقصّ) */
  maxChunksPerFile: number;
  /** حجم دفعة الإدراج/التضمين في قاعدة البيانات */
  embedDbBatch: number;
  /** التزامن داخل العملية (تسلسلي دائمًا = 1 لحماية الذاكرة) */
  concurrency: number;
  /** مهلة دفعة embedding (مللي ثانية) */
  embedTimeoutMs: number;
  /** مهلة اتصال الموفر الخارجي (مللي ثانية) */
  providerTimeoutMs: number;
}

const NORMAL: RagRuntimeConfig = {
  lowMemory: false,
  maxChunksPerFile: 200,
  embedDbBatch: 8,
  concurrency: 1,
  embedTimeoutMs: 120_000,
  providerTimeoutMs: 60_000,
};

const LOW_MEMORY: RagRuntimeConfig = {
  lowMemory: true,
  maxChunksPerFile: 80,
  embedDbBatch: 4,
  concurrency: 1,
  embedTimeoutMs: 180_000,
  providerTimeoutMs: 60_000,
};

let cached: RagRuntimeConfig | null = null;

export function getRagRuntimeConfig(): RagRuntimeConfig {
  if (cached) return cached;
  cached = process.env.YSD_LOW_MEMORY === "1" ? LOW_MEMORY : NORMAL;
  return cached;
}
