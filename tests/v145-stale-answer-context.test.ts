import { describe, expect, it } from "vitest";

import { gatherChatContext } from "@/lib/chat/context";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";

/**
 * «الجواب القديم»: بعد فشل المزوّد يجيب النموذج سؤالًا سابقًا لا سؤالَ المستخدم الأخير.
 *
 * ★ مرصودٌ حيًّا على staging (2026-09-25، المحادثة 0c28dcfe): سُئل Q1 مرّتين وفشل المزوّد
 *   في كلتيهما، ثمّ سُئل Q2 — فجاء الجواب نسخةً حرفيّة لجواب Q1 السابق. السببُ في موجّه
 *   النموذج: إشعاراتُ الفشل تُستبعد (صحيح)، لكنّ الأسئلة التي لم تُجب تبقى، فيصل إلى النموذج
 *   ثلاثةُ أدوار مستخدمٍ متتالية فيجيب أقدمَها.
 *
 * ★ ومسبّبٌ ثانٍ حتميّ: السياق كان يُجلب «أقدم 30 رسالة» (تصاعديًّا ثمّ حدّ)، فمحادثةٌ فيها
 *   أكثر من 30 رسالة لا يصل سؤالُها الأخير إلى النموذج أصلًا.
 *
 * ★ الثابت المطلوب: موجّه النموذج ينتهي بالسؤال الذي يُجاب الآن، وكلُّ سؤالٍ قبله له جوابٌ
 *   فيه — والقاعدةُ والواجهةُ وسجلُّ المحادثة لا تُمسّ.
 */

const NOTICE = ERROR_MESSAGES.provider_unavailable;
interface Row {
  role: string;
  content: string;
  metadata?: unknown;
  created_at: string;
}
const failure = (at: string): Row => ({
  role: "assistant",
  content: NOTICE,
  metadata: { completion: { status: "incomplete_provider", reason: "provider_unavailable" } },
  created_at: at,
});
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 25, 0, 0, clock++)).toISOString();
const user = (content: string): Row => ({ role: "user", content, created_at: at() });
const asst = (content: string, metadata?: unknown): Row => ({ role: "assistant", content, metadata, created_at: at() });

/** عميلٌ يحترم order/limit كما تفعل PostgREST — فيظهر أيُّ نافذةٍ تُجلب فعلًا */
function fakeSupabase(rows: Row[]) {
  const q = { ascending: true, limit: Infinity };
  const messages = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    is() {
      return this;
    },
    order(_col: string, opts?: { ascending?: boolean }) {
      q.ascending = opts?.ascending ?? true;
      return this;
    },
    limit(n: number) {
      q.limit = n;
      const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) * (q.ascending ? 1 : -1));
      return Promise.resolve({ data: sorted.slice(0, q.limit), error: null });
    },
  };
  const other = {
    select() {
      return this;
    },
    eq() {
      return Promise.resolve({ data: [], error: null });
    },
    update() {
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
    is() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return Promise.resolve({ data: [], error: null });
    },
    in() {
      return Promise.resolve({ data: [], error: null });
    },
  };
  return { from: (t: string) => (t === "messages" ? messages : other) };
}

async function contextFor(rows: Row[]) {
  const res = await gatherChatContext(fakeSupabase(rows) as never, {
    conversationId: "c-1",
    userId: "u-1",
    projectId: null,
    convUpdate: {},
    requestId: "rid",
  } as never);
  return res.history;
}

describe("★ (١) بعد فشل المزوّد: النموذج يرى السؤال الأخير وحده بلا أسئلةٍ معلّقة", () => {
  it("★ ★ ★ التسلسل المرصود على staging: Q1 أُجيب، Q2 أُجيب، Q1 فشل مرّتين، ثمّ Q3", async () => {
    const history = await contextFor([
      user("كم خفّض المشروع أوقات الانتظار؟"),
      asst("خفض المشروع أوقات الانتظار بنسبة 37٪."),
      user("ما رقم الشارة الوظيفية؟"),
      asst("رقم الشارة الوظيفية هو QX-7741-ZETA."),
      user("بكم خفّض الإنفاق الشهري؟"),
      failure(at()),
      user("بكم خفّض الإنفاق الشهري؟"),
      failure(at()),
      user("ما فصيلة دمه؟"),
    ]);
    expect(history.at(-1)).toEqual({ role: "user", content: "ما فصيلة دمه؟" });
    // الأدوارُ متناوبة: لا سؤالان متتاليان، ولا إشعار فشل
    for (let i = 1; i < history.length; i++) expect(history[i]!.role).not.toBe(history[i - 1]!.role);
    expect(history.map((m) => m.content).join("\n")).not.toContain(NOTICE);
    // والحوارُ المُجاب قبلها باقٍ كما هو
    expect(history.slice(0, 4).map((m) => m.content)).toEqual([
      "كم خفّض المشروع أوقات الانتظار؟",
      "خفض المشروع أوقات الانتظار بنسبة 37٪.",
      "ما رقم الشارة الوظيفية؟",
      "رقم الشارة الوظيفية هو QX-7741-ZETA.",
    ]);
    expect(history).toHaveLength(5);
  });

  it("★ ★ ★ Q1 يفشل ثمّ Q2 جديد: النموذج يرى Q2 وحده", async () => {
    const history = await contextFor([user("Q1"), failure(at()), user("Q2")]);
    expect(history).toEqual([{ role: "user", content: "Q2" }]);
  });

  it("★ ★ ★ طلبٌ انقطع قبل أيّ ردٍّ محفوظ (سؤالٌ بلا صفّ مساعد) يُعامل كالفشل", async () => {
    const history = await contextFor([user("س١"), asst("ج١"), user("س٢ بلا رد"), user("س٣")]);
    expect(history.map((m) => m.content)).toEqual(["س١", "ج١", "س٣"]);
  });

  it("★ ★ ★ إعادة المحاولة (إعادة التوليد بعد الفشل): السؤالُ نفسُه آخرُ ما يرى النموذج", async () => {
    // retry = regenerate: لا رسالة مستخدم جديدة؛ الإشعارُ بعد السؤال يبقى في القاعدة حتى يُستبدل في مكانه
    const history = await contextFor([user("س١"), asst("ج١"), user("س٢"), failure(at())]);
    expect(history.map((m) => m.content)).toEqual(["س١", "ج١", "س٢"]);
  });

  it("★ ★ ★ الردودُ الناقصة الحقيقية (مهلة/حارس) أجوبةٌ لا تُسقط", async () => {
    const history = await contextFor([
      user("س١"),
      asst("جواب ناقص بمهلة", { completion: { status: "incomplete_timeout" } }),
      user("س٢"),
    ]);
    expect(history.map((m) => m.content)).toEqual(["س١", "جواب ناقص بمهلة", "س٢"]);
  });
});

describe("★ (٢) محادثةٌ طويلة: النافذة أحدثُ الرسائل لا أقدمُها", () => {
  it("★ ★ ★ 40 رسالة: السؤالُ الأخير يصل إلى النموذج، والنافذةُ تبدأ بسؤال", async () => {
    const rows: Row[] = [];
    for (let i = 1; i <= 20; i++) rows.push(user(`سؤال ${i}`), asst(`جواب ${i}`));
    rows.push(user("السؤال الأخير الحالي"));
    const history = await contextFor(rows);
    expect(history.at(-1)).toEqual({ role: "user", content: "السؤال الأخير الحالي" });
    expect(history[0]!.role).toBe("user");
    expect(history.length).toBeLessThanOrEqual(30);
    // لا شيء من أوّل المحادثة حين تتجاوز النافذة
    expect(history.map((m) => m.content)).not.toContain("سؤال 1");
  });
});

describe("★ (٣) إعادة توليد جوابٍ ناجح: الجوابُ القديم لا يُرسل للنموذج", () => {
  it("★ ★ ★ السياق ينتهي بالسؤال المُعاد توليدُ جوابه، لا بالجواب القديم", async () => {
    const history = await contextFor([user("س١"), asst("ج١"), user("س٢"), asst("ج٢ القديم")]);
    expect(history.map((m) => m.content)).toEqual(["س١", "ج١", "س٢"]);
  });
});
