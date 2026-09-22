/**
 * ثوابت نموذج F2LLM-v2-80M — مصدرها الوحيد `scripts/f2llm/manifest.json`.
 *
 * لا نسخة ثانية تُصان يدويًا: التعديل هناك (يُولَّد بـ build-onnx.py --update-manifest)
 * فيتبعه التطبيق. وتحقّق وقت التشغيل يقارن الملفات بهذه القيم بالبايت.
 */
import manifest from "../../scripts/f2llm/manifest.json";

const artifact = manifest.artifact;
if (!artifact) {
  throw new Error("scripts/f2llm/manifest.json has no artifact section — run build-onnx.py --update-manifest");
}

export interface F2llmFileSpec {
  sha256: string;
  bytes: number;
}

export const F2LLM = {
  /** معرّف قصير — قيمة العَلَم YSD_RAG_EMBEDDING_MODEL */
  id: manifest.model.id,
  upstream: manifest.model.upstream,
  revision: manifest.model.revision,
  dims: manifest.model.dims,
  /** الحدّ الأقصى للرموز؛ ما زاد يُقصّ مع إبقاء رمز النهاية (المُجمَّع عليه) */
  maxTokens: manifest.model.maxTokens,
  /** تعليمة الاستعلام — للأسئلة فقط، لا للمقاطع */
  queryPrompt: manifest.model.queryPrompt,
  documentPrompt: manifest.model.documentPrompt,
  /**
   * وسم هذا النموذج بعينه: المراجعة العليا + بصمة ONNX. يُخزَّن مع كل متجه (embedding_v2_model)،
   * فلا يُقرأ متجهٌ من إصدارٍ آخر ولو بالبعد نفسه.
   */
  tag: artifact.tag,
  files: Object.fromEntries(artifact.files.map((f) => [f.path, { sha256: f.sha256, bytes: f.bytes } as F2llmFileSpec])) as Record<
    string,
    F2llmFileSpec
  >,
} as const;

/** الملفات التي يحمّلها التطبيق فعلًا — تُتحقَّق بالبصمة قبل أي تحميل */
export const F2LLM_RUNTIME_FILES = ["model.onnx", "tokenizer.json", "tokenizer_config.json"] as const;
