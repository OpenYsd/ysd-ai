import { describe, expect, it, vi } from "vitest";

import { gatherChatContext } from "@/lib/chat/context";
import { ERROR_MESSAGES } from "@/lib/ai/error-codes";

/**
 * إشعار فشل المزوّد يُعرض للمستخدم ولا يُغذّى للنموذج.
 *
 * الفشل الطرفي يُحفظ رسالةَ مساعد كي يبقى أثرٌ مفهوم بعد إعادة التحميل. لكنه
 * **ليس جواب نموذج**: تمريره في السياق يجعل النموذج يقرأ «الخدمة غير متاحة»
 * على أنه ردُّه السابق، فيقلّد نبرته أو يعتذر عمّا لم يقله.
 *
 * الاختبار يُشغّل `gatherChatContext` الحقيقية — لا نسخة منها — بعميل Supabase
 * مُحاكى يعيد صفوفًا كما تعيدها القاعدة.
 */

const NOTICE = ERROR_MESSAGES.provider_unavailable;

interface Row {
  role: string;
  content: string;
  metadata?: unknown;
}

/** عميل Supabase مُحاكى: يعيد الصفوف المعطاة لاستعلام الرسائل */
function fakeSupabase(rows: Row[]) {
  const selected: string[] = [];
  const messagesQuery = {
    select(cols: string) {
      selected.push(cols);
      return this;
    },
    eq() {
      return this;
    },
    is() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return {
    selected,
    client: {
      from(table: string) {
        if (table === "messages") return messagesQuery;
        // conversations / projects / files — تحديثات لا تعني هذا الاختبار
        return {
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
      },
    },
  };
}

async function historyFor(rows: Row[]) {
  const fake = fakeSupabase(rows);
  const res = await gatherChatContext(fake.client as never, {
    conversationId: "c-1",
    userId: "u-1",
    projectId: null,
    convUpdate: {},
    requestId: "rid",
  } as never);
  return { history: res.history, selected: fake.selected };
}

describe("★ حارس: إشعار الفشل لا يدخل موجّه النموذج", () => {
  const failureRow: Row = {
    role: "assistant",
    content: NOTICE,
    metadata: { completion: { status: "incomplete_provider", reason: "provider_unavailable" } },
  };

  /**
   * ★ الحالة المطلوبة حرفيًا: Q1 يفشل ⇒ إشعار محفوظ ⇒ Q2 يُرسل.
   *
   * السياق المُرسل مع Q2 يجب أن يحوي سؤالي المستخدم فقط — بلا نصّ الإشعار.
   */
  it("★ Q1 يفشل ثم Q2: السياق يحمل أسئلة المستخدم بلا الإشعار", async () => {
    const { history } = await historyFor([
      { role: "user", content: "Q1: ما عاصمة السعودية؟" },
      failureRow,
      { role: "user", content: "Q2: وما عاصمة مصر؟" },
    ]);

    // ★ لا أثر لنصّ الإشعار في ما يصل النموذج
    const joined = history.map((m) => m.content).join("\n");
    expect(joined).not.toContain(NOTICE);
    // ولا رسالة مساعد أصلًا في هذا المسار
    expect(history.filter((m) => m.role === "assistant")).toHaveLength(0);
    // وسؤالا المستخدم باقيان بترتيبهما
    expect(history.map((m) => m.content)).toEqual([
      "Q1: ما عاصمة السعودية؟",
      "Q2: وما عاصمة مصر؟",
    ]);
  });

  /**
   * ★ ولا تُسقط التصفية ردًّا حقيقيًا.
   *
   * الاستبعاد يخصّ العلامة الصريحة وحدها. أي ردّ عادي — ولو كان ناقصًا
   * بسبب مهلة أو حارس — يبقى سياقًا مشروعًا للدور التالي.
   */
  it("★ الردود الحقيقية تبقى في السياق", async () => {
    const { history } = await historyFor([
      { role: "user", content: "س١" },
      { role: "assistant", content: "جواب حقيقي" },
      { role: "user", content: "س٢" },
      {
        role: "assistant",
        content: "جواب ناقص بمهلة",
        metadata: { completion: { status: "incomplete_timeout" } },
      },
      { role: "user", content: "س٣" },
      failureRow,
    ]);

    expect(history.map((m) => m.content)).toEqual([
      "س١",
      "جواب حقيقي",
      "س٢",
      "جواب ناقص بمهلة",
      "س٣",
    ]);
  });

  it("★ بيانات غائبة أو غريبة الشكل لا تُسقط الرسالة بالشك", async () => {
    const { history } = await historyFor([
      { role: "assistant", content: "بلا بيانات" },
      { role: "assistant", content: "بيانات فارغة", metadata: null },
      { role: "assistant", content: "بيانات نصّية", metadata: "x" },
      { role: "assistant", content: "اكتمال بلا حالة", metadata: { completion: {} } },
    ]);
    expect(history).toHaveLength(4);
  });

  /** الاستعلام يجلب البيانات فعلًا — وإلا لَما أمكنت التصفية */
  it("★ الاستعلام يشمل metadata", async () => {
    const { selected } = await historyFor([{ role: "user", content: "س" }]);
    expect(selected.join(" ")).toContain("metadata");
  });

  /**
   * ★ والصفّ لا يُحذف من القاعدة ولا من الواجهة.
   *
   * التصفية في بناء السياق وحده. لو نُقلت إلى الاستعلام (`.neq(...)`) لاختفى
   * الإشعار من سجلّ المستخدم أيضًا — وهو نقيض الغرض منه.
   */
  it("★ التصفية في السياق لا في الاستعلام", async () => {
    const { selected } = await historyFor([failureRow]);
    // لا شرط استبعاد داخل الاستعلام نفسه
    expect(selected.join(" ")).not.toContain("neq");
  });
});
