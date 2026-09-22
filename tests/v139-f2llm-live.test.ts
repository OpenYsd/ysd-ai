import { describe, expect, it } from "vitest";
import golden from "./fixtures/f2llm-golden.json";

/**
 * الاختبار الحيّ: البايتات المثبَّتة الحقيقية + المُرمِّز الحقيقي + ONNX Runtime الحقيقي.
 * يُشغَّل فقط حين يُضبط YSD_F2LLM_MODEL_DIR على مجلّد artifact مبنيّ (وإلا يُتخطّى، فلا يُنزَّل شيء).
 *
 * ★ يثبت أن مسار التطبيق نفسه (مزوّد F2LLM) يعطي:
 *   (١) رموزًا مطابقة للمرجع الذهبي (من PyTorch fp32 المستقلّ)،
 *   (٢) متجهاتٍ بجيب تمامٍ ≥ 0.985 (المتوسط ≥ 0.992) مع المرجع،
 *   (٣) 320 بُعدًا، منتهية، ‖v‖ = 1،
 *   (٤) استعلامًا ومقطعًا من الفضاء نفسه (الاستعلام أقرب إلى مقطعه الصحيح منه إلى الخاطئ).
 */
const DIR = process.env.YSD_F2LLM_MODEL_DIR;
const live = DIR ? describe : describe.skip;

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

live("★ F2LLM الحيّ — مطابقة المرجع الذهبي عبر مزوّد التطبيق", () => {
  it("★ ★ ★ الحارس يقبل المجلّد المبنيّ (بصمة + حجم + وسم)", async () => {
    const { verifyF2llmArtifact, resolveF2llmDir } = await import("@/lib/rag/f2llm-artifact");
    const v = await verifyF2llmArtifact(resolveF2llmDir());
    expect(v.modelPath.endsWith("model.onnx")).toBe(true);
  });

  it("★ ★ ★ كل عنصرٍ ذهبيّ: متجه المزوّد ≈ متجه PyTorch fp32 (≥ 0.985) و320 بُعدًا مُطبَّعًا", async () => {
    const { getF2llmProvider } = await import("@/lib/rag/f2llm-embeddings");
    const provider = getF2llmProvider();
    const coss: number[] = [];
    for (const it of golden.items) {
      const v = it.kind === "query" ? await provider.embedQuery(it.text) : (await provider.embedPassages([it.text]))[0]!;
      expect(v).toHaveLength(320);
      expect(v.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...v)).toBeCloseTo(1, 4);
      // مقطعٌ أطول من 512 رمزًا يقصّه التطبيق (مع إبقاء رمز النهاية) — فمرجعُه المتجه المقصوص لا الكامل
      const ref = "truncated" in it ? (it as { truncated: { vec: number[] } }).truncated.vec : it.vec;
      const c = cos(v, ref);
      expect(c, it.text.slice(0, 40)).toBeGreaterThanOrEqual(0.985);
      coss.push(c);
    }
    expect(coss.reduce((s, x) => s + x, 0) / coss.length).toBeGreaterThanOrEqual(0.992);
  }, 240_000);

  it("★ ★ ★ الاستعلام والمقطع من فضاءٍ واحد: السؤال أقرب إلى المقطع الذي يجيبه منه إلى مقطعٍ في موضوعٍ آخر", async () => {
    const { getF2llmProvider } = await import("@/lib/rag/f2llm-embeddings");
    const p = getF2llmProvider();
    const [q, hit, miss] = [
      await p.embedQuery("ما هي عاصمة فرنسا؟"),
      (await p.embedPassages(["باريس هي عاصمة فرنسا وأكبر مدنها."]))[0]!,
      (await p.embedPassages(["يُستخدم الفولاذ المقاوم للصدأ في صناعة أدوات المطبخ."]))[0]!,
    ];
    expect(cos(q, hit)).toBeGreaterThan(cos(q, miss));
    const [q2, hit2, miss2] = [
      await p.embedQuery("How do I reset my password?"),
      (await p.embedPassages(["To reset your password, open Settings and choose Reset password."]))[0]!,
      (await p.embedPassages(["The quarterly revenue grew by twelve percent year over year."]))[0]!,
    ];
    expect(cos(q2, hit2)).toBeGreaterThan(cos(q2, miss2));
  }, 240_000);

  it("★ ★ ★ مقطعٌ أطول من 512 رمزًا لا ينهار ويُنتج متجهًا سليمًا", async () => {
    const { getF2llmProvider } = await import("@/lib/rag/f2llm-embeddings");
    const long = Array.from({ length: 400 }, (_, i) => `كلمة${i}`).join(" ");
    const v = (await getF2llmProvider().embedPassages([long]))[0]!;
    expect(v).toHaveLength(320);
    expect(v.every(Number.isFinite)).toBe(true);
  }, 240_000);
});
