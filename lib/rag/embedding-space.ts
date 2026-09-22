/**
 * فضاءات التضمين المتاحة للـRAG، والعَلَم الذي يختار بينها.
 *
 * ★ الافتراضي هو e5 كما كان — لا يتغيّر شيء إلا إذا اشتعل العَلَم صراحةً.
 *
 * ★ العَلَم `YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m`:
 *   • يُقرأ عند كل نداء (لا تخزين) فيتغيّر بإعادة التشغيل لا بإعادة البناء.
 *   • في بيئةٍ تسمّي نفسها production (RAILWAY_ENVIRONMENT_NAME): يُتجاهل — مع تحذير — ما لم يُضبط
 *     أيضًا `YSD_F2LLM_PRODUCTION_OPT_IN=1` صراحةً. **كلا العَلَمين معًا**، لا أحدهما: نسخُ عَلَم
 *     التجريب وحده إلى الإنتاج لا يُشعل شيئًا، وموافقةُ الإنتاج وحدها بلا عَلَم التجريب لا تعني شيئًا أيضًا.
 *   • هذا حارسٌ أول من ثلاثة: الثاني في docker-entrypoint.sh (متغيّرا glibc لا يُصدَّران إلا حين يشتعل
 *     الفضاء فعلًا)، والثالث assertF2llmRuntimeEnv في f2llm-embeddings.ts (يرفض تحميل النموذج على
 *     Linux بلا المتغيّرين — سواءٌ أكان الإذن صادقًا أم مزوَّرًا).
 *
 * ★ الفضاء الواحد يعني ملفّ متجهاتٍ واحدًا ودالة بحثٍ واحدة ووسمَ نموذجٍ واحدًا: الاستعلام والمقاطع
 *   يمرّان دائمًا بالفضاء نفسه لأن الفضاء يُحسم مرّةً واحدة لكل نداء ثم تُشتقّ منه الكتابة والقراءة معًا.
 */
import { F2LLM } from "./f2llm-manifest";

export type EmbeddingSpaceId = "e5" | "f2llm";

export const F2LLM_FLAG_ENV = "YSD_RAG_EMBEDDING_MODEL";
export const F2LLM_FLAG_VALUE = F2LLM.id;

/** الموافقةُ الصريحة على تشغيل F2LLM في بيئةٍ تسمّي نفسها production — عَلَمٌ مستقلّ عمدًا */
export const F2LLM_PRODUCTION_OPT_IN_ENV = "YSD_F2LLM_PRODUCTION_OPT_IN";
export const F2LLM_PRODUCTION_OPT_IN_VALUE = "1";

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

/** بيئة الإنتاج كما تسمّيها المنصّة — يُرفض العَلَم فيها ما لم يُضبط عَلَمُ الموافقة أيضًا */
export function isProductionEnvironment(env: Env = process.env): boolean {
  return /prod/i.test((env.RAILWAY_ENVIRONMENT_NAME ?? "").trim());
}

/** موافقةٌ صريحة حرفيّة — لا تُطبَّع ولا تُخمَّن؛ أي قيمةٍ أخرى (غيابٌ، فراغ، "true"، "yes"…) = لا موافقة */
export function f2llmProductionOptIn(env: Env = process.env): boolean {
  return env[F2LLM_PRODUCTION_OPT_IN_ENV] === F2LLM_PRODUCTION_OPT_IN_VALUE;
}

let warned = false;

export function f2llmEnabled(env: Env = process.env): boolean {
  if (!f2llmRequested(env)) return false;
  if (isProductionEnvironment(env) && !f2llmProductionOptIn(env)) {
    if (!warned) {
      warned = true;
      console.error(
        `[rag] ${F2LLM_FLAG_ENV} ignored: production environment requires ${F2LLM_PRODUCTION_OPT_IN_ENV}=${F2LLM_PRODUCTION_OPT_IN_VALUE} as well`,
      );
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
