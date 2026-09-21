/**
 * فضاءات التضمين المتاحة للـRAG، والعَلَم الذي يختار بينها.
 *
 * ★ الافتراضي هو e5 كما كان — لا يتغيّر شيء إلا إذا اشتعل العَلَم صراحةً.
 *
 * ★ العَلَم `YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m` خاصّ بالتجريب (staging):
 *   • يُقرأ عند كل نداء (لا تخزين) فيتغيّر بإعادة التشغيل لا بإعادة البناء.
 *   • يُتجاهل — مع تحذير — إن كانت البيئة تسمّي نفسها production (RAILWAY_ENVIRONMENT_NAME).
 *     حارسٌ ثانٍ؛ الأول أن العَلَم لا يُضبط على خدمة الإنتاج أصلًا.
 *
 * ★ الفضاء الواحد يعني ملفّ متجهاتٍ واحدًا ودالة بحثٍ واحدة ووسمَ نموذجٍ واحدًا: الاستعلام والمقاطع
 *   يمرّان دائمًا بالفضاء نفسه لأن الفضاء يُحسم مرّةً واحدة لكل نداء ثم تُشتقّ منه الكتابة والقراءة معًا.
 */
import { F2LLM } from "./f2llm-manifest";

export type EmbeddingSpaceId = "e5" | "f2llm";

export const F2LLM_FLAG_ENV = "YSD_RAG_EMBEDDING_MODEL";
export const F2LLM_FLAG_VALUE = F2LLM.id;

/** نوع الوظيفة القائم — يصنع متجهات e5 */
export const RAG_JOB_TYPE_E5 = "rag_prepare";
/** نوع وظيفة فضاء F2LLM — مفتاح idempotency مستقلّ، فلا يمنع اكتمالُ وظيفة e5 تجهيزَ v2 */
export const RAG_JOB_TYPE_F2LLM = "rag_prepare_f2llm";

export interface EmbeddingSpace {
  id: EmbeddingSpaceId;
  dims: number;
  /** عمود المتجه في file_chunks */
  vectorColumn: "embedding" | "embedding_v2";
  /** دالة البحث في القاعدة */
  rpc: "match_file_chunks" | "match_file_chunks_v2";
  jobType: string;
  /** وسم النموذج المخزَّن مع المتجهات — null للفضاء القديم الذي لا وسم له */
  modelTag: string | null;
}

export const E5_SPACE: EmbeddingSpace = {
  id: "e5",
  dims: 384,
  vectorColumn: "embedding",
  rpc: "match_file_chunks",
  jobType: RAG_JOB_TYPE_E5,
  modelTag: null,
};

export const F2LLM_SPACE: EmbeddingSpace = {
  id: "f2llm",
  dims: F2LLM.dims,
  vectorColumn: "embedding_v2",
  rpc: "match_file_chunks_v2",
  jobType: RAG_JOB_TYPE_F2LLM,
  modelTag: F2LLM.tag,
};

type Env = Record<string, string | undefined>;

/** هل طُلب الفضاء الجديد؟ (بمعزل عن السماح به في هذه البيئة) */
export function f2llmRequested(env: Env = process.env): boolean {
  return env[F2LLM_FLAG_ENV] === F2LLM_FLAG_VALUE;
}

/** بيئة الإنتاج كما تسمّيها المنصّة — يُرفض العَلَم فيها */
export function isProductionEnvironment(env: Env = process.env): boolean {
  return /prod/i.test((env.RAILWAY_ENVIRONMENT_NAME ?? "").trim());
}

let warned = false;

export function f2llmEnabled(env: Env = process.env): boolean {
  if (!f2llmRequested(env)) return false;
  if (isProductionEnvironment(env)) {
    if (!warned) {
      warned = true;
      console.error(`[rag] ${F2LLM_FLAG_ENV} ignored: refusing to enable the F2LLM space in a production environment`);
    }
    return false;
  }
  return true;
}

/** الفضاء الفعّال في هذه العملية الآن */
export function getActiveSpace(env: Env = process.env): EmbeddingSpace {
  return f2llmEnabled(env) ? F2LLM_SPACE : E5_SPACE;
}

/** للاختبار فقط */
export function resetEmbeddingSpaceWarningForTests(): void {
  warned = false;
}
