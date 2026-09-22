/**
 * v140 — موافقةُ الإنتاج الصريحة على F2LLM (استبدال حارس اسم البيئة وحده).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا هذا الحارس
 *
 *  كان حارسُ الإنتاج الوحيد اسمَ البيئة (RAILWAY_ENVIRONMENT_NAME): كافٍ
 *  ليمنع تفعيلًا عرضيًّا، لكنه لا يفرّق بين «لم يُقرَّر بعد» و«قُرِّر
 *  صراحةً». هذا الملفّ يحرس أن كلا الأمرين الآن صريحان معًا:
 *
 *    YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m   (الفضاء المطلوب)
 *    YSD_F2LLM_PRODUCTION_OPT_IN=1          (الإذن بتشغيله في الإنتاج)
 *
 *  ولا واحدٌ منهما يكفي وحده — مُثبَتٌ في tests/v139-f2llm-space.test.ts.
 *  هذا الملفّ يحرس الطرفَ الآخر: docker-entrypoint.sh، الذي يضبط متغيّرَي
 *  glibc قبل أن يبدأ Node، ولا يقرأ منطقَ lib/rag/embedding-space.ts إطلاقًا
 *  (هما نسختان مستقلّتان من الحكم نفسه — حارسان، لا حارسٌ واحد بمرآة).
 * ══════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { F2LLM_PRODUCTION_OPT_IN_ENV, F2LLM_PRODUCTION_OPT_IN_VALUE, F2LLM_FLAG_ENV, F2LLM_FLAG_VALUE } from "@/lib/rag/embedding-space";

const entrypoint = readFileSync(join(process.cwd(), "docker-entrypoint.sh"), "utf8");

describe("★ docker-entrypoint.sh — موافقةُ الإنتاج الصريحة", () => {
  it("★ ★ ★ اسمُ عَلَم الموافقة وقيمتُه في السكربت يطابقان تصدير embedding-space.ts حرفيًّا", () => {
    expect(entrypoint).toContain(F2LLM_PRODUCTION_OPT_IN_ENV);
    expect(entrypoint).toContain(`"\${${F2LLM_PRODUCTION_OPT_IN_ENV}:-}" = "${F2LLM_PRODUCTION_OPT_IN_VALUE}"`);
    expect(entrypoint).toContain(F2LLM_FLAG_ENV);
    expect(entrypoint).toContain(`"\${${F2LLM_FLAG_ENV}:-}" = "${F2LLM_FLAG_VALUE}"`);
  });

  it("★ ★ ★ فرعُ الإنتاج مشروطٌ بالموافقة — لا يُصدَّر شيءٌ في فرع else الإنتاجي", () => {
    const prodBranch = /\*prod\*\)([\s\S]*?);;/.exec(entrypoint)?.[1] ?? "";
    expect(prodBranch, "فرع production موجود").not.toBe("");
    expect(prodBranch).toMatch(new RegExp(`if \\[ "\\$\\{${F2LLM_PRODUCTION_OPT_IN_ENV}:-\\}" = "${F2LLM_PRODUCTION_OPT_IN_VALUE}" \\]`));
    expect(prodBranch).toContain("export MALLOC_MMAP_THRESHOLD_=65536");
    expect(prodBranch).toContain("export MALLOC_TRIM_THRESHOLD_=65536");
    expect(prodBranch).toMatch(/else/);
    expect(prodBranch).toContain("ignored");
  });

  it("★ ★ ★ يُمسَح المتغيّران أولًا — بلا شرطٍ — قبل أي منطقٍ آخر", () => {
    const lines = entrypoint.split("\n").map((l) => l.trim());
    const unsetIdx = lines.findIndex((l) => l.startsWith("unset MALLOC_MMAP_THRESHOLD_"));
    const ifIdx = lines.findIndex((l) => l.startsWith(`if [ "\${${F2LLM_FLAG_ENV}:-}"`));
    expect(unsetIdx, "سطر unset موجود").toBeGreaterThan(-1);
    expect(ifIdx, "سطر الشرط موجود").toBeGreaterThan(-1);
    expect(unsetIdx).toBeLessThan(ifIdx);
    // غير مشروطٍ بأي `if` يسبقه في السطر نفسه أو فيما قبله مباشرةً
    expect(lines[unsetIdx]).not.toMatch(/^if\b/);
  });

  it("★ ★ ★ الفرعُ غير الإنتاجي يبقى بلا شرطٍ إضافي — لا تغيير في سلوك staging", () => {
    const nonProdBranch = /\*\)\s*\n(\s*export MALLOC_MMAP_THRESHOLD_[\s\S]*?);;/.exec(entrypoint)?.[1] ?? "";
    expect(nonProdBranch, "الفرع الافتراضي موجود").not.toBe("");
    expect(nonProdBranch).not.toContain(F2LLM_PRODUCTION_OPT_IN_ENV);
    expect(nonProdBranch).toContain("export MALLOC_MMAP_THRESHOLD_=65536");
    expect(nonProdBranch).toContain("export MALLOC_TRIM_THRESHOLD_=65536");
  });

  it("★ ★ ★ سقف كومة V8 (--max-old-space-size) يُضبط في كلا فرعَي الاشتعال، ولا يُضبط في فرع الرفض", () => {
    const prodBranch = /\*prod\*\)([\s\S]*?);;/.exec(entrypoint)?.[1] ?? "";
    const grantedBlock = /if \[ "\$\{YSD_F2LLM_PRODUCTION_OPT_IN:-\}" = "1" \][\s\S]*?else/.exec(prodBranch)?.[0] ?? "";
    const refusedBlock = prodBranch.slice(grantedBlock.length);
    expect(grantedBlock, "فرع الموافقة موجود").not.toBe("");
    expect(grantedBlock).toMatch(/NODE_OPTIONS="\$\{NODE_OPTIONS:-\} --max-old-space-size=\d+"/);
    expect(refusedBlock).not.toContain("NODE_OPTIONS");

    const nonProdBranch = /\*\)\s*\n(\s*export MALLOC_MMAP_THRESHOLD_[\s\S]*?);;/.exec(entrypoint)?.[1] ?? "";
    expect(nonProdBranch).toMatch(/NODE_OPTIONS="\$\{NODE_OPTIONS:-\} --max-old-space-size=\d+"/);
  });

  it("★ ★ ★ سقف كومة V8 يُضاف إلى NODE_OPTIONS القائم لا يستبدله — لا يمحو ضبطًا آخر للمنصّة", () => {
    const capLines = entrypoint.split("\n").filter((l) => l.includes("--max-old-space-size"));
    expect(capLines.length).toBeGreaterThan(0);
    for (const l of capLines) expect(l).toContain('NODE_OPTIONS="${NODE_OPTIONS:-}');
  });

  it("exec \"$@\" يبقى آخر سطرٍ فعليّ — الإشارات تصل Node مباشرةً", () => {
    const lines = entrypoint.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines.at(-1)).toBe('exec "$@"');
  });
});

describe("★ الحارس الثالث (assertF2llmRuntimeEnv) — لا يحتاج تعديلًا، ومتوافقٌ بالبناء", () => {
  const embeddings = readFileSync(join(process.cwd(), "lib/rag/embeddings.ts"), "utf8");
  const f2llmEmbeddings = readFileSync(join(process.cwd(), "lib/rag/f2llm-embeddings.ts"), "utf8");

  it("★ ★ ★ لا يعرف اسم بيئةٍ ولا عَلَم موافقة — يفحص متغيّرَي glibc فقط، أينما استُدعي", () => {
    expect(f2llmEmbeddings).not.toMatch(/RAILWAY_ENVIRONMENT_NAME|PRODUCTION_OPT_IN/);
  });

  it("★ ★ ★ لا يُستدعى إلا من loadRuntime — وهي لا تُستدعى إلا عبر مسارٍ يحرسه f2llmEnabled() أولًا", () => {
    // getF2llmProvider (الذي يحمل loadRuntime في النهاية) يُستدعى فقط بعد f2llmEnabled() في embeddings.ts —
    // فالحارس الثالث يقع دائمًا خلف الأول والثاني، لا موازيًا لهما ولا بديلًا عنهما.
    expect(embeddings).toMatch(/f2llmEnabled\(\)\)\s*return getF2llmProvider\(\)/);
    expect(embeddings).toMatch(/f2llmEnabled\(\)\)\s*return getF2llmState\(\)/);
    const assertCallSite = /async function loadRuntime[\s\S]*?assertF2llmRuntimeEnv\(\)/.exec(f2llmEmbeddings)?.[0] ?? "";
    expect(assertCallSite, "assertF2llmRuntimeEnv is the first statement in loadRuntime").not.toBe("");
  });
});
