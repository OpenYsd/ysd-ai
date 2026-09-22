import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * التحقّق من مجلّد النموذج قبل التحميل — على ملفاتٍ صغيرة مصنوعةٍ هنا وبيانٍ مُبدَّل،
 * فيُختبَر كل رفضٍ بلا ملف 93MB. (والاختبار الحيّ على البايتات الحقيقية في v139-f2llm-live.)
 *
 * ★ الغاية: لا يُحمَّل ملفٌّ لا تطابق بصمتُه وحجمُه ما هو مثبَّت — «لا artifact مجهول المصدر».
 */

const { sha, FILES, TAG } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash: h } = require("node:crypto") as typeof import("node:crypto");
  return {
    sha: (b: Buffer | string) => h("sha256").update(b).digest("hex"),
    FILES: {
      "model.onnx": Buffer.from("fake-onnx-bytes-0123456789"),
      "tokenizer.json": Buffer.from('{"fake":"tokenizer"}'),
      "tokenizer_config.json": Buffer.from('{"fake":"config"}'),
    } as Record<string, Buffer>,
    TAG: "f2llm-v2-80m@test.onnx-abcdef012345",
  };
});

vi.mock("@/lib/rag/f2llm-manifest", () => ({
  F2LLM: {
    id: "f2llm-v2-80m",
    tag: TAG,
    files: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, { sha256: sha(v), bytes: v.length }])),
  },
  F2LLM_RUNTIME_FILES: ["model.onnx", "tokenizer.json", "tokenizer_config.json"],
}));

import { F2llmArtifactError, resetF2llmArtifactCacheForTests, resolveF2llmDir, verifyF2llmArtifact, verifyF2llmArtifactOnce } from "@/lib/rag/f2llm-artifact";

let root: string;
let n = 0;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "f2llm-artifact-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetF2llmArtifactCacheForTests());

/** مجلّد سليم، تُعدَّل بعده الملفات لكسر شرطٍ واحد */
function makeDir(mutate?: (dir: string) => void, tag: string | null = TAG): string {
  const dir = path.join(root, "f2llm-v2-80m", `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(path.join(dir, name), bytes);
  if (tag !== null) writeFileSync(path.join(dir, "artifact.json"), JSON.stringify({ tag }));
  mutate?.(dir);
  return dir;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof F2llmArtifactError ? e.code : `other:${String(e)}`;
  }
  return "ok";
}

describe("★ verifyF2llmArtifact", () => {
  it("★ ★ ★ مجلّدٌ مطابق للبيان يُقبل ويُعطي مسار النموذج ومسار المُرمِّز", async () => {
    const dir = makeDir();
    const v = await verifyF2llmArtifact(dir);
    expect(v.modelPath).toBe(path.join(dir, "model.onnx"));
    expect(v.parentDir).toBe(path.dirname(dir));
    expect(v.modelId).toBe(path.basename(dir));
  });

  it("★ ★ ★ مجلّدٌ غير موجود ⇒ missing_dir (لا تحميل)", async () => {
    expect(await codeOf(verifyF2llmArtifact(path.join(root, "nope")))).toBe("missing_dir");
  });

  it("★ ★ ★ ملفٌ ناقص ⇒ missing_file", async () => {
    const dir = makeDir((d) => rmSync(path.join(d, "tokenizer.json")));
    expect(await codeOf(verifyF2llmArtifact(dir))).toBe("missing_file");
  });

  it("★ ★ ★ حجمٌ مختلف ⇒ size_mismatch", async () => {
    const dir = makeDir((d) => writeFileSync(path.join(d, "model.onnx"), Buffer.concat([FILES["model.onnx"]!, Buffer.from("x")])));
    expect(await codeOf(verifyF2llmArtifact(dir))).toBe("size_mismatch");
  });

  it("★ ★ ★ بايتٌ واحد مقلوب بالحجم نفسه ⇒ hash_mismatch — الحجم وحده لا يكفي", async () => {
    const dir = makeDir((d) => {
      const b = Buffer.from(FILES["model.onnx"]!);
      b[3] = b[3]! ^ 0xff;
      writeFileSync(path.join(d, "model.onnx"), b);
    });
    expect(await codeOf(verifyF2llmArtifact(dir))).toBe("hash_mismatch");
  });

  it("★ ★ ★ المُرمِّز أيضًا مثبَّت بالبصمة، لا النموذج وحده", async () => {
    const dir = makeDir((d) => {
      const b = Buffer.from(FILES["tokenizer.json"]!);
      b[2] = b[2]! ^ 0x01;
      writeFileSync(path.join(d, "tokenizer.json"), b);
    });
    expect(await codeOf(verifyF2llmArtifact(dir))).toBe("hash_mismatch");
  });

  it("★ ★ ★ artifact.json بوسمٍ آخر ⇒ tag_mismatch (بايتاتٌ سليمة لكنّها إصدارٌ مختلف)", async () => {
    expect(await codeOf(verifyF2llmArtifact(makeDir(undefined, "f2llm-v2-80m@other.onnx-000000000000")))).toBe("tag_mismatch");
  });

  it("★ ★ ★ artifact.json مفقود أو تالف ⇒ missing_file", async () => {
    expect(await codeOf(verifyF2llmArtifact(makeDir(undefined, null)))).toBe("missing_file");
    expect(await codeOf(verifyF2llmArtifact(makeDir((d) => writeFileSync(path.join(d, "artifact.json"), "{not json"))))).toBe("missing_file");
  });

  it("رسالة الخطأ لا تكشف مسارًا محليًّا كاملًا ولا أسرارًا", async () => {
    const dir = makeDir((d) => rmSync(path.join(d, "model.onnx")));
    const err = (await verifyF2llmArtifact(dir).catch((e) => e)) as Error;
    expect(err.message).not.toContain(root);
  });
});

describe("★ verifyF2llmArtifactOnce", () => {
  it("يُحسب مرّةً واحدة لكل مجلّد ويُعاد نفسُ الوعد", async () => {
    const dir = makeDir();
    const a = verifyF2llmArtifactOnce(dir);
    expect(verifyF2llmArtifactOnce(dir)).toBe(a);
    await a;
  });
  it("★ ★ ★ الفشل لا يُخزَّن: بعد إصلاح المجلّد تنجح المحاولة التالية بلا إعادة تشغيل", async () => {
    const dir = makeDir((d) => rmSync(path.join(d, "tokenizer.json")));
    expect(await codeOf(verifyF2llmArtifactOnce(dir))).toBe("missing_file");
    writeFileSync(path.join(dir, "tokenizer.json"), FILES["tokenizer.json"]!);
    expect(await codeOf(verifyF2llmArtifactOnce(dir))).toBe("ok");
  });
});

describe("★ resolveF2llmDir", () => {
  it("الافتراضي: .f2llm-model/<id> تحت مجلّد التشغيل", () => {
    expect(resolveF2llmDir({}, "/srv/app")).toBe(path.resolve("/srv/app", ".f2llm-model", "f2llm-v2-80m"));
  });
  it("YSD_F2LLM_MODEL_DIR يغلب", () => {
    expect(resolveF2llmDir({ YSD_F2LLM_MODEL_DIR: "/models/x" }, "/srv/app")).toBe(path.resolve("/models/x"));
    expect(resolveF2llmDir({ YSD_F2LLM_MODEL_DIR: "   " }, "/srv/app")).toBe(path.resolve("/srv/app", ".f2llm-model", "f2llm-v2-80m"));
  });
});
