/**
 * ★ بناءُ الصورة بلا عملٍ زائد — ودون أن يسقط ملفٌّ يحتاجه التشغيل.
 *
 * فشل بناءان على Staging بـ `DeadlineExceeded` بعد ~300ث من بدء البناء. وأُزيل
 * من مسارهما الحرج عملان زائدان، وهذا حارساهما:
 *
 *   1. مزوّدات GPU لـ onnxruntime-node (CUDA/TensorRT، نحو 302MB) — يُنزّلها
 *      `npm ci` على linux/x64، ويضمّها متتبّعُ الملفات إلى standalone.
 *   2. تنزيلُ نموذج Embeddings — كان بعد `COPY . .` فيُعاد في كل بناء.
 *
 * فحوصٌ بنيوية بلا شبكة ولا Docker.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const read = (p: string) => fs.readFileSync(path.resolve(p), "utf8");

/** يجرّد تعليقات الـDockerfile — الفحص على الأوامر وحدها */
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

const DOCKERFILE = codeOnly(read("Dockerfile"));
const STAGES: Record<string, string> = Object.fromEntries(
  DOCKERFILE.split(/^(?=FROM )/m)
    .filter((s) => s.startsWith("FROM "))
    .map((s) => [s.match(/^FROM \S+ AS (\S+)/)?.[1] ?? "?", s]),
);

const ORT_BIN = "node_modules/onnxruntime-node/bin/napi-v6";

/** الإعدادُ المُشغَّل فعلًا لا نصُّه — `next.config.mjs` خارج مشروع TypeScript */
function tracingExcludes(): Record<string, string[]> | null {
  const script = `
    const m = await import("./next.config.mjs");
    process.stdout.write(JSON.stringify(m.default.outputFileTracingExcludes ?? null));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (child.status !== 0) throw new Error(`config load failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

/**
 * المطابقةُ كما يجريها Next في `collect-build-traces`: النمطُ يُضمّ إلى جذر
 * المشروع، والمسارُ مطلق، بـ`dot` و`contains`. وبمسارات posix لأنّ البناء
 * الذي يعنينا يجري على Linux (WORKDIR /app).
 */
function excluded(globs: string[], rel: string): boolean {
  const picomatch = require("next/dist/compiled/picomatch");
  const isMatch = picomatch(
    globs.map((g) => path.posix.join("/app", g)),
    { dot: true, contains: true },
  );
  return isMatch(path.posix.join("/app", rel));
}

describe("★ مزوّدات GPU لـ onnxruntime-node خارج standalone", () => {
  const excludes = tracingExcludes();
  const globs = excludes?.["*"] ?? [];

  it("الاستبعادُ معلنٌ لكل المسارات", () => {
    expect(excludes).not.toBeNull();
    expect(globs.length).toBeGreaterThan(0);
    const picomatch = require("next/dist/compiled/picomatch");
    const anyRoute = picomatch("*", { dot: true, contains: true });
    for (const route of ["/api/chat", "/api/files/[id]/prepare", "/automations"]) {
      expect(anyRoute(route)).toBe(true);
    }
  });

  /**
   * ★ يُستبعد بالضبط ما يُنزّله `npm ci` من خارج حزمة npm.
   *
   * قائمةُ الملفات من بيان onnxruntime-node نفسه، لا منسوخةً هنا — فإن غيّر
   * إصدارٌ قادمٌ أسماءها أو مجلّدَها سقط هذا الفحص بدل أن يتوقّف الاستبعاد صامتًا.
   */
  it("كلُّ ملفّات CUDA/TensorRT المنزَّلة على linux/x64 مستبعدة", () => {
    const meta = require(path.resolve("node_modules/onnxruntime-node/script/install-metadata.js"));
    const install = read("node_modules/onnxruntime-node/script/install.js");
    expect(install).toContain("'bin/napi-v6'");
    expect(meta.requirements["linux/x64"]).toEqual(["cuda12"]);
    const files = Object.keys(meta.manifests["linux/x64:cuda12"]).map((f) => f.replace(/^\.\//, ""));
    expect(files).toEqual(
      expect.arrayContaining(["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]),
    );
    for (const f of files) {
      expect(excluded(globs, `${ORT_BIN}/linux/x64/${f}`), f).toBe(true);
    }
  });

  /** ★ ومكتبةُ المعالج وثنائيُّ الربط من حزمة npm نفسها — تبقى في standalone */
  it("مكتبةُ المعالج وثنائيُّ الربط لا يطالهما النمط", () => {
    const keep = [
      `${ORT_BIN}/linux/x64/libonnxruntime.so.1`,
      `${ORT_BIN}/linux/x64/onnxruntime_binding.node`,
      `${ORT_BIN}/linux/arm64/libonnxruntime.so.1`,
      `${ORT_BIN}/linux/arm64/onnxruntime_binding.node`,
    ];
    for (const f of keep) {
      expect(fs.existsSync(path.resolve(f)), `${f} يأتي مع حزمة npm`).toBe(true);
      expect(excluded(globs, f), f).toBe(false);
    }
    expect(excluded(globs, "node_modules/@huggingface/transformers/dist/transformers.node.mjs")).toBe(false);
  });

  it("التشغيل يطلب المعالج وحده — لا CUDA ولا TensorRT", () => {
    const f2llm = read("lib/rag/f2llm-embeddings.ts");
    expect(f2llm).toContain('executionProviders: ["cpu"]');
    expect(f2llm).not.toMatch(/cuda|tensorrt/i);
    const e5 = read("lib/rag/embeddings.ts");
    // بلا `device` يعمل transformers.js على Node بافتراضه `cpu`
    expect(e5).not.toMatch(/\bdevice\s*:/);
  });
});

describe("★ نموذج Embeddings في مرحلةٍ مستقلّة لا تدخلها شيفرة التطبيق", () => {
  const stage = STAGES.embeddings ?? "";

  it("المرحلةُ تبدأ من الاعتماديات، وقبل مرحلة البناء", () => {
    expect(stage).toMatch(/^FROM deps AS embeddings/);
    expect(DOCKERFILE.indexOf("AS embeddings")).toBeLessThan(DOCKERFILE.indexOf("AS builder"));
  });

  /**
   * ★ مدخلاتُها `deps` وسكربتُ التنزيل لا غير — وهذا سرُّ بقائها مخبّأة.
   *
   * لو دخلها `COPY . .` لأبطل كلُّ تعديلٍ في الشيفرة طبقتَها، فعاد التنزيلُ في
   * كل بناء كما كان.
   */
  it("لا تنسخ إلا سكربت التنزيل", () => {
    const copies = stage.split("\n").filter((l) => l.startsWith("COPY "));
    expect(copies).toEqual(["COPY scripts/embeddings-prefetch.mjs ./scripts/"]);
  });

  it("السكربت لا يستورد من المستودع شيئًا — فمدخلات المرحلة تكفيه", () => {
    const src = read("scripts/embeddings-prefetch.mjs");
    const specifiers = [...src.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) {
      expect(s.startsWith("node:") || s === "@huggingface/transformers", s).toBe(true);
    }
  });

  it("الحارسان باقيان: التحقق الوظيفي في المرحلة، وفحص الكاش في الصورة", () => {
    expect(stage).toContain("ENV YSD_MODEL_CACHE=/app/.model-cache");
    expect(stage).toMatch(/RUN npm run embeddings:prefetch\s*\\\s*&& test -d \/app\/\.model-cache/);
    expect(STAGES.runner).toMatch(/RUN test -d \/app\/\.model-cache && test -n "\$\(ls -A \/app\/\.model-cache\)"/);
  });

  it("مرحلة البناء لم تعد تنزّل النموذج، والصورة تنسخه من المرحلة المستقلّة", () => {
    expect(STAGES.builder).not.toContain("embeddings:prefetch");
    expect(STAGES.runner).toContain("COPY --from=embeddings --chown=node:node /app/.model-cache ./.model-cache");
    expect(STAGES.runner).not.toMatch(/COPY --from=builder[^\n]*\.model-cache/);
  });
});
