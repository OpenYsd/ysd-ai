/**
 * التحقّق من مجلّد نموذج F2LLM قبل تحميله.
 *
 * ★ لا يُحمَّل ملفٌّ لا تطابق بصمتُه (SHA-256) وحجمُه ما في `scripts/f2llm/manifest.json`.
 *   فلا يعتمد التشغيل على ملفٍّ مجهول المصدر: إمّا البايتات المثبَّتة وإمّا رفضٌ صريح.
 * ★ البصمة تُحسب بالتدفّق (لا يُحمَّل ملف 93MB في الذاكرة لحسابها).
 */
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { F2LLM, F2LLM_RUNTIME_FILES } from "./f2llm-manifest";

export type F2llmArtifactErrorCode = "missing_dir" | "missing_file" | "size_mismatch" | "hash_mismatch" | "tag_mismatch";

export class F2llmArtifactError extends Error {
  constructor(
    readonly code: F2llmArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "F2llmArtifactError";
  }
}

export interface VerifiedF2llmArtifact {
  dir: string;
  modelPath: string;
  /** أب المجلّد وباسمه يُحمَّل المُرمِّز عبر transformers.js (localModelPath + معرّف) */
  parentDir: string;
  modelId: string;
}

type Env = Record<string, string | undefined>;

/** مكان النموذج المخبوز في الصورة — أو YSD_F2LLM_MODEL_DIR */
export function resolveF2llmDir(env: Env = process.env, cwd: string = process.cwd()): string {
  const custom = env.YSD_F2LLM_MODEL_DIR?.trim();
  return path.resolve(custom || path.join(cwd, ".f2llm-model", F2LLM.id));
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

/** يرمي F2llmArtifactError عند أي اختلاف — بلا تحميل شيء */
export async function verifyF2llmArtifact(dir: string): Promise<VerifiedF2llmArtifact> {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new F2llmArtifactError("missing_dir", "f2llm artifact directory not found");
  }

  for (const name of F2LLM_RUNTIME_FILES) {
    const spec = F2LLM.files[name];
    if (!spec) throw new F2llmArtifactError("missing_file", `manifest has no entry for ${name}`);
    const file = path.join(dir, name);
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      throw new F2llmArtifactError("missing_file", `f2llm artifact is missing ${name}`);
    }
    if (size !== spec.bytes) {
      throw new F2llmArtifactError("size_mismatch", `f2llm artifact ${name} has ${size} bytes, expected ${spec.bytes}`);
    }
    if ((await sha256File(file)) !== spec.sha256) {
      throw new F2llmArtifactError("hash_mismatch", `f2llm artifact ${name} does not match the pinned SHA-256`);
    }
  }

  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "artifact.json"), "utf8")) as { tag?: string };
    if (meta.tag !== F2LLM.tag) {
      throw new F2llmArtifactError("tag_mismatch", `f2llm artifact tag ${String(meta.tag)} != ${F2LLM.tag}`);
    }
  } catch (err) {
    if (err instanceof F2llmArtifactError) throw err;
    throw new F2llmArtifactError("missing_file", "f2llm artifact is missing artifact.json");
  }

  return { dir, modelPath: path.join(dir, "model.onnx"), parentDir: path.dirname(dir), modelId: path.basename(dir) };
}

const cache = new Map<string, Promise<VerifiedF2llmArtifact>>();

/** بصمة واحدة لكل مجلّد في عمر العملية؛ الفشل لا يُخزَّن فيُعاد الفحص */
export function verifyF2llmArtifactOnce(dir: string): Promise<VerifiedF2llmArtifact> {
  let p = cache.get(dir);
  if (!p) {
    p = verifyF2llmArtifact(dir).catch((err) => {
      cache.delete(dir);
      throw err;
    });
    cache.set(dir, p);
  }
  return p;
}

/** للاختبار فقط */
export function resetF2llmArtifactCacheForTests(): void {
  cache.clear();
}
