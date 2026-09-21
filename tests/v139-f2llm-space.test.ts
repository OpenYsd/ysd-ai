import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import golden from "./fixtures/f2llm-golden.json";
import manifestJson from "../scripts/f2llm/manifest.json";
import {
  E5_SPACE,
  F2LLM_FLAG_ENV,
  F2LLM_SPACE,
  RAG_JOB_TYPE_E5,
  RAG_JOB_TYPE_F2LLM,
  f2llmEnabled,
  f2llmRequested,
  getActiveSpace,
  isProductionEnvironment,
  resetEmbeddingSpaceWarningForTests,
} from "@/lib/rag/embedding-space";
import { F2LLM, F2LLM_RUNTIME_FILES } from "@/lib/rag/f2llm-manifest";
import {
  F2LLM_REQUIRED_MALLOC_ENV,
  F2LLM_SESSION_OPTIONS,
  F2llmConfigError,
  assertF2llmRuntimeEnv,
  buildF2llmInput,
  embedWithRuntime,
  truncateKeepingEos,
  type F2llmRuntime,
} from "@/lib/rag/f2llm-embeddings";

/**
 * العَلَم والفضاء والثوابت — لا نموذج هنا ولا قاعدة.
 * ★ الافتراضي e5 دائمًا؛ F2LLM يشتعل بقيمةٍ واحدةٍ حرفيّة، ولا يشتعل أبدًا في بيئة تسمّي نفسها production.
 */

beforeEach(() => {
  resetEmbeddingSpaceWarningForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("★ العَلَم", () => {
  it.each([
    [{}, false],
    [{ [F2LLM_FLAG_ENV]: "" }, false],
    [{ [F2LLM_FLAG_ENV]: "e5" }, false],
    [{ [F2LLM_FLAG_ENV]: "F2LLM-V2-80M" }, false], // حرفيّ: لا تطبيع يفتح الباب خطأً
    [{ [F2LLM_FLAG_ENV]: "true" }, false],
    [{ [F2LLM_FLAG_ENV]: "1" }, false],
    [{ [F2LLM_FLAG_ENV]: " f2llm-v2-80m" }, false],
    [{ [F2LLM_FLAG_ENV]: "f2llm-v2-80m" }, true],
  ])("★ ★ ★ %j ⇒ مشتعل=%s", (env, on) => {
    expect(f2llmEnabled(env)).toBe(on);
    expect(getActiveSpace(env)).toBe(on ? F2LLM_SPACE : E5_SPACE);
  });

  it("★ ★ ★ الافتراضي (بلا أي متغيّر) هو e5 — كما كان قبل الترحيل", () => {
    const s = getActiveSpace({});
    expect(s).toBe(E5_SPACE);
    expect(s).toMatchObject({ dims: 384, vectorColumn: "embedding", rpc: "match_file_chunks", jobType: RAG_JOB_TYPE_E5, modelTag: null });
  });

  it.each(["production", "Production", "prod", "prod-eu", "PRODUCTION"])("★ ★ ★ بيئة %s: العَلَم يُتجاهل مع تحذير — حارسٌ ثانٍ ضدّ إعدادٍ خاطئ", (name) => {
    const env = { [F2LLM_FLAG_ENV]: "f2llm-v2-80m", RAILWAY_ENVIRONMENT_NAME: name };
    expect(f2llmRequested(env)).toBe(true);
    expect(isProductionEnvironment(env)).toBe(true);
    expect(f2llmEnabled(env)).toBe(false);
    expect(getActiveSpace(env)).toBe(E5_SPACE);
    expect(console.error).toHaveBeenCalledTimes(1);
    f2llmEnabled(env);
    expect(console.error).toHaveBeenCalledTimes(1); // يحذّر مرّة واحدة لا في كل نداء
  });

  it.each(["staging", "Staging", "preview", "pr-9", ""])("بيئة %j لا تُعدّ إنتاجًا", (name) => {
    const env = { [F2LLM_FLAG_ENV]: "f2llm-v2-80m", RAILWAY_ENVIRONMENT_NAME: name };
    expect(isProductionEnvironment(env)).toBe(false);
    expect(f2llmEnabled(env)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("★ ★ ★ العَلَم يُقرأ عند كل نداء (لا تخزين) — التبديل بإعادة التشغيل لا بإعادة البناء", () => {
    const env: Record<string, string | undefined> = {};
    expect(f2llmEnabled(env)).toBe(false);
    env[F2LLM_FLAG_ENV] = "f2llm-v2-80m";
    expect(f2llmEnabled(env)).toBe(true);
    delete env[F2LLM_FLAG_ENV];
    expect(f2llmEnabled(env)).toBe(false);
  });
});

describe("★ الفضاءان منفصلان بنيويًّا", () => {
  it("★ ★ ★ لكلٍّ عمودٌ ودالةٌ ونوعُ وظيفةٍ مختلف — لا اشتراك يُمكن أن يخلط الفضاءين", () => {
    expect(F2LLM_SPACE.vectorColumn).not.toBe(E5_SPACE.vectorColumn);
    expect(F2LLM_SPACE.rpc).not.toBe(E5_SPACE.rpc);
    expect(F2LLM_SPACE.jobType).not.toBe(E5_SPACE.jobType);
    expect(RAG_JOB_TYPE_F2LLM).not.toBe(RAG_JOB_TYPE_E5);
    expect(F2LLM_SPACE).toMatchObject({ dims: 320, vectorColumn: "embedding_v2", rpc: "match_file_chunks_v2", modelTag: F2LLM.tag });
  });

  it("★ ★ ★ وسم النموذج يحمل المراجعة العليا وبصمة ONNX — يتغيّر بتغيّر أيٍّ منهما", () => {
    expect(F2LLM.tag).toBe(manifestJson.artifact.tag);
    expect(F2LLM.tag).toContain(F2LLM.revision.slice(0, 8));
    expect(F2LLM.tag).toContain(F2LLM.files["model.onnx"]!.sha256.slice(0, 12));
  });
});

describe("★ الثوابت مطابقة للمصدر المثبَّت والمرجع الذهبي", () => {
  it("★ ★ ★ نصّ التعليمة وبُعد النموذج ومراجعتُه هي نفسها التي وُلّد بها المرجع الذهبي", () => {
    expect(F2LLM.queryPrompt).toBe(golden.queryPrompt);
    expect(F2LLM.revision).toBe(golden.revision);
    expect(F2LLM.upstream).toBe(golden.model);
    expect(F2LLM.dims).toBe(320);
    expect(F2LLM.maxTokens).toBe(512);
    expect(F2LLM.documentPrompt).toBe("");
  });

  it("★ ★ ★ التعليمة تنتهي بـ «Query: » وتسبق السؤال وحده", () => {
    expect(F2LLM.queryPrompt).toBe("Instruct: Given a question, retrieve passages that can help answer the question.\nQuery: ");
    expect(buildF2llmInput("query", "ما هو ysd؟")).toBe(F2LLM.queryPrompt + "ما هو ysd؟");
  });

  it("★ ★ ★ المقطع بلا بادئة إطلاقًا", () => {
    expect(buildF2llmInput("document", "نصّ المقطع")).toBe("نصّ المقطع");
    expect(buildF2llmInput("document", "x")).not.toContain("Instruct");
  });

  it("★ ★ ★ كل مدخل في المرجع الذهبي يساوي ما يبنيه التطبيق حرفيًّا (استعلامًا كان أم مقطعًا)", () => {
    for (const it of golden.items) {
      expect(buildF2llmInput(it.kind as "query" | "document", it.text)).toBe(it.input);
    }
  });

  it("★ ★ ★ 2000 حرف فقط تُعطى للمُرمِّز — كما في مسار e5 (نفس قصّ الذاكرة)", () => {
    expect(buildF2llmInput("document", "a".repeat(5000))).toHaveLength(2000);
    expect(buildF2llmInput("query", "a".repeat(5000))).toHaveLength(F2LLM.queryPrompt.length + 2000);
  });

  it("الملفات التي يحمّلها التطبيق كلّها في البيان المثبَّت بحجمٍ وبصمة", () => {
    for (const name of F2LLM_RUNTIME_FILES) {
      expect(F2LLM.files[name]).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
    }
  });

  it("خيارات ORT هي المقيسة: خيط واحد بلا ساحة ولا نمط ذاكرة", () => {
    expect(F2LLM_SESSION_OPTIONS).toMatchObject({ intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false });
  });
});

describe("★ حارس ذاكرة glibc (MALLOC_*)", () => {
  const ok = { MALLOC_MMAP_THRESHOLD_: "65536", MALLOC_TRIM_THRESHOLD_: "65536" };
  it("★ ★ ★ على Linux: يُرفض الإقلاع بدونهما أو بقيمةٍ أخرى — لا تشغيل «خطِر» صامت", () => {
    expect(() => assertF2llmRuntimeEnv({}, "linux")).toThrow(F2llmConfigError);
    expect(() => assertF2llmRuntimeEnv({ MALLOC_MMAP_THRESHOLD_: "65536" }, "linux")).toThrow(/MALLOC_TRIM_THRESHOLD_=65536/);
    expect(() => assertF2llmRuntimeEnv({ MALLOC_TRIM_THRESHOLD_: "65536" }, "linux")).toThrow(/MALLOC_MMAP_THRESHOLD_=65536/);
    expect(() => assertF2llmRuntimeEnv({ ...ok, MALLOC_TRIM_THRESHOLD_: "131072" }, "linux")).toThrow(F2llmConfigError);
  });
  it("★ ★ ★ بهما معًا يمرّ", () => {
    expect(() => assertF2llmRuntimeEnv(ok, "linux")).not.toThrow();
    expect(F2LLM_REQUIRED_MALLOC_ENV).toEqual(ok);
  });
  it("خارج Linux (تطوير محلي) لا يُشترط", () => {
    expect(() => assertF2llmRuntimeEnv({}, "win32")).not.toThrow();
    expect(() => assertF2llmRuntimeEnv({}, "darwin")).not.toThrow();
  });
});

describe("★ التجميع: حالة الرمز الأخير ثم تطبيع L2", () => {
  /** مشغّلٌ وهميّ: حالة كل رمز = متجهٌ معروف، فيتّضح أيّ رمزٍ جُمِّع عليه */
  function rt(perToken: number[][]): F2llmRuntime & { seen: number[][] } {
    const seen: number[][] = [];
    return {
      seen,
      tokenize: () => perToken.map((_, i) => i + 1),
      async forward(ids) {
        seen.push(ids);
        const size = F2LLM.dims;
        const hidden = new Float32Array(ids.length * size);
        perToken.slice(0, ids.length).forEach((v, t) => v.forEach((x, k) => (hidden[t * size + k] = x)));
        return { hidden, size };
      },
    };
  }
  const pad = (head: number[]) => [...head, ...new Array(F2LLM.dims - head.length).fill(0)];

  it("★ ★ ★ يُؤخذ الرمز الأخير لا الأول ولا المتوسط", async () => {
    const out = await embedWithRuntime(rt([pad([9, 0]), pad([0, 5]), pad([3, 4])]), "x");
    expect(out[0]).toBeCloseTo(0.6, 6); // (3,4)/5
    expect(out[1]).toBeCloseTo(0.8, 6);
    expect(out).toHaveLength(320);
  });
  it("★ ★ ★ الناتج مُطبَّع (‖v‖ = 1) وكل قيمه منتهية", async () => {
    const out = await embedWithRuntime(rt([pad([1, 2, 3]), pad([7, -2, 11])]), "x");
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
    expect(out.every(Number.isFinite)).toBe(true);
  });
  it("متجه صفريّ لا يُنتج NaN", async () => {
    const out = await embedWithRuntime(rt([pad([0])]), "x");
    expect(out.every(Number.isFinite)).toBe(true);
  });
  it("★ ★ ★ بُعدٌ خاطئ من النموذج يُرفض — لا يُخزَّن متجهٌ من فضاءٍ آخر", async () => {
    const bad: F2llmRuntime = { tokenize: () => [1, 2], forward: async () => ({ hidden: new Float32Array(2 * 384), size: 384 }) };
    await expect(embedWithRuntime(bad, "x")).rejects.toThrow(/unexpected hidden size/);
  });
  it("★ ★ ★ ما زاد على 512 رمزًا يُقصّ مع إبقاء رمز النهاية الأخير وحده", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i);
    const cut = truncateKeepingEos(ids, 512);
    expect(cut).toHaveLength(512);
    expect(cut.slice(0, 511)).toEqual(ids.slice(0, 511));
    expect(cut[511]).toBe(999);
    expect(truncateKeepingEos([1, 2, 3], 512)).toEqual([1, 2, 3]);
    const r = rt(Array.from({ length: 1000 }, () => pad([1])));
    r.tokenize = () => ids;
    await embedWithRuntime(r, "long");
    expect(r.seen[0]).toHaveLength(512);
    expect(r.seen[0]![511]).toBe(999);
  });
});
