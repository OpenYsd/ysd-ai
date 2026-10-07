import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { gatherChatContext } from "@/lib/chat/context";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";

/**
 * جوابٌ قطعه المزوّد في منتصف البثّ ليس «إشعارَ فشل».
 *
 * ★ العطل: المحوّلات (openrouter / nine-router / ysd-runtime / ysd) تُنهي بثًّا انقطع **بعد نصٍّ ظاهر** بـ
 *   `completion: incomplete_provider` (السبب `stream_interrupted` أو `runtime_stream_ended`)، والمسارُ يحفظ النصَّ
 *   الجزئيَّ الحقيقيَّ بهذه الحالة. وبناءُ السياق كان يعدّ كلَّ `incomplete_provider` إشعارَ فشلٍ فيُسقط الجواب
 *   الجزئيّ — ثمّ يُسقط سؤالَه معه (v145: سؤالٌ بلا جواب). فتصل «كمل» إلى النموذج بلا السؤال ولا ما كُتب من
 *   جوابه، فيكمل حوارًا أقدم أو يقول إنه لا يعرف ما يُكمل.
 *
 * ★ الإصلاح البنيويّ: المسارُ يكتب صراحةً هل النصُّ المحفوظ إشعارٌ أم نصُّ نموذج (`completion.failure_notice`)،
 *   والصفوفُ القديمة تُميَّز بالسبب. فالجوابُ الجزئيّ يبقى في السياق مع سؤاله؛ وإشعارُ الفشل وسؤالُه المعلّق
 *   يبقيان خارجه كما في v145.
 */

const NOTICE = ERROR_MESSAGES.provider_unavailable;
interface Row { role: string; content: string; metadata?: unknown; created_at: string }
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 2, 0, 0, clock++)).toISOString();
const user = (content: string): Row => ({ role: "user", content, created_at: at() });
const asst = (content: string, metadata?: unknown): Row => ({ role: "assistant", content, metadata, created_at: at() });
/** صفٌّ قديم (قبل هذا الإصلاح): جوابٌ جزئيٌّ حقيقيّ كما حفظه المسار — بلا العلامة الصريحة */
const legacyPartial = (content: string, reason = "stream_interrupted") => asst(content, { provider: "openrouter", completion: { status: "incomplete_provider", reason, notice: false } });
const legacyNotice = (reason = "provider_unavailable") => asst(NOTICE, { provider: "openrouter", completion: { status: "incomplete_provider", reason, notice: false } });
const partial = (content: string) => asst(content, { completion: { status: "incomplete_provider", reason: "stream_interrupted", notice: false, failure_notice: false } });
const notice = () => asst(NOTICE, { completion: { status: "incomplete_provider", reason: "provider_unavailable", notice: false, failure_notice: true } });

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
async function contextFor(rows: Row[]) {
  const res = await gatherChatContext(fakeSupabase(rows) as never, { conversationId: "c", userId: "u", projectId: null, convUpdate: {}, requestId: "r" } as never);
  return res.history.map((m) => `${m.role === "user" ? "U" : "A"}:${m.content}`);
}

const Q = "عدّد كواكب المجموعة الشمسية الثمانية بالترتيب.";
const CUT = "١. عطارد\n٢. الزهرة\n٣. الأرض\n٤.";

describe("★ (١) بثٌّ انقطع بعد نصٍّ ظاهر: السؤالُ وجوابُه الجزئيّ يبقيان في السياق", () => {
  it("★ ★ ★ «كمل» بعد جوابٍ مقطوع (صفٌّ قديم، stream_interrupted): النموذجُ يرى السؤالَ والجزءَ المكتوب", async () => {
    expect(await contextFor([user("ما عاصمة فرنسا؟"), asst("باريس"), user(Q), legacyPartial(CUT), user("كمل")])).toEqual([
      "U:ما عاصمة فرنسا؟", "A:باريس", `U:${Q}`, `A:${CUT}`, "U:كمل",
    ]);
  });

  it("★ ★ ★ «continue» على مسار model-alpha (runtime_stream_ended)", async () => {
    expect(await contextFor([user("List the planets."), legacyPartial("1. Mercury\n2. Venus\n3.", "runtime_stream_ended"), user("continue")])).toEqual([
      "U:List the planets.", "A:1. Mercury\n2. Venus\n3.", "U:continue",
    ]);
  });

  it("★ ★ ★ سؤالٌ جديدٌ غيرُ متّصل بعد جوابٍ مقطوع: الأدوارُ متناوبة وآخرُها السؤالُ الجديد", async () => {
    const ctx = await contextFor([user(Q), legacyPartial(CUT), user("ما عاصمة اليابان؟")]);
    expect(ctx).toEqual([`U:${Q}`, `A:${CUT}`, "U:ما عاصمة اليابان؟"]);
  });

  it("★ ★ ★ إعادةُ المحاولة (regenerate) على جوابٍ مقطوع: السؤالُ آخرُ السياق، والجزئيُّ لا يُرسل (يُستبدل في مكانه)", async () => {
    expect(await contextFor([user("س١"), asst("ج١"), user(Q), legacyPartial(CUT)])).toEqual(["U:س١", "A:ج١", `U:${Q}`]);
  });

  it("★ ★ ★ صفٌّ جديد بالعلامة الصريحة failure_notice=false يبقى — ولو كان السببُ غيرَ معروف", async () => {
    expect(await contextFor([user(Q), partial(CUT), user("كمل")])).toEqual([`U:${Q}`, `A:${CUT}`, "U:كمل"]);
    const odd = () => asst(CUT, { completion: { status: "incomplete_provider", reason: "unknown", failure_notice: false } });
    expect(await contextFor([user(Q), odd(), user("كمل")])).toEqual([`U:${Q}`, `A:${CUT}`, "U:كمل"]);
  });
});

describe("★ (٢) إشعارُ الفشل وسؤالُه المعلّق خارجَ السياق كما كانا (v145) — لا يُبعث سؤالٌ قديم", () => {
  it("★ ★ ★ إشعارٌ قديم (provider_unavailable / unknown / timeout / بلا سبب) يُستبعد مع سؤاله", async () => {
    for (const reason of ["provider_unavailable", "unknown", "timeout", "rate_limit"]) {
      expect(await contextFor([user("Q1"), legacyNotice(reason), user("Q2")])).toEqual(["U:Q2"]);
    }
    const noReason = () => asst(NOTICE, { completion: { status: "incomplete_provider" } });
    expect(await contextFor([user("Q1"), noReason(), user("Q2")])).toEqual(["U:Q2"]);
  });

  it("★ ★ ★ إشعارٌ جديد بالعلامة الصريحة failure_notice=true يُستبعد — ولو حمل سببَ الانقطاع", async () => {
    expect(await contextFor([user("Q1"), notice(), user("Q2")])).toEqual(["U:Q2"]);
    const flagged = () => asst(NOTICE, { completion: { status: "incomplete_provider", reason: "stream_interrupted", failure_notice: true } });
    expect(await contextFor([user("Q1"), flagged(), user("Q2")])).toEqual(["U:Q2"]);
  });

  it("★ ★ ★ المزيج: سؤالٌ فشل مرّتين (لا يُبعث)، ثمّ سؤالٌ قُطع جوابُه، ثمّ «كمل»", async () => {
    expect(await contextFor([
      user("Q0"), asst("A0"),
      user("Q-failed"), legacyNotice(), user("Q-failed"), notice(),
      user(Q), legacyPartial(CUT),
      user("كمل"),
    ])).toEqual(["U:Q0", "A:A0", `U:${Q}`, `A:${CUT}`, "U:كمل"]);
  });

  it("★ ★ ★ «كمل» فشل بدوره ثمّ أُعيد: نسخةٌ واحدة منه، بعد السؤال وجوابه الجزئيّ", async () => {
    expect(await contextFor([user(Q), legacyPartial(CUT), user("كمل"), notice(), user("كمل")])).toEqual([`U:${Q}`, `A:${CUT}`, "U:كمل"]);
  });

  it("★ ★ ★ الردودُ الناقصة الأخرى (مهلة / حارس) كما كانت: أجوبةٌ تبقى", async () => {
    const timeout = () => asst("جواب ناقص بمهلة", { completion: { status: "incomplete_timeout", reason: "hard_limit" } });
    expect(await contextFor([user("س١"), timeout(), user("س٢")])).toEqual(["U:س١", "A:جواب ناقص بمهلة", "U:س٢"]);
  });
});

describe("★ (٣) المسارُ يكتب العلامة عند الحفظ", () => {
  const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
  it("★ ★ ★ completion.failure_notice = هل النصُّ المحفوظ إشعارٌ لا نصُّ نموذج", () => {
    expect(ROUTE).toMatch(/failure_notice:\s*providerFailureNotice/);
    // والإشعارُ يُعلَّم حيث يُنشأ — بلا نصٍّ من النموذج وبرمز خطأ وليس إلغاءً من المستخدم
    expect(ROUTE).toContain("if (!assistantText.trim() && lastErrorCode && !clientAborted)");
    expect(ROUTE).toContain("providerFailureNotice = true");
  });
});
