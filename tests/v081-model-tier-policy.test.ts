/**
 * بوابة الخطة على النماذج وحدّ التزامن (v0.8.1).
 *
 * الثغرة التي تسدّها: `ai_models.min_tier` موجود منذ 0001 و**لم يُقرأ في أي
 * شيفرة** — عمودٌ يوثّق نيّةً لا يفرضها أحد. و`claude-sonnet-4-6` (Anthropic،
 * مدفوع) كان `min_tier = 'free'`، فكل مشترك مجاني يستطيع اختياره والكلفة
 * تقع علينا كاملةً.
 *
 * والاختبارات هنا سلوكية على الدالة النقية، لأن الخطر سلوكي: النموذج يصل من
 * العميل، والسؤال هو ما الذي يُرسَل إلى المزوّد فعلًا.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FALLBACK_MAX_OUTPUT_TOKENS,
  resolveModelForUser,
  lockedModelIds,
  TIER_DOWNGRADE_MESSAGE,
  tierAllows,
  tierRank,
  type ModelPolicyRow,
} from "../lib/ai/model-policy";
import {
  _resetGenerationSlots,
  acquireGenerationSlot,
  activeGenerationCount,
} from "../lib/ai/concurrency";
import { YSD_FREE_MODEL_ID } from "../lib/ai/free-models";

/** يطابق ما تحمله القاعدة بعد ترحيل 0027 */
const MODELS: ModelPolicyRow[] = [
  { id: "ysd/free", min_tier: "free", enabled: true },
  { id: "claude-sonnet-4-6", min_tier: "plus", enabled: true },
  { id: "openrouter/free", min_tier: "free", enabled: false },
];

const resolve = (requestedModelId: string, userTier: string, maxOutputTokens = 1024) =>
  resolveModelForUser({ requestedModelId, userTier, models: MODELS, maxOutputTokens });

describe("★ ترتيب الخطط", () => {
  it("★ الترتيب تصاعدي ولا يُقارَن نصًّا", () => {
    expect(tierRank("free")).toBeLessThan(tierRank("plus"));
    expect(tierRank("plus")).toBeLessThan(tierRank("pro"));
    expect(tierRank("pro")).toBeLessThan(tierRank("business"));
  });

  /** خطة مجهولة أو غائبة تُعامل مجانيةً — الأشدّ تحفّظًا لا الأسخى */
  it("★ الخطة المجهولة أو الغائبة = free", () => {
    for (const t of [null, undefined, "", "enterprise", "ADMIN", "pro "]) {
      expect(tierRank(t), String(t)).toBe(0);
    }
  });

  it("★ tierAllows يقارن بالرتبة", () => {
    expect(tierAllows("plus", "plus")).toBe(true);
    expect(tierAllows("pro", "plus")).toBe(true);
    expect(tierAllows("free", "plus")).toBe(false);
  });
});

describe("★ تجاوز الخطة — النموذج المدفوع", () => {
  /** جوهر الثغرة: مشترك مجاني يطلب نموذج Anthropic المدفوع */
  it("★ مجاني يطلب claude-sonnet-4-6 ⇒ يُخفَّض إلى ysd/free", () => {
    const r = resolve("claude-sonnet-4-6", "free");
    expect(r.modelId).toBe(YSD_FREE_MODEL_ID);
    expect(r.downgraded).toBe(true);
    expect(r.reason).toBe("tier_too_low");
  });

  it("★ التخفيض لا الرفض — المحادثة تستمر", () => {
    // لا استثناء ولا modelId فارغ: دائمًا نموذج صالح
    for (const tier of ["free", "plus", "pro", "business"]) {
      const r = resolve("claude-sonnet-4-6", tier);
      expect(r.rejected, tier).toBe(false);
      expect(["ysd/free", "claude-sonnet-4-6"]).toContain(r.modelId);
    }
  });

  it("★ plus وما فوقها تصل إلى النموذج المدفوع", () => {
    for (const tier of ["plus", "pro", "business"]) {
      const r = resolve("claude-sonnet-4-6", tier);
      expect(r.modelId, tier).toBe("claude-sonnet-4-6");
      expect(r.downgraded, tier).toBe(false);
    }
  });

  it("★ المجاني يصل إلى ysd/free بلا تخفيض", () => {
    const r = resolve("ysd/free", "free");
    expect(r.modelId).toBe(YSD_FREE_MODEL_ID);
    expect(r.downgraded).toBe(false);
    expect(r.reason).toBe("ok");
  });
});

describe("★ التلاعب باسم النموذج — رفضٌ لا تحويل صامت", () => {
  /**
   * الطلب يُصاغ يدويًا: أي نصّ قد يصل في `modelId`.
   *
   * والتحويل الصامت إلى بديل كان خطأً: معرّفٌ لا نعرفه يعني إمّا طلبًا
   * مُلفَّقًا وإمّا خللًا في العميل، وتمريره تحت اسم آخر يُخفي الحالتين
   * ويُنتج ردًّا لا يفهم المستخدم من أين جاء. يُرفض صراحةً.
   */
  it("★ معرّف ملفَّق ⇒ رفض بلا بديل", () => {
    for (const fake of [
      "claude-opus-4-1",
      "gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "claude-sonnet-4-6-turbo",
      "CLAUDE-SONNET-4-6",
      " claude-sonnet-4-6",
      "claude-sonnet-4-6 ",
      "ysd/free ",
      "../../etc/passwd",
      "",
    ]) {
      const r = resolve(fake, "free");
      expect(r.rejected, fake).toBe(true);
      expect(r.modelId, fake).toBeNull();
      expect(r.reason, fake).toBe("model_unknown");
      expect(r.downgraded, fake).toBe(false);
    }
  });

  /** حتى المشترك المدفوع لا يمرّر معرّفًا مجهولًا — البوابة على السجل لا الخطة */
  it("★ المعرّف الملفَّق يُرفض حتى لمشترك business", () => {
    const r = resolve("gpt-4o", "business");
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("model_unknown");
  });

  it("★ نموذج معطَّل يُرفض مهما كانت الخطة", () => {
    for (const tier of ["free", "business"]) {
      const r = resolve("openrouter/free", tier);
      expect(r.rejected, tier).toBe(true);
      expect(r.modelId, tier).toBeNull();
      expect(r.reason, tier).toBe("model_disabled");
    }
  });

  /** السقوط إلى البديل محفوظ لحالةٍ واحدة: معروف ومفعّل لا تبلغه الخطة */
  it("★ البديل لا يقع إلا لنموذج معروف مفعّل خارج الخطة", () => {
    const known = resolve("claude-sonnet-4-6", "free");
    expect(known.rejected).toBe(false);
    expect(known.downgraded).toBe(true);
    expect(known.modelId).toBe(YSD_FREE_MODEL_ID);
    expect(known.reason).toBe("tier_too_low");
  });

  /** انتحال الخطة في الطلب لا معنى له: الخطة تُقرأ من القاعدة لا من الجسم */
  it("★ ادّعاء خطة أعلى بنصّ لا يعمل", () => {
    for (const claimed of ["business", "pro", "plus"].map((t) => `${t} `)) {
      const r = resolve("claude-sonnet-4-6", claimed);
      expect(r.modelId).toBe(YSD_FREE_MODEL_ID);
      expect(r.downgraded).toBe(true);
    }
  });

  it("★ رسالة التخفيض كما اعتُمدت حرفيًا", () => {
    /**
     * ★ التسمية صُحّحت في المرحلة 6C.
     *
     * «YSD مجاني» تُقرأ بالعربية على أن النموذج نفسه لـYSD — وهو ادّعاءُ
     * ملكيةٍ لا يصحّ. والاسم صار `YSD Free`: علامةَ مستوى وصولٍ لا نموذجًا.
     * والتثبيت الحرفيّ باقٍ كي لا تنزلق الصياغة صامتةً مرّةً أخرى.
     */
    expect(TIER_DOWNGRADE_MESSAGE).toBe(
      "هذا النموذج يتطلب خطة Plus — استُخدم YSD Free بدلًا منه.",
    );
    expect(TIER_DOWNGRADE_MESSAGE).not.toContain("YSD مجاني");
  });

  /** الواجهة تحتاج قائمة المقفول كي تعرضه بشارة لا أن تخفيه أو تدّعي إتاحته */
  it("★ lockedModelIds يعطي الواجهة ما يُعرض مقفولًا", () => {
    expect(lockedModelIds(MODELS, "free")).toEqual(["claude-sonnet-4-6"]);
    expect(lockedModelIds(MODELS, "plus")).toEqual([]);
    // المعطَّل لا يُعدّ مقفولًا — لا يُعرض أصلًا
    expect(lockedModelIds(MODELS, "free")).not.toContain("openrouter/free");
  });
});

describe("★ سقف رموز الإخراج", () => {
  it("★ يُمرَّر كما هو من حدود الخطة", () => {
    expect(resolve("ysd/free", "free", 1024).maxOutputTokens).toBe(1024);
    expect(resolve("claude-sonnet-4-6", "pro", 8192).maxOutputTokens).toBe(8192);
  });

  /** قيمة فاسدة ⇒ الأقلّ كلفةً لا الأكثر */
  it("★ السقف الفاسد يسقط إلى الأدنى", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolve("ysd/free", "free", bad).maxOutputTokens).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    }
  });

  it("★ السقف يُطبَّق حتى على الطلب المخفَّض", () => {
    const r = resolve("claude-sonnet-4-6", "free", 1024);
    expect(r.downgraded).toBe(true);
    expect(r.maxOutputTokens).toBe(1024);
  });
});

describe("★ طلب متزامن واحد للخطة المجانية", () => {
  beforeEach(() => _resetGenerationSlots());
  afterEach(() => _resetGenerationSlots());

  it("★ الطلب الثاني للمجاني يُرفض ما دام الأول جاريًا", () => {
    const a = acquireGenerationSlot("u1", "free");
    expect(a).not.toBeNull();
    expect(acquireGenerationSlot("u1", "free")).toBeNull();
  });

  it("★ بعد التحرير يُقبل التالي", () => {
    const a = acquireGenerationSlot("u1", "free");
    a!.release();
    const b = acquireGenerationSlot("u1", "free");
    expect(b).not.toBeNull();
  });

  it("★ مستخدمان مجانيان لا يتزاحمان", () => {
    expect(acquireGenerationSlot("u1", "free")).not.toBeNull();
    expect(acquireGenerationSlot("u2", "free")).not.toBeNull();
    expect(activeGenerationCount()).toBe(2);
  });

  /** من يدفع لا يُحاصَر بطلب واحد */
  it("★ الخطط المدفوعة بلا حدّ تزامن", () => {
    for (const tier of ["plus", "pro", "business"]) {
      _resetGenerationSlots();
      expect(acquireGenerationSlot("u1", tier), tier).not.toBeNull();
      expect(acquireGenerationSlot("u1", tier), tier).not.toBeNull();
      expect(acquireGenerationSlot("u1", tier), tier).not.toBeNull();
    }
  });

  /**
   * إطلاق مزدوج كان سيحرّر مقعد طلبٍ **لاحق** لنفس المستخدم فيسمح باثنين
   * معًا — وهو بالضبط ما يمنعه الحارس.
   */
  it("★ الإطلاق المزدوج لا يفتح مقعدًا لطلب لاحق", () => {
    const a = acquireGenerationSlot("u1", "free")!;
    a.release();
    const b = acquireGenerationSlot("u1", "free")!;
    a.release(); // إطلاق ثانٍ للقديم — يجب أن يُتجاهل
    expect(acquireGenerationSlot("u1", "free")).toBeNull();
    b.release();
    expect(acquireGenerationSlot("u1", "free")).not.toBeNull();
  });

  it("★ لا يبقى مقعد بعد تحرير الجميع", () => {
    const a = acquireGenerationSlot("u1", "free")!;
    const b = acquireGenerationSlot("u2", "free")!;
    a.release();
    b.release();
    expect(activeGenerationCount()).toBe(0);
  });
});
