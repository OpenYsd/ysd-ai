/**
 * تطبيع أسماء الكيانات (v0.6.5 RC5) — النقحرة العربية لأسماء الألعاب والمنتجات.
 * اختبارات نقية بلا شبكة.
 */
import { describe, expect, it } from "vitest";
import {
  ENTITY_ALIASES,
  ambiguousCandidates,
  buildClarifyQuestion,
  buildEntityContext,
  confidentEntities,
  detectEntities,
  normalizeForMatch,
} from "../lib/ai/entity-aliases";

const TESTER_Q =
  "في الدن رينق تعرف القناع الأبيض اللي يعطيك ضرر إضافي لما تعطي نفسك نزف، كيف أجيبه؟";

describe("★ النقحرة العربية → الاسم الموحّد", () => {
  it("«الدن رينق» → Elden Ring", () => {
    const e = detectEntities("في الدن رينق كيف أطوّر سلاحي؟");
    expect(e.map((x) => x.canonical)).toContain("Elden Ring");
  });

  it("«إلدن رينغ» → Elden Ring", () => {
    const e = detectEntities("سؤال عن إلدن رينغ من فضلك");
    expect(e.map((x) => x.canonical)).toContain("Elden Ring");
  });

  it("سؤال المختبِر نفسه يُتعرَّف عليه", () => {
    expect(detectEntities(TESTER_Q).map((x) => x.canonical)).toContain("Elden Ring");
  });

  it("صور أخرى: الدن رينج / ايلدن رينق", () => {
    expect(detectEntities("الدن رينج").map((x) => x.canonical)).toContain("Elden Ring");
    expect(detectEntities("ايلدن رينق").map((x) => x.canonical)).toContain("Elden Ring");
  });

  it("النص الإنجليزي Elden Ring يُتعرَّف عليه ولا يتغيّر", () => {
    const text = "How do I get the White Mask in Elden Ring?";
    expect(detectEntities(text).map((x) => x.canonical)).toContain("Elden Ring");
    expect(text).toBe("How do I get the White Mask in Elden Ring?"); // النص كما هو
  });

  it("التطبيع يشمل الهمزات وي/ى وة/ه وق/غ والمسافات", () => {
    expect(normalizeForMatch("إلدن   رينغ")).toBe(normalizeForMatch("الدن رينق"));
    expect(normalizeForMatch("آلْدن رينغ")).toBe(normalizeForMatch("الدن رينق"));
  });
});

describe("★ لا تحويل خاطئ", () => {
  it("اسم غير معروف لا يُحوَّل", () => {
    expect(detectEntities("في لعبة زيلدا كيف أحصل على السيف؟")).toEqual([]);
    expect(detectEntities("ما رأيك في لعبة ما؟")).toEqual([]);
  });

  it("نص عادي بلا أسماء لا يُطابِق شيئًا", () => {
    expect(detectEntities("كيف حالك اليوم؟")).toEqual([]);
    expect(detectEntities("")).toEqual([]);
  });

  it("البنية قابلة للتوسعة — تشمل ألعابًا ومنتجات", () => {
    expect(ENTITY_ALIASES.length).toBeGreaterThan(1);
    expect(detectEntities("افتح فوتوشوب").map((x) => x.canonical)).toContain("Photoshop");
    expect(detectEntities("في ماين كرافت").map((x) => x.canonical)).toContain("Minecraft");
  });
});

describe("★ السياق الداخلي — يمنع سؤال المستخدم عن الاسم", () => {
  const ctx = buildEntityContext(detectEntities(TESTER_Q));

  it("يذكر الاسم الموحّد صراحةً", () => {
    expect(ctx).toContain("Elden Ring");
  });

  it("★ ينهى صراحةً عن سؤال المستخدم عن اسم اللعبة", () => {
    expect(ctx).toMatch(/لا تسأل المستخدم عن اسم اللعبة أو المنتج/);
    expect(ctx).toMatch(/اللعبة التي تقصدها/); // العبارة المرصودة حيًّا ممنوعة
  });

  it("★ يعطي صيغة الاعتراف مع ذكر الاسم بدل السؤال", () => {
    expect(ctx).toMatch(/عرفت أنك تقصد Elden Ring/);
    expect(ctx).toMatch(/غير متأكد من خطوات الحصول على/);
    expect(ctx).toMatch(/ولا أبغى أعطيك معلومة خاطئة/);
  });

  it("★ ينهى عن اختراع المواقع والخطوات", () => {
    expect(ctx).toMatch(/لا تخترع مواقع أو خطوات/);
  });

  it("بلا كيانات → لا سياق إطلاقًا (الموجّه لا يتغيّر)", () => {
    expect(buildEntityContext([])).toBe("");
  });
});

// ── v0.6.6: فصل الأعمال المتشابهة + confidence/entity_type ────────────────
describe("★ v0.6.6 — JoJo ليست Jujutsu Kaisen", () => {
  it("★ «جوجيتسو كايسن» → Jujutsu Kaisen وحدها", () => {
    const e = confidentEntities("ابغى اعرف عن جوجيتسو كايسن");
    expect(e.map((x) => x.canonical)).toEqual(["Jujutsu Kaisen"]);
    expect(e[0]!.entityType).toBe("anime_manga");
  });

  it("★ «مغامرة جوجو الغريبة» → JoJo وحدها", () => {
    const e = confidentEntities("احب مغامرة جوجو الغريبة");
    expect(e.map((x) => x.canonical)).toEqual(["JoJo's Bizarre Adventure"]);
  });

  it("★ «جوجو» وحدها ملتبسة → لا تحويل تلقائي", () => {
    expect(confidentEntities("ايش رايك في جوجو؟")).toEqual([]);
    const amb = ambiguousCandidates("ايش رايك في جوجو؟");
    expect(amb.length).toBeGreaterThan(0);
    expect(amb.some((a) => a.canonical === "JoJo's Bizarre Adventure")).toBe(true);
  });

  it("★ «جوجيتسو» لا تُطابق alias «جوجو» (حدود الكلمات)", () => {
    const names = detectEntities("جوجيتسو كايسن").map((x) => x.canonical);
    expect(names).not.toContain("JoJo's Bizarre Adventure");
  });

  it("★ سؤال توضيح مختصر عند الالتباس", () => {
    const q = buildClarifyQuestion(ambiguousCandidates("ايش رايك في جوجو؟"));
    expect(q).toMatch(/تقصد/);
    expect(q.length).toBeLessThan(200); // مختصر
  });

  it("★ ذكر العملين معًا → التباس لا خلط", () => {
    const amb = ambiguousCandidates("قارن بين جوجيتسو كايسن ومغامرة جوجو الغريبة");
    expect(amb.length).toBe(2);
  });

  it("السياق ينبّه صراحةً على عدم الخلط", () => {
    const ctx = buildEntityContext(confidentEntities("عن جوجيتسو كايسن"));
    expect(ctx).toMatch(/Jujutsu Kaisen/);
    expect(ctx).toMatch(/عمل مختلف تمامًا عن JoJo's Bizarre Adventure/);
    expect(ctx).toMatch(/لا تخلط بينهما/);
  });

  it("Elden Ring يبقى واثقًا كما كان (بلا تراجع)", () => {
    const e = confidentEntities(TESTER_Q);
    expect(e.map((x) => x.canonical)).toContain("Elden Ring");
    expect(e[0]!.entityType).toBe("video_game");
    expect(e[0]!.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe("★ رسالة المستخدم لا تُعدَّل", () => {
  it("detectEntities لا يغيّر النص الممرَّر", () => {
    const original = "في الدن رينق تعرف القناع الأبيض؟";
    const copy = original;
    detectEntities(original);
    expect(original).toBe(copy);
  });

  it("الطبقة تُنتج سياقًا منفصلًا لا نصًا بديلًا للمستخدم", () => {
    const ctx = buildEntityContext(detectEntities(TESTER_Q));
    // السياق كتلة تعليمات للنموذج، لا إعادة صياغة لرسالة المستخدم
    expect(ctx).toContain("سياق أسماء (داخلي");
    expect(ctx).not.toContain("كيف أجيبه؟");
  });
});
