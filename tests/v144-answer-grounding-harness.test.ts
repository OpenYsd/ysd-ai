import { describe, expect, it } from "vitest";
import {
  CASES,
  newNumbers,
  applyExpectedProvider,
  EXPECTED_MODE,
  buildPdf,
  conversationFiles,
  parseSse,
  refuseReason,
  serviceWriteAllowed,
  verdictFor,
  type ConversationKey,
} from "../scripts/reliability/answer-grounding-lib";
import { MAX_CONTEXT_CHARS } from "@/lib/rag/retrieval";

/**
 * أداةُ قبول «الإجابة من الملف» (scripts/reliability/answer-grounding.ts) — أجزاؤها الخالصة.
 *
 * ★ المقيس: حرّاسُ الإنتاج، وحكمُ كلّ سؤال (عطلُ المزوّد ليس نجاحًا أبدًا، والتسرّبُ يغلب كلَّ شيء)،
 *   وأنّ الحقائق المنتظرة موجودةٌ فعلًا في ملفّات محادثتها — وأنّ حقائقَ «التسرّب» غائبةٌ عنها وموجودةٌ
 *   في محادثاتٍ أخرى، فلا يُنسب إلى النموذج ما لا مصدرَ له.
 */

const docText = (key: ConversationKey) => conversationFiles(key).map((f) => f.bytes.toString(f.mime === "application/pdf" ? "latin1" : "utf8")).join("\n");

describe("★ الحرّاس", () => {
  const prod = "https://mnewsldyrrlpmouetyve.supabase.co";
  it("★ ★ ★ الإنتاجُ بلا العلَمين معًا يُرفض؛ وبهما يُسمح", () => {
    expect(refuseReason({ base: "https://ysd-ai-production.up.railway.app", supabaseUrl: prod, acceptance: false, allowProductionAcceptance: false })).toMatch(/production requires/);
    expect(refuseReason({ base: "https://ysd-ai-production.up.railway.app", supabaseUrl: prod, acceptance: true, allowProductionAcceptance: false })).toMatch(/production requires/);
    expect(refuseReason({ base: "https://ysd-ai-production.up.railway.app", supabaseUrl: prod, acceptance: true, allowProductionAcceptance: true })).toBeNull();
  });
  it("★ ★ ★ غيرُ الإنتاج لا يكون إلّا staging", () => {
    expect(refuseReason({ base: "https://ysd-ai-staging-staging.up.railway.app", supabaseUrl: "https://vwauyuukcbszljzifohs.supabase.co", acceptance: false, allowProductionAcceptance: false })).toBeNull();
    expect(refuseReason({ base: "https://example.com", supabaseUrl: "https://other.supabase.co", acceptance: false, allowProductionAcceptance: false })).toMatch(/staging only/);
    expect(refuseReason({ base: "", supabaseUrl: "", acceptance: false, allowProductionAcceptance: false })).toMatch(/required/);
  });
  it("★ ★ ★ وضعُ القبول: كتابةُ مفتاح الخدمة لدعوة الحساب الاصطناعيّ وحدها", () => {
    expect(serviceWriteAllowed(true, "GET", "messages?conversation_id=eq.x")).toBe(true);
    expect(serviceWriteAllowed(true, "POST", "beta_invites")).toBe(true);
    expect(serviceWriteAllowed(true, "POST", "rpc/beta_claim_invite")).toBe(true);
    expect(serviceWriteAllowed(true, "PATCH", "subscriptions?user_id=eq.x")).toBe(false);
    expect(serviceWriteAllowed(true, "DELETE", "files?id=eq.x")).toBe(false);
    expect(serviceWriteAllowed(true, "POST", "messages")).toBe(false);
  });
});

describe("★ الحكم", () => {
  const fact = CASES.find((c) => c.expect && c.conversation === "ar_en")!;
  const absent = CASES.find((c) => c.absent && !c.forbid)!;
  const probe = CASES.find((c) => c.forbid)!;
  const ok = (text: string) => ({ status: 200, text, completion: "complete" });
  it("★ ★ ★ عطلُ المزوّد ليس نجاحًا أبدًا", () => {
    expect(verdictFor(fact, { status: 200, text: "خفّض 37 بالمئة", completion: "incomplete_provider" })).toBe("INCONCLUSIVE_PROVIDER");
    expect(verdictFor(fact, { status: 502, text: "", completion: null })).toBe("INCONCLUSIVE_PROVIDER");
    expect(verdictFor(absent, ok("  "))).toBe("INCONCLUSIVE_PROVIDER");
  });
  it("★ ★ ★ الحقيقةُ المنتظرة ⇒ PASS، وغيرُها ⇒ FAIL", () => {
    expect(verdictFor(fact, ok("خفّض المشروع أوقات الانتظار بنسبة 37 بالمئة."))).toBe("PASS");
    expect(verdictFor(fact, ok("لم أجد هذه المعلومة في الملفات المرفقة."))).toBe("FAIL");
  });
  it("★ ★ ★ الغياب يُصرَّح به (PASS_ABSENT)؛ وجوابٌ بلا تصريح يُراجَع (CHECK_ABSENT)", () => {
    expect(verdictFor(absent, ok("لم أجد هذه المعلومة في الملفات المرفقة."))).toBe("PASS_ABSENT");
    expect(verdictFor(absent, ok("The provided CV does not mention his blood type."))).toBe("PASS_ABSENT");
    expect(verdictFor(absent, ok("فصيلة دمه O+."))).toBe("CHECK_ABSENT");
  });
  it("★ ★ ★ رفضٌ صريح بلا رقمٍ جديد ⇒ PASS_ABSENT؛ ورفضٌ يضيف رقمًا ⇒ مراجعة (نصوصٌ فعليّة من staging)", () => {
    const probe2 = CASES.find((c) => c.forbid && /volunteers/.test(c.q))!;
    const probe3 = CASES.find((c) => c.forbid && /تبوك/.test(c.q))!;
    expect(verdictFor(probe, ok("I don't have enough context to answer this question. You haven't specified which person or organization you're referring to, so I cannot provide an employee badge number."))).toBe("PASS_ABSENT");
    expect(verdictFor(probe2, ok("I don't have enough context to answer this question. Without knowing the exact campaign, any number I provided would be a guess."))).toBe("PASS_ABSENT");
    expect(verdictFor(probe3, ok("لست متأكدًا من الإيجار السنوي النهائي لمركز بيانات تبوك، ولا أملك الوصول إلى بيانات عقارية."))).toBe("PASS_ABSENT");
    // يذكر «رؤية السعودية 2030» مرجعًا — رقمٌ جديد، فيُراجَع بشريًّا ولا يُمرَّر آليًّا
    expect(verdictFor(probe3, ok("لست متأكدًا من الإيجار، راجع إعلانات رؤية السعودية 2030."))).toBe("CHECK_ABSENT");
    // تحوّطٌ يُخفي قيمةً مختلَقة
    expect(verdictFor(absent, ok("I'm not sure — it's not mentioned in the CV, but most likely around 45 units."))).toBe("CHECK_ABSENT");
    // رقمُ السؤال نفسُه ليس جديدًا
    const site14 = CASES.find((c) => c.absent && /Site 14/.test(c.q))!;
    expect(verdictFor(site14, ok("The budget approved for Site 14 renovations is not mentioned in the provided files."))).toBe("PASS_ABSENT");
  });

  it("★ ★ ★ newNumbers: أرقامٌ لاتينيّة وهنديّة وفواصل، والمذكورُ في السؤال مستثنى، والآحادُ مُهمَلة", () => {
    expect(newNumbers("What was the budget for Site 14?", "Site 14 had no budget; see item 3.")).toEqual([]);
    expect(newNumbers("كم؟", "بلغ ١٬٢٨٤٬٠٠٠ ريال أو 1,284,000")).toEqual(["1284000", "1284000"]);
    expect(newNumbers("q", "رؤية 2030")).toEqual(["2030"]);
  });

  it("★ ★ ★ التسرّبُ يغلب كلَّ شيء — ولو صرّح بالغياب", () => {
    expect(verdictFor(probe, ok("I could not find it, but the badge is QX-7741-ZETA."))).toBe("LEAK");
    expect(verdictFor(probe, ok("I don't know whose badge you mean; no file is attached."))).toBe("CHECK_ABSENT");
  });
});

describe("★ الحالاتُ والملفّات", () => {
  it("★ ★ ★ كلُّ حقيقةٍ منتظرة موجودةٌ فعلًا في ملفّات محادثتها", () => {
    for (const c of CASES.filter((x) => x.expect)) for (const re of c.expect!) expect(docText(c.conversation), c.q).toMatch(re);
  });
  it("★ ★ ★ حقائقُ التسرّب: غائبةٌ عن محادثة السؤال، وموجودةٌ في محادثةٍ أخرى", () => {
    for (const c of CASES.filter((x) => x.forbid)) {
      expect(c.conversation).toBe("empty");
      expect(conversationFiles(c.conversation)).toHaveLength(0);
      for (const re of c.forbid!) expect((["ar_en", "en_ar", "multi", "small"] as const).some((k) => re.test(docText(k))), c.q).toBe(true);
    }
  });
  it("★ ★ ★ الأولويّة: عربيٌّ عن مستندٍ إنجليزيٍّ طويل أوّلًا؛ وكلُّ محادثةٍ مغطّاة", () => {
    expect(CASES[0]!.conversation).toBe("ar_en");
    expect(/[؀-ۿ]/.test(CASES[0]!.q)).toBe(true);
    expect(new Set(CASES.map((c) => c.conversation))).toEqual(new Set(Object.keys(EXPECTED_MODE)));
  });
  it("★ ★ ★ الطويلُ يتجاوز ميزانيّة القراءة الكاملة (بحث)، والقصيرُ دونها (قراءةٌ كاملة)", () => {
    const utf8Len = (k: ConversationKey) => conversationFiles(k).reduce((n, f) => n + (f.mime === "application/pdf" ? 0 : f.bytes.toString("utf8").length), 0);
    expect(utf8Len("en_ar")).toBeGreaterThan(MAX_CONTEXT_CHARS);
    expect(EXPECTED_MODE.ar_en).toBe("search");
    expect(EXPECTED_MODE.small).toBe("full");
  });
  it("★ ★ ★ PDF صالحٌ بنيويًّا: رأس، وصفحةٌ لكلّ 48 سطرًا، وجدولُ إزاحات", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line (${i}) \\ end`);
    const pdf = buildPdf(lines).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toContain("/Count 3");
    expect(pdf).toMatch(/xref\n0 \d+\n0000000000 65535 f \n/);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("(line \\(7\\) \\\\ end) Tj");
  });
});

describe("★ قراءةُ البثّ", () => {
  it("★ ★ ★ يجمع إطاراتِ النصّ ويتجاهل غيرَها والتالف", () => {
    const raw = ['data: {"type":"meta"}', 'data: {"type":"text","text":"خفّض "}', "data: {broken", 'data: {"type":"text","text":"37%"}', 'data: {"type":"done"}'].join("\n\n");
    expect(parseSse(raw)).toEqual({ text: "خفّض 37%", events: ["meta", "text", "text", "done"] });
  });
});

describe("★ المزوّدُ الذي أجاب فعلًا", () => {
  it("★ ★ ★ مع --expect-provider: جوابٌ من مزوّدٍ آخر (احتياط) لا يُحسب؛ وعطلُ المزوّد يبقى كما هو", () => {
    expect(applyExpectedProvider("PASS", "ysd", "ysd")).toBe("PASS");
    expect(applyExpectedProvider("PASS", "ysd", "openrouter")).toBe("INCONCLUSIVE_MODEL");
    expect(applyExpectedProvider("LEAK", "ysd", undefined)).toBe("INCONCLUSIVE_MODEL");
    expect(applyExpectedProvider("INCONCLUSIVE_PROVIDER", "ysd", "openrouter")).toBe("INCONCLUSIVE_PROVIDER");
    expect(applyExpectedProvider("FAIL", null, "openrouter")).toBe("FAIL");
  });
});
