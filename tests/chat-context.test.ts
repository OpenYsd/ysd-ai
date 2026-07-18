/**
 * موازاة /api/chat: gatherChatContext + mergeServerTiming.
 * بلا شبكة ولا Supabase حقيقي — عميل وهمي يسجّل الاستدعاءات والتوقيت.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherChatContext, mergeServerTiming } from "../lib/chat/context";

// getContextFileIds تُستدعى داخل الدالة — نتحكّم بها بالموك
vi.mock("../lib/rag/retrieval", () => ({
  getContextFileIds: vi.fn(),
}));
import { getContextFileIds } from "../lib/rag/retrieval";

const delay = (ms: number, value: unknown) =>
  new Promise((res) => setTimeout(() => res(value), ms));

/** باني استعلام وهمي: كل مرحلة تُرجع this، والانتظار يُرجع النتيجة بعد مهلة */
function fakeQuery(result: unknown, ms = 0, spy?: (op: string) => void) {
  const q: Record<string, unknown> = {};
  for (const op of ["select", "eq", "is", "order", "limit", "update"]) {
    q[op] = (...args: unknown[]) => {
      spy?.(op);
      void args;
      return q;
    };
  }
  q.then = (resolve: (v: unknown) => void) => delay(ms, result).then(resolve);
  return q;
}

function fakeSupabase(opts: {
  historyMs?: number;
  historyResult?: unknown;
  convUpdateMs?: number;
  convUpdateResult?: unknown;
  onFrom?: (table: string) => void;
  onOp?: (table: string, op: string) => void;
}) {
  return {
    from(table: string) {
      opts.onFrom?.(table);
      const spy = (op: string) => opts.onOp?.(table, op);
      if (table === "messages") {
        return fakeQuery(opts.historyResult ?? { data: [{ role: "user", content: "مرحبا" }] }, opts.historyMs ?? 0, spy);
      }
      if (table === "conversations") {
        return fakeQuery(opts.convUpdateResult ?? { data: null, error: null }, opts.convUpdateMs ?? 0, spy);
      }
      if (table === "projects") {
        return fakeQuery({ data: null, error: null }, 0, spy);
      }
      return fakeQuery({ data: null, error: null }, 0, spy);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const baseParams = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  projectId: null,
  convUpdate: { updated_at: "t", model_id: "ysd/free" },
  requestId: "rid-test",
};

beforeEach(() => {
  vi.mocked(getContextFileIds).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("gatherChatContext — الموازاة", () => {
  it("★ ينفّذ history و fileIds و convUpdate بالتوازي (المجموع ≈ الأطول لا الجمع)", async () => {
    vi.mocked(getContextFileIds).mockImplementation(() => delay(120, ["f1"]) as Promise<string[]>);
    const supabase = fakeSupabase({ historyMs: 120, convUpdateMs: 120 });
    const t0 = Date.now();
    const res = await gatherChatContext(supabase, baseParams);
    const elapsed = Date.now() - t0;
    // ثلاث عمليات كل منها 120ms: متسلسلة ≈360ms، متوازية ≈120ms
    expect(elapsed).toBeLessThan(240);
    expect(res.contextFileIds).toEqual(["f1"]);
    expect(res.history).toHaveLength(1);
  });

  it("★ يستدعي تحديث المحادثة فعلًا (لا يُفقد)", async () => {
    vi.mocked(getContextFileIds).mockResolvedValue([]);
    const froms: string[] = [];
    const ops: string[] = [];
    const supabase = fakeSupabase({
      onFrom: (t) => froms.push(t),
      onOp: (t, op) => { if (t === "conversations") ops.push(op); },
    });
    await gatherChatContext(supabase, baseParams);
    expect(froms).toContain("conversations");
    expect(ops).toContain("update"); // التحديث صدر
    expect(ops).toContain("eq");
  });

  it("★ فشل تحديث updated_at (throw) لا يمنع الرد — يعيد السياق كاملًا", async () => {
    vi.mocked(getContextFileIds).mockResolvedValue(["fA"]);
    const supabase = {
      from(table: string) {
        if (table === "conversations") {
          return { update: () => ({ eq: () => Promise.reject(new Error("db down")) }) };
        }
        if (table === "messages") return fakeQuery({ data: [{ role: "user", content: "س" }] });
        return fakeQuery({ data: null, error: null });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await gatherChatContext(supabase, baseParams);
    expect(res.history).toHaveLength(1); // السياق لم يضِع
    expect(res.contextFileIds).toEqual(["fA"]); // ولا الملفات
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("conv_update_failed"));
  });

  it("فشل تحديث المحادثة (خطأ PostgREST في القيمة) يُسجَّل ولا يمنع", async () => {
    vi.mocked(getContextFileIds).mockResolvedValue([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = fakeSupabase({ convUpdateResult: { data: null, error: { message: "x" } } });
    const res = await gatherChatContext(supabase, baseParams);
    expect(res.history).toBeDefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("conv_update_failed"));
  });

  it("فشل جلب معرّفات الملفات ⇒ لا RAG (contextFileIds فارغة)، لا يمنع الرد", async () => {
    vi.mocked(getContextFileIds).mockRejectedValue(new Error("files err"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = fakeSupabase({});
    const res = await gatherChatContext(supabase, baseParams);
    expect(res.contextFileIds).toEqual([]);
    expect(res.history).toHaveLength(1); // التدهور رشيق
  });

  it("فشل جلب السياق ⇒ history فارغة (سلوك حالي)", async () => {
    vi.mocked(getContextFileIds).mockResolvedValue([]);
    const supabase = fakeSupabase({ historyResult: { data: null, error: { message: "x" } } });
    const res = await gatherChatContext(supabase, baseParams);
    expect(res.history).toEqual([]);
  });
});

describe("mergeServerTiming — الدمج بلا طمس", () => {
  it("★ يدمج قياسات الوسيط مع قياسات المسار في ترويسة واحدة", () => {
    const merged = mergeServerTiming("auth;dur=3, profile;dur=316", [
      "database;dur=120",
      "app_before_provider;dur=450",
    ]);
    expect(merged).toBe(
      "auth;dur=3, profile;dur=316, database;dur=120, app_before_provider;dur=450",
    );
    // لا طمس: كل القياسات موجودة
    for (const k of ["auth", "profile", "database", "app_before_provider"]) {
      expect(merged).toContain(k);
    }
  });

  it("يتجاهل قياس وسيط فارغ بلا فاصلة بادئة", () => {
    expect(mergeServerTiming("", ["database;dur=5"])).toBe("database;dur=5");
  });
});
