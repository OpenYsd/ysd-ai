import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_MESSAGES } from "@/lib/ai/error-codes";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * إعادةُ محاولةٍ فشلت بلا نصّ لا تمحو الردَّ القائم.
 *
 * ★ العطل: إعادةُ التوليد تُبدّل الردَّ السابق **في مكانه**، وعقدُها (v0.7.0 RC8) أن يبقى الردُّ القديم حتى يوجد
 *   بديلٌ قابلٌ للحفظ. ثمّ صار إشعارُ فشل المزوّد «نصًّا قابلًا للحفظ»، فإعادةُ محاولةٍ فشلت بلا نصّ كانت تكتب
 *   الإشعارَ فوق الردّ القائم — جوابًا كاملًا كان أو جزئيًّا قُطع بثُّه. فيضيع النصُّ، و«كمل» بعدها لا تجد
 *   ما تُكمله (الإشعارُ وسؤالُه يخرجان من السياق).
 *
 * ★ الإصلاح: الإشعارُ يُبثّ للعميل كما كان، ولا يُكتب فوق ردٍّ حقيقيّ. يُكتب فقط حين يكون الهدفُ نفسُه إشعارَ
 *   فشل (يُحدَّث في مكانه)، أو حين لا هدف (رسالةٌ جديدة) — كما كان.
 *
 * مسارٌ حقيقيّ (`POST`) بمزوّدٍ وقاعدةٍ مموّهين، كما في v09-evidence-route.
 */

const releaseSlot = vi.fn();
const releaseChatBudget = vi.fn();
const finalizeChatBudget = vi.fn();

let inserts: { table: string; row: Record<string, unknown> }[] = [];
let updates: { table: string; row: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
/** صفُّ المساعد الذي تستهدفه إعادةُ التوليد — كما يقرؤه المسار */
let regenerateTarget: { id: string; metadata?: unknown } | null = null;
let providerChunks: StreamChunk[] = [];

vi.mock("@/lib/evidence/evidence-repository", () => ({
  replaceMessageEvidence: async () => ({ ok: true, unchanged: false, sourcesCount: 0, segmentsCount: 0 }),
}));

vi.mock("@/lib/rag/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rag/retrieval")>();
  return { ...actual, retrieveSnippets: async () => ({ snippets: [], searched: false, topSimilarity: null }) };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/auth/request-context", () => ({
  TIMING_HEADER: "server-timing",
  getRequestContext: async () => ({ userId: "user-from-session", status: "active" }),
}));

vi.mock("@/lib/ai/ai-settings", () => ({
  getAiSettings: async () => ({ allowedModels: ["test/model"] }),
  isModelAllowed: () => true,
}));

vi.mock("@/lib/ai/model-policy", () => ({
  TIER_DOWNGRADE_MESSAGE: "downgraded",
  emptyModelPolicyTimings: () => ({ primaryMs: 0, limitsMs: 0 }),
  loadModelPolicy: async () => ({ userTier: "free", models: [], maxOutputTokens: 1024 }),
  resolveModelForUser: () => ({
    modelId: "test/model",
    rejected: false,
    downgraded: false,
    reason: "ok",
    maxOutputTokens: 1024,
  }),
}));

vi.mock("@/lib/ai/generation-slot", () => ({
  acquireSlot: async () => ({ release: releaseSlot }),
}));

vi.mock("@/lib/ai/budget", () => ({
  BUDGET_DENY_MESSAGE: { unavailable: "x" },
  estimateInputTokens: () => 10,
  reserveChatBudget: async () => ({ allowed: true, reason: "ok" }),
  releaseChatBudget: (...a: unknown[]) => releaseChatBudget(...a),
  finalizeChatBudget: (...a: unknown[]) => finalizeChatBudget(...a),
}));

vi.mock("@/lib/ai/registry", () => ({
  getFallbackProvider: () => null,
  resolveProviderForModel: () => ({
    id: "test-provider",
    async *streamChat() {
      for (const chunk of providerChunks) yield chunk;
    },
  }),
}));

// بناءُ السياق مموّه (لا قاعدة)، وتمييزُ الإشعار حقيقيّ — هو ما يقرّر به المسار
vi.mock("@/lib/chat/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/context")>();
  return {
    ...actual,
    mergeServerTiming: () => "",
    gatherChatContext: async () => ({
      history: [{ role: "user", content: "عدّد الكواكب" }],
      contextFileIds: [],
      pendingFileIds: [],
      dbMs: 1,
    }),
  };
});

vi.mock("@/lib/chat/idempotency", () => ({
  claimRequestDurable: async () => ({ ok: true }),
  finalizeRequest: async () => undefined,
}));

vi.mock("@/lib/admin/health-metrics", () => ({
  persistEvent: async () => undefined,
  recordAbruptSessionEnd: () => undefined,
  recordChatMetric: () => undefined,
}));

vi.mock("@/lib/rate-limit-distributed", () => ({
  BUCKET_CHAT: "chat",
  consumeRateLimit: async () => ({ allowed: true, backend: "memory", remaining: 9 }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeSupabase(),
}));

/** عميل قاعدة مموّه: يسجّل الإدراج والتحديث، ويجيب قراءتَي فرع إعادة التوليد */
function makeSupabase() {
  const chainFor = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    let updated = false;
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    let columns = "*";
    for (const m of ["is", "gt", "order", "limit"]) chain[m] = () => chain;
    chain.select = (cols?: string) => {
      if (cols) columns = cols;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    };
    chain.insert = (row: Record<string, unknown>) => {
      inserted = row;
      inserts.push({ table, row });
      return chain;
    };
    chain.update = (row: Record<string, unknown>) => {
      updated = true;
      updates.push({ table, row, filters });
      return chain;
    };
    // كما في PostgREST: لا يعود إلا ما طُلب من أعمدة — فقراءةُ `id` وحدها لا تحمل metadata
    chain.maybeSingle = async () => {
      if (table !== "messages" || filters.role !== "assistant" || !regenerateTarget) return { data: null, error: null };
      const wanted = columns.split(",").map((c) => c.trim());
      const row = regenerateTarget as Record<string, unknown>;
      return { data: Object.fromEntries(Object.entries(row).filter(([k]) => columns === "*" || wanted.includes(k))), error: null };
    };
    chain.single = async () => {
      if (table === "messages") {
        if (inserted) return { data: { id: inserted.role === "assistant" ? "msg-assistant-new" : "msg-user-new" }, error: null };
        if (updated) return { data: { id: filters.id }, error: null };
        if (filters.role === "user") return { data: { id: "msg-user-1", created_at: "2026-10-02T10:00:00.000Z" }, error: null };
        return { data: null, error: null };
      }
      if (table === "conversations") {
        return { data: { id: "conv-1", title: "محادثة", project_id: null }, error: null };
      }
      return { data: null, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return chain;
  };

  return {
    from: (table: string) => chainFor(table),
    rpc: async (fn: string) => (fn === "check_usage_allowed" ? { data: true } : { data: null }),
  };
}

const text = (t: string): StreamChunk => ({ type: "text", text: t }) as StreamChunk;
const providerError = (errorCode = "provider_unavailable"): StreamChunk =>
  ({ type: "error", error: "upstream failed", errorCode }) as StreamChunk;

async function callRoute(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/chat/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "11111111-1111-4111-8111-111111111111",
      modelId: "test/model",
      clientRequestId: "22222222-2222-4222-8222-222222222222",
      ...body,
    }),
  } as never);
  const res = await POST(req as never);
  const raw = res.body ? await new Response(res.body).text() : "";
  const frames: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    } catch {
      /* إطار غير JSON */
    }
  }
  return { status: res.status, frames };
}

const visibleText = (frames: Record<string, unknown>[]) =>
  frames.filter((f) => f.type === "text").map((f) => f.text as string).join("");
const doneFrame = (frames: Record<string, unknown>[]) => frames.find((f) => f.type === "done");
/** كتاباتُ نصّ الردّ على صفّ المساعد (تحديثٌ في مكانه أو إدراج) */
const replyUpdates = () => updates.filter((u) => u.table === "messages" && "content" in u.row);
/** كلُّ تحديثٍ على جدول الرسائل — أيًّا كان ما يكتبه */
const messageUpdates = () => updates.filter((u) => u.table === "messages");
const replyInserts = () => inserts.filter((i) => i.table === "messages" && i.row.role === "assistant");

const NOTICE = ERROR_MESSAGES.provider_unavailable;
const PARTIAL_META = { completion: { status: "incomplete_provider", reason: "stream_interrupted", notice: false, failure_notice: false } };
const LEGACY_PARTIAL_META = { provider: "openrouter", completion: { status: "incomplete_provider", reason: "stream_interrupted", notice: false } };
const NOTICE_META = { completion: { status: "incomplete_provider", reason: "provider_unavailable", notice: false, failure_notice: true } };

let logs: string[];

beforeEach(() => {
  vi.resetModules();
  inserts = [];
  updates = [];
  regenerateTarget = null;
  providerChunks = [];
  releaseSlot.mockReset().mockResolvedValue(undefined);
  releaseChatBudget.mockReset().mockResolvedValue(undefined);
  finalizeChatBudget.mockReset().mockResolvedValue(undefined);
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

describe("★ (١) إعادةُ محاولةٍ فشلت بلا نصّ: الردُّ القائم لا يُمسّ", () => {
  for (const [name, metadata] of [
    ["جوابٌ جزئيّ قُطع بثُّه (العلامة الصريحة)", PARTIAL_META],
    ["جوابٌ جزئيّ قديم (بالسبب stream_interrupted)", LEGACY_PARTIAL_META],
    ["جوابٌ كامل (بلا completion)", { provider: "openrouter" }],
    ["جوابٌ بلا metadata (القيمةُ الافتراضيّة للعمود: {})", {}],
    ["جوابٌ بلا metadata", undefined],
  ] as const) {
    it(`★ ★ ★ ${name}: لا تحديثَ ولا إدراج، والإشعارُ يصل العميل`, async () => {
      regenerateTarget = { id: "msg-assistant-old", metadata };
      providerChunks = [providerError()];

      const { status, frames } = await callRoute({ regenerate: true });

      expect(status).toBe(200);
      // لا كتابةَ على صفّ الردّ إطلاقًا — لا نصَّ ولا metadata ولا حذف
      expect(messageUpdates()).toEqual([]);
      expect(replyInserts()).toEqual([]);
      // المستخدم يرى أنّ المحاولة فشلت — والنصُّ القديم يعود عند إعادة التحميل
      expect(visibleText(frames)).toBe(NOTICE);
      expect(frames.some((f) => f.type === "error" && f.code === "provider_unavailable")).toBe(true);
      // البثُّ انتهى طبيعيًّا: إطارُ done موجود، بلا معرّف رسالة (لم يُحفظ شيء)، ومعلَّمٌ ناقصًا
      const done = doneFrame(frames);
      expect(done).toBeDefined();
      expect(done).toHaveProperty("assistantMessageId", null);
      expect((done?.completion as { status?: string } | undefined)?.status).toBe("incomplete_provider");
      expect(logs.some((l) => l.includes("regenerate_failed_kept_previous=true"))).toBe(true);
    });
  }
});

describe("★ (٢) ما لم يتغيّر", () => {
  it("★ ★ ★ الهدفُ نفسُه إشعارُ فشل: يُحدَّث في مكانه (لا صفَّ ثانٍ)", async () => {
    regenerateTarget = { id: "msg-assistant-old", metadata: NOTICE_META };
    providerChunks = [providerError("rate_limit")];

    const { frames } = await callRoute({ regenerate: true });

    expect(replyInserts()).toEqual([]);
    expect(replyUpdates()).toHaveLength(1);
    const u = replyUpdates()[0]!;
    expect(u.filters.id).toBe("msg-assistant-old");
    expect(u.row.content).toBe(ERROR_MESSAGES.rate_limit);
    expect((u.row.metadata as { completion: Record<string, unknown> }).completion).toMatchObject({
      status: "incomplete_provider",
      reason: "rate_limit",
      failure_notice: true,
    });
    expect(doneFrame(frames)?.assistantMessageId).toBe("msg-assistant-old");
  });

  it("★ ★ ★ الهدفُ إشعارٌ قديم (بلا العلامة، بالسبب provider_unavailable): يُحدَّث في مكانه", async () => {
    regenerateTarget = {
      id: "msg-assistant-old",
      metadata: { provider: "openrouter", completion: { status: "incomplete_provider", reason: "provider_unavailable", notice: false } },
    };
    providerChunks = [providerError()];

    await callRoute({ regenerate: true });

    expect(replyInserts()).toEqual([]);
    expect(replyUpdates()).toHaveLength(1);
    expect(replyUpdates()[0]!.filters.id).toBe("msg-assistant-old");
    expect(logs.some((l) => l.includes("regenerate_failed_kept_previous=true"))).toBe(false);
  });

  it("★ ★ ★ إعادةُ محاولةٍ نجحت: الجوابُ الجديد يحلّ محلَّ الجزئيّ في مكانه", async () => {
    regenerateTarget = { id: "msg-assistant-old", metadata: PARTIAL_META };
    providerChunks = [text("عطارد، الزهرة، الأرض، المريخ.")];

    const { frames } = await callRoute({ regenerate: true });

    expect(replyInserts()).toEqual([]);
    expect(replyUpdates()).toHaveLength(1);
    expect(replyUpdates()[0]!.filters.id).toBe("msg-assistant-old");
    expect(replyUpdates()[0]!.row.content).toBe("عطارد، الزهرة، الأرض، المريخ.");
    expect(doneFrame(frames)?.assistantMessageId).toBe("msg-assistant-old");
    expect(logs.some((l) => l.includes("regenerate_failed_kept_previous=true"))).toBe(false);
  });

  it("★ ★ ★ إعادةُ محاولةٍ قُطع بثُّها بعد نصّ: الجزئيُّ الجديد يُحفظ في مكانه (نصُّ نموذج، لا إشعار)", async () => {
    regenerateTarget = { id: "msg-assistant-old", metadata: PARTIAL_META };
    // كما تُنهي المحوّلاتُ بثًّا انقطع بعد نصٍّ ظاهر (openrouter / nine-router / ysd-runtime)
    providerChunks = [
      text("عطارد، الزهرة،"),
      { type: "done", completion: "incomplete_provider", completionReason: "stream_interrupted" } as StreamChunk,
    ];

    await callRoute({ regenerate: true });

    expect(replyUpdates()).toHaveLength(1);
    expect(replyUpdates()[0]!.row.content).toContain("عطارد، الزهرة،");
    expect(replyUpdates()[0]!.row.content).not.toContain(NOTICE);
    // العلامةُ التي تقرؤها إعادةُ المحاولة التالية: نصُّ نموذج، لا إشعار
    expect((replyUpdates()[0]!.row.metadata as { completion: Record<string, unknown> }).completion).toMatchObject({
      status: "incomplete_provider",
      reason: "stream_interrupted",
      failure_notice: false,
    });
  });

  it("★ ★ ★ إعادةُ محاولةٍ بلا ردٍّ سابق (سؤالٌ بلا جواب): الإشعارُ يُدرج كما كان", async () => {
    regenerateTarget = null;
    providerChunks = [providerError()];

    await callRoute({ regenerate: true });

    expect(replyUpdates()).toEqual([]);
    expect(replyInserts()).toHaveLength(1);
    expect(replyInserts()[0]!.row.content).toBe(NOTICE);
  });

  it("★ ★ ★ رسالةٌ جديدة فشل مزوّدُها: الإشعارُ يُدرج كما كان", async () => {
    providerChunks = [providerError()];

    const { frames } = await callRoute({ message: "سؤال جديد" });

    expect(replyUpdates()).toEqual([]);
    expect(replyInserts()).toHaveLength(1);
    expect(replyInserts()[0]!.row.content).toBe(NOTICE);
    expect(doneFrame(frames)?.assistantMessageId).toBe("msg-assistant-new");
  });
});
