import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatherChatContext } from "@/lib/chat/context";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";
import type { ChatMessage } from "@/lib/ai/types";
import { deriveRetrievalQuery, followUpLexicon, isBareContinuation, normalizeFollowUp } from "@/lib/chat/retrieval-query";

/**
 * «كمل» / «continue» في محادثةٍ فيها ملفّات: الاسترجاعُ للسؤال الذي يُكمَل، لا للكلمة.
 *
 * ★ العطل (مرصودٌ على staging): بعد جوابٍ مستنِدٍ إلى الملفّات قُطع بثُّه، كتب المستخدم «continue». السياقُ وصل النموذجَ
 *   صحيحًا (السؤال + الجزء المكتوب + «continue»)، لكنّ الاسترجاع ضمَّن كلمةَ «continue» نفسَها وبحث بها (أعلى تشابه 0.281)
 *   فجاءت مقاطعُ لا صلةَ لها، وقال النموذج إنّ المصادر لا تحوي الجواب.
 *
 * ★ الإصلاح: دالّةٌ نقيّة (lib/chat/retrieval-query.ts). إن كانت رسالةُ الدور «متابعةً مجرّدة» (معجمٌ ضيّق بالعربيّة
 *   والإنجليزيّة: كمل / أكمل / تابع / استمر / continue / go on …، مع كلماتِ مجاملةٍ فقط) صار استعلامُ الاسترجاع آخرَ سؤالٍ
 *   حقيقيٍّ في سياق النموذج المبنيّ (`history`) — وهو سياقٌ لا يحوي إشعاراتِ الفشل ولا أسئلةً بلا جواب، ومحصورٌ في هذه
 *   المحادثة. وأيُّ رسالةٍ أخرى تبقى استعلامَها حرفًا بحرف. لا تضمينَ إضافيًّا ولا رحلةَ قاعدةٍ إضافيّة.
 */

// ─── صفوفُ القاعدة كما يحفظها المسار (من v147) ───
const NOTICE = ERROR_MESSAGES.provider_unavailable;
interface Row { role: string; content: string; metadata?: unknown; created_at: string }
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 6, 0, 0, clock++)).toISOString();
const user = (content: string): Row => ({ role: "user", content, created_at: at() });
const asst = (content: string, metadata?: unknown): Row => ({ role: "assistant", content, metadata, created_at: at() });
const partial = (content: string, reason = "stream_interrupted") => asst(content, { provider: "openrouter", completion: { status: "incomplete_provider", reason, notice: false, failure_notice: false } });
const legacyPartial = (content: string, reason = "stream_interrupted") => asst(content, { provider: "openrouter", completion: { status: "incomplete_provider", reason, notice: false } });
const notice = () => asst(NOTICE, { completion: { status: "incomplete_provider", reason: "provider_unavailable", notice: false, failure_notice: true } });
const legacyNotice = () => asst(NOTICE, { provider: "openrouter", completion: { status: "incomplete_provider", reason: "provider_unavailable", notice: false } });

function fakeSupabase(rows: Row[]) {
  let ascending = true;
  const messages = {
    select() { return this; },
    eq() { return this; },
    is() { return this; },
    order(_c: string, o?: { ascending?: boolean }) { ascending = o?.ascending ?? true; return this; },
    limit(n: number) {
      const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) * (ascending ? 1 : -1));
      return Promise.resolve({ data: sorted.slice(0, n), error: null });
    },
  };
  const other = {
    select() { return this; },
    eq() { return Promise.resolve({ data: [], error: null }); },
    update() { return { eq: () => Promise.resolve({ data: null, error: null }) }; },
    is() { return this; },
    order() { return this; },
    limit() { return Promise.resolve({ data: [], error: null }); },
    in() { return Promise.resolve({ data: [], error: null }); },
  };
  return { from: (t: string) => (t === "messages" ? messages : other) };
}
async function historyFor(rows: Row[]): Promise<ChatMessage[]> {
  const res = await gatherChatContext(fakeSupabase(rows) as never, { conversationId: "c", userId: "u", projectId: null, convUpdate: {}, requestId: "r" } as never);
  return res.history;
}
/** ما يفعله المسار: نصُّ الدور = الرسالة، أو آخرُ دورِ مستخدمٍ في السياق عند إعادة التوليد */
async function queryFor(rows: Row[], message?: string) {
  const history = await historyFor(rows);
  const turn = message ?? [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  return deriveRetrievalQuery(turn, history);
}

const Q_EN = "What does the handbook say about the night shift meal allowance and visitor lanyards?";
const CUT_EN = "Employees who work the night shift receive a meal allowance of";
const Q_AR = "ماذا يقول دليل التشغيل عن مراجعة المخزون الشاملة ومسؤولة السلامة؟";
const CUT_AR = "تُجرى مراجعة المخزون الشاملة في";

beforeEach(() => {
  clock = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ════════════════════════════════════════════════════════════

describe("★ (١) تصنيفُ المتابعة المجرّدة — بالعربيّة والإنجليزيّة", () => {
  const POSITIVE = [
    "continue", "Continue.", "CONTINUE!!", "continueee", "go on", "ok, go on", "keep going", "carry on", "go ahead", "proceed", "more",
    "tell me more", "next", "finish the answer", "can you continue?", "continue from where you left off please", "continue in Arabic",
    "the rest", "show me the rest", "complete the answer", "please continue your answer",
    "كمل", "كمّل", "كَمِّلْ", "أكمل", "إكمل", "كـمـل", "كمللل", "کمل", "كمل؟", "تابع", "استمر", "واصل الكتابة", "كمل الجواب",
    "أكمل من حيث توقفت لو سمحت", "من فضلك أكمل الإجابة", "الباقي", "والباقي؟", "هات الباقي", "طيب كمل", "وكمل", "ممكن تكمل؟",
    "كمل بالعربي", "المزيد", "أكمل الرد", "استمر من فضلك", "كمل كلامك",
    // خليجيّة شائعة
    "تقدر تكمل؟", "ممكن تكملين", "كمل الله يخليك", "كمل يعطيك العافية", "كمل اللي باقي", "عطني الباقي", "زين كمل", "اي كمل", "ايوا كمل",
    "ممكن تتابع", "ممكن تستمر", "وهل تقدر تكمل", "ولو سمحت كمل",
    // فصحى رسميّة
    "يرجى الإكمال", "الرجاء إكمال الإجابة", "يرجى الاستكمال", "يرجى استكمال الإجابة", "هل يمكنك الاستمرار", "تتمة الجواب", "أتم الإجابة",
    // بعد ملاحظة الانقطاع
    "الرد انقطع، كمل", "أكمل من حيث توقف", "أكمل من حيث انقطع", "كمل الإجابة السابقة", "استمر في الإجابة", "استمر بالشرح",
    // مصريّة وشاميّة
    "فين الباقي؟", "فين وقفت", "اديني الباقي", "كمل بقى", "كمل كده", "منيح كمل", "يالله كمل", "كمان شوي", "كمل كمان شوي",
    // مجاملةٌ مضاعفة (١٠ كلمات)
    "من فضلك أكمل الإجابة من حيث توقفت لو سمحت", "Can you please continue your answer from where you left off?",
    "you got cut off, continue", "continue your last answer", "continue the previous response", "pick up where it left off",
    "pick up where it stopped", "continue from where you left off, thanks",
  ];
  const NEGATIVE = [
    "ما عاصمة اليابان؟", "What is the capital of Japan?", "continue the story of chapter 3", "continue from step 3", "كمل من النقطة 4",
    "more examples from file 2", "When does the project finish?", "المزيد عن البند الخامس", "كم الباقي؟", "don't continue", "لا تكمل",
    "stop", "resume", "rest", "go", "next.js", "continue statement", "carry on luggage allowance", "الشركة التابعة", "ok", "yes", "نعم",
    "تمام", "thanks", "من الباقي؟", "where next?", "what's next?", "try again", "more details", "اشرح أكثر", "pgvector", "الراتب", "why?",
    "لخص", "فواصل", "", "   ", "...", "؟!", "🙂", "a".repeat(81), "please please please please please please please please please please please please continue",
    "How much is the meal allowance for the night shift?", "من مسؤولة السلامة في الفرع الشرقي؟", "sales of 2024", "كمل 3",
    // خارجَ النطاق عمدًا (كلمةُ محتوى): تبقى حرفيّة كما اليوم
    "complete the table", "finish the list", "next section", "more examples", "كمل الجدول", "أكمل القائمة", "كمل يا صديقي",
    "توقف", "انقطع", "من توقف؟", "ما تبقى من الميزانية؟", "كمل ولا لا؟", "هل الرد مكتمل؟", "الطلب واصل؟", "اشرح الباقي",
    // كلماتُ معجمٍ هي أيضًا أسماءُ محتوى في وثائق المستخدم — تبقى حرفيّة (مراجعةُ المصنِّف)
    "the cut-off?", "was the pick-up complete?", "tell me more about part II", "complete part A", "tell me about Moore", "in Finnish",
    "tell me more about the will", "tell me more about the sentence", "more explanation please", "هل في متابعة؟", "في تواصل؟",
    "أي متابعة؟", "finish your sentence", "please continue, the answer was cut off",
  ];
  it.each(POSITIVE)("★ ★ ★ متابعة: %s", (text) => expect(isBareContinuation(text)).toBe(true));
  it.each(NEGATIVE)("★ ★ ★ ليست متابعة: %j", (text) => expect(isBareContinuation(text)).toBe(false));

  it("★ ★ ★ كلُّ مدخلات المعجم مخزّنةٌ بصيغتها المطبَّعة، ولا كلمةَ محتوى فيها", () => {
    const lex = followUpLexicon();
    for (const entry of [...lex.triggers, ...lex.pairs, ...lex.fillers]) {
      expect(normalizeFollowUp(entry)?.join(" ")).toBe(entry);
    }
    // كلمةُ محتوى واحدة في الحشو تُحوّل أسئلةً حقيقيّةً إلى متابعات — تُحرس بأمثلةٍ من الملفّات نفسها
    for (const word of ["allowance", "lanyard", "handbook", "inventory", "المخزون", "السلامة", "الفرع", "الوجبة", "بدل"]) {
      expect(lex.fillers).not.toContain(word);
      expect(lex.triggers).not.toContain(word);
    }
  });

  it("★ ★ ★ مدخلٌ غيرُ نصّيّ أو ضخم لا يرمي استثناءً ولا يُصنَّف متابعة", () => {
    expect(isBareContinuation(undefined as never)).toBe(false);
    expect(isBareContinuation(null as never)).toBe(false);
    expect(isBareContinuation(42 as never)).toBe(false);
    expect(isBareContinuation("كمل ".repeat(5000))).toBe(false);
  });
});

describe("★ (٢) الاستعلامُ المشتقّ من سياق النموذج — عبر gatherChatContext الحقيقيّة", () => {
  it("★ ★ ★ «continue» بعد جوابٍ جزئيٍّ مستنِدٍ إلى الملفّات ⇒ السؤالُ نفسُه (العلامةُ الصريحة والصفوفُ القديمة)", async () => {
    expect(await queryFor([user(Q_EN), partial(CUT_EN), user("continue")], "continue")).toEqual({ text: Q_EN, source: "continued" });
    expect(await queryFor([user(Q_EN), legacyPartial(CUT_EN), user("continue")], "continue")).toEqual({ text: Q_EN, source: "continued" });
    expect(await queryFor([user(Q_EN), legacyPartial(CUT_EN, "runtime_stream_ended"), user("go on")], "go on")).toEqual({ text: Q_EN, source: "continued" });
  });

  it("★ ★ ★ «كمل» وصيغُها بعد جوابٍ جزئيٍّ عربيّ ⇒ السؤالُ العربيّ", async () => {
    for (const w of ["كمل", "كمّل", "أكمل", "كمل من فضلك", "تابع", "استمر"]) {
      expect(await queryFor([user(Q_AR), partial(CUT_AR), user(w)], w)).toEqual({ text: Q_AR, source: "continued" });
    }
  });

  it("★ ★ ★ سؤالٌ جديدٌ غيرُ متّصل بعد جوابٍ جزئيّ ⇒ الرسالةُ نفسُها حرفًا بحرف", async () => {
    const ar = "ما عاصمة اليابان؟ أجب بكلمة واحدة.";
    const en = "Who is the safety officer of the eastern branch?";
    expect(await queryFor([user(Q_AR), partial(CUT_AR), user(ar)], ar)).toEqual({ text: ar, source: "message" });
    expect(await queryFor([user(Q_EN), partial(CUT_EN), user(en)], en)).toEqual({ text: en, source: "message" });
    // سؤالٌ قصيرٌ بكلمةٍ واحدة بعد جوابٍ مقطوع: يبقى حرفيًّا (لا تخمينَ على الشكل)
    expect(await queryFor([user(Q_EN), partial(CUT_EN), user("pgvector")], "pgvector")).toEqual({ text: "pgvector", source: "message" });
  });

  it("★ ★ ★ إشعارُ فشلٍ ثمّ متابعة: السؤالُ الفاشل لا يُبعث أبدًا", async () => {
    // (أ) «كمل» فشلت ثمّ أُعيدت: السؤالُ الأصليّ
    expect(await queryFor([user(Q_AR), partial(CUT_AR), user("كمل"), notice(), user("كمل")], "كمل")).toEqual({ text: Q_AR, source: "continued" });
    // (ب) سؤالٌ فشل مرّتين (إشعارٌ قديم وجديد) ثمّ «continue»: يُكمَل آخرُ سؤالٍ أُجيب فعلًا، لا الفاشل
    const Q0 = "What colour lanyard must visitors wear in the warehouse?";
    const QF = "How long are CCTV recordings kept?";
    const r = await queryFor([user(Q0), asst("Visitors wear an orange lanyard."), user(QF), legacyNotice(), user(QF), notice(), user("continue")], "continue");
    expect(r).toEqual({ text: Q0, source: "continued" });
    expect(r.text).not.toBe(QF);
    // (ج) لا سؤالَ مُجابًا في المحادثة: الكلمةُ حرفيًّا
    expect(await queryFor([user(QF), notice(), user("continue")], "continue")).toEqual({ text: "continue", source: "message" });
    // (د) إعادةُ توليد دورِ «continue» الذي فشل (لا رسالةَ جديدة): السؤالُ الأصليّ
    expect(await queryFor([user(Q_EN), partial(CUT_EN), user("continue"), notice()])).toEqual({ text: Q_EN, source: "continued" });
  });

  it("★ ★ ★ إعادةُ التوليد: دورُ «كمل» ⇒ السؤال؛ دورُ السؤال نفسِه ⇒ كما هو", async () => {
    expect(await queryFor([user(Q_AR), partial(CUT_AR), user("كمل"), asst("٤.")])).toEqual({ text: Q_AR, source: "continued" });
    expect(await queryFor([user(Q_AR), partial(CUT_AR)])).toEqual({ text: Q_AR, source: "message" });
  });

  it("★ ★ ★ سلسلةُ متابعات، ومتابعةٌ بعد جوابٍ كامل ⇒ السؤالُ الأصليّ", async () => {
    expect(await queryFor([user(Q_EN), asst("A1"), user("continue"), asst("A2"), user("كمل"), asst("A3"), user("continue")], "continue")).toEqual({ text: Q_EN, source: "continued" });
    expect(await queryFor([user(Q_EN), asst("A complete answer."), user("continue")], "continue")).toEqual({ text: Q_EN, source: "continued" });
  });

  it("★ ★ ★ محادثةٌ طويلة: السؤالُ داخلَ النافذة يُلتقط؛ خارجَها تبقى الكلمةُ حرفيًّا بلا استثناء", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) rows.push(user(`سؤال رقم ${i + 1}`), asst(`جواب رقم ${i + 1}`));
    rows.push(user(Q_AR), partial(CUT_AR), user("كمل"));
    const history = await historyFor(rows);
    expect(history.length).toBeLessThanOrEqual(30);
    expect(deriveRetrievalQuery("كمل", history)).toEqual({ text: Q_AR, source: "continued" });

    const chain: Row[] = [user(Q_EN)];
    for (let i = 0; i < 15; i++) chain.push(partial(`part ${i + 1}`), user("continue"));
    const h2 = await historyFor(chain);
    expect(h2.some((m) => m.content === Q_EN)).toBe(false);
    expect(deriveRetrievalQuery("continue", h2)).toEqual({ text: "continue", source: "message" });
  });

  it("★ ★ ★ حراسات: سياقٌ فارغ، أو لا ينتهي بالدور نفسِه، أو سؤالٌ بلا جواب، أو عناصرُ معطوبة ⇒ حرفيًّا بلا رمي", () => {
    expect(deriveRetrievalQuery("continue", [])).toEqual({ text: "continue", source: "message" });
    expect(deriveRetrievalQuery("continue", [{ role: "user", content: Q_EN }, { role: "assistant", content: "A" }])).toEqual({ text: "continue", source: "message" });
    expect(deriveRetrievalQuery("continue", [{ role: "user", content: Q_EN }, { role: "user", content: "continue" }])).toEqual({ text: "continue", source: "message" });
    expect(deriveRetrievalQuery("continue", [{ role: "user", content: "كمل" }, { role: "assistant", content: "x" }, { role: "user", content: "continue" }])).toEqual({ text: "continue", source: "message" });
    const broken = [{ role: "user", content: 7 }, { role: "assistant", content: null }, { role: "user", content: "continue" }] as unknown as ChatMessage[];
    expect(deriveRetrievalQuery("continue", broken)).toEqual({ text: "continue", source: "message" });
    const original: ChatMessage[] = [{ role: "user", content: Q_EN }, { role: "assistant", content: "A" }, { role: "user", content: "continue" }];
    const copy = original.map((m) => ({ ...m }));
    expect(deriveRetrievalQuery("continue", copy).text).toBe(Q_EN);
    expect(copy).toEqual(original);
  });

  it("★ ★ ★ العزل: نداءان بسياقين مختلفين مستقلّان، والوحدةُ لا تلمس قاعدةً ولا شبكةً ولا بيئة", () => {
    const a = deriveRetrievalQuery("continue", [{ role: "user", content: Q_EN }, { role: "assistant", content: "A" }, { role: "user", content: "continue" }]);
    const b = deriveRetrievalQuery("كمل", [{ role: "user", content: Q_AR }, { role: "assistant", content: "ج" }, { role: "user", content: "كمل" }]);
    expect(a.text).toBe(Q_EN);
    expect(b.text).toBe(Q_AR);
    const src = readFileSync(new URL("../lib/chat/retrieval-query.ts", import.meta.url), "utf8");
    for (const forbidden of ["supabase", "fetch(", "process.env", "from \"@/lib/chat/context\"", "from \"./context\""]) expect(src).not.toContain(forbidden);
  });
});

describe("★ (٣) المسارُ يمرّر الاستعلامَ المشتقّ للاسترجاع وحده — نصُّ المصدر", () => {
  const ROUTE = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  it("★ ★ ★ السطرُ المثبَّت باقٍ، والاسترجاعُ الوحيد يأخذ النصَّ المشتقّ، وبقيّةُ استعمالات queryText كما هي", () => {
    expect(ROUTE).toContain("if (queryText && contextFileIds.length > 0) {");
    expect(ROUTE).toContain("deriveRetrievalQuery(queryText, history)");
    expect(ROUTE.match(/retrieveSnippets\(/g)).toHaveLength(1);
    expect(ROUTE).toContain("detectUserGrounding(queryText)");
    expect(ROUTE).toContain("confidentEntities(queryText)");
    expect(ROUTE).toContain("ambiguousCandidates(queryText)");
    expect(ROUTE).toContain("retrieval_query=${ragQuerySource}");
    expect(ROUTE).toContain("query_source: ragQuerySource");
  });
});
