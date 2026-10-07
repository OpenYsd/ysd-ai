import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, StreamChunk } from "@/lib/ai/types";

/**
 * المسارُ الحقيقيّ (`POST`): دورُ «continue» / «كمل» في محادثةٍ فيها ملفّات يسترجع بالسؤال الذي يُكمَل.
 *
 * ما يُثبَت هنا هو **التوصيل** لا التصنيف (المصنَّفُ في v148-bare-followup-retrieval):
 *   - الاسترجاعُ يُستدعى مرّةً واحدة، بنصّ السؤال الأصليّ، وعلى ملفّات المحادثة كلِّها (ملفّان) — لا بكلمة «continue».
 *   - النموذجُ يستلم الدورَ كما كتبه المستخدم («continue» آخرُ السياق)، لا السؤالَ المستبدَل.
 *   - الصفُّ المحفوظ يحمل `files_scope.query_source` («continued» / «message») — رمزٌ يُقرأ به الأثرُ على staging.
 *   - سؤالٌ جديدٌ غيرُ متّصل، وإعادةُ توليدِ دورِ «continue» (بلا رسالة)، وإشعارُ فشلٍ في السياق.
 */

const retrieveSnippets = vi.fn();
let lastStreamArgs: { messages?: ChatMessage[]; systemPrompt?: string } | null = null;
let inserts: { table: string; row: Record<string, unknown> }[] = [];
let updates: { table: string; row: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
let regenerateTarget: { id: string; metadata?: unknown } | null = null;
let providerChunks: StreamChunk[] = [];
/** سياقُ النموذج الذي تُعيده gatherChatContext المموّهة، وملفّاتُ النطاق */
let history: ChatMessage[] = [];
let contextFileIds: string[] = ["file-1", "file-2"];

vi.mock("@/lib/evidence/evidence-repository", () => ({
  replaceMessageEvidence: async () => ({ ok: true, unchanged: false, sourcesCount: 0, segmentsCount: 0 }),
}));
vi.mock("@/lib/rag/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rag/retrieval")>();
  return { ...actual, retrieveSnippets: (...a: unknown[]) => retrieveSnippets(...a) };
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
  resolveModelForUser: () => ({ modelId: "test/model", rejected: false, downgraded: false, reason: "ok", maxOutputTokens: 1024 }),
}));
vi.mock("@/lib/ai/generation-slot", () => ({ acquireSlot: async () => ({ release: async () => undefined }) }));
vi.mock("@/lib/ai/budget", () => ({
  BUDGET_DENY_MESSAGE: { unavailable: "x" },
  estimateInputTokens: () => 10,
  reserveChatBudget: async () => ({ allowed: true, reason: "ok" }),
  releaseChatBudget: async () => undefined,
  finalizeChatBudget: async () => undefined,
}));
vi.mock("@/lib/ai/registry", () => ({
  getFallbackProvider: () => null,
  resolveProviderForModel: () => ({
    id: "test-provider",
    async *streamChat(args: { messages?: ChatMessage[]; systemPrompt?: string }) {
      lastStreamArgs = args;
      for (const chunk of providerChunks) yield chunk;
    },
  }),
}));
vi.mock("@/lib/chat/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/context")>();
  return {
    ...actual,
    mergeServerTiming: () => "",
    gatherChatContext: async () => ({ history, contextFileIds, pendingFileIds: [], pendingFiles: [], dbMs: 1 }),
  };
});
vi.mock("@/lib/chat/idempotency", () => ({ claimRequestDurable: async () => ({ ok: true }), finalizeRequest: async () => undefined }));
vi.mock("@/lib/admin/health-metrics", () => ({ persistEvent: async () => undefined, recordAbruptSessionEnd: () => undefined, recordChatMetric: () => undefined }));
vi.mock("@/lib/rate-limit-distributed", () => ({
  BUCKET_CHAT: "chat",
  consumeRateLimit: async () => ({ allowed: true, backend: "memory", remaining: 9 }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/rag/sentence-backfill", () => ({
  backfillSentenceIndex: async () => ({ status: "done", rounds: 0, enqueued: 0, processed: 0, missing: 0, ms: 0 }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeSupabase() }));

function makeSupabase() {
  const chainFor = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    let updated = false;
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "is", "gt", "order", "limit"]) chain[m] = () => chain;
    chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
    chain.insert = (row: Record<string, unknown>) => { inserted = row; inserts.push({ table, row }); return chain; };
    chain.update = (row: Record<string, unknown>) => { updated = true; updates.push({ table, row, filters }); return chain; };
    chain.maybeSingle = async () => (table === "messages" && filters.role === "assistant" ? { data: regenerateTarget, error: null } : { data: null, error: null });
    chain.single = async () => {
      if (table === "messages") {
        if (inserted) return { data: { id: inserted.role === "assistant" ? "msg-assistant-new" : "msg-user-new" }, error: null };
        if (updated) return { data: { id: filters.id }, error: null };
        if (filters.role === "user") return { data: { id: "msg-user-1", created_at: "2026-10-06T10:00:00.000Z" }, error: null };
        return { data: null, error: null };
      }
      if (table === "conversations") return { data: { id: "conv-1", title: "محادثة", project_id: null }, error: null };
      return { data: null, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return chain;
  };
  return { from: (table: string) => chainFor(table), rpc: async (fn: string) => (fn === "check_usage_allowed" ? { data: true } : { data: null }) };
}

const text = (t: string): StreamChunk => ({ type: "text", text: t }) as StreamChunk;
const snippet = (fileId: string) => ({ content: "The employee badge number is zeta seven.", fileId, fileName: `${fileId}.txt`, pageNumber: 1, similarity: 0.8, chunkId: `chunk-${fileId}`, chunkIndex: 0 });

async function callRoute(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/chat/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "11111111-1111-4111-8111-111111111111", modelId: "test/model", clientRequestId: "22222222-2222-4222-8222-222222222222", ...body }),
  } as never);
  const res = await POST(req as never);
  const raw = res.body ? await new Response(res.body).text() : "";
  return { status: res.status, raw };
}

const savedAssistant = () => {
  const ins = inserts.find((i) => i.table === "messages" && i.row.role === "assistant");
  if (ins) return ins.row;
  return updates.find((u) => u.table === "messages" && "content" in u.row)?.row ?? null;
};
const filesScope = () => (savedAssistant()?.metadata as { files_scope?: Record<string, unknown> } | undefined)?.files_scope;

const Q = "What does the handbook say about the night shift meal allowance and visitor lanyards?";
const CUT = "Employees who work the night shift receive a meal allowance of";
const Q_AR = "ماذا يقول دليل التشغيل عن مراجعة المخزون الشاملة؟";
const PARTIAL_ROW = (c: string): ChatMessage => ({ role: "assistant", content: c });
const U = (c: string): ChatMessage => ({ role: "user", content: c });

let logs: string[];
beforeEach(() => {
  vi.resetModules();
  inserts = [];
  updates = [];
  regenerateTarget = null;
  lastStreamArgs = null;
  history = [];
  contextFileIds = ["file-1", "file-2"];
  providerChunks = [text("38 riyals per shift; visitors wear the orange lanyard.")];
  retrieveSnippets.mockReset().mockImplementation(async (_sb: unknown, _q: string, fileIds: string[]) => ({
    snippets: fileIds.map(snippet),
    searched: true,
    topSimilarity: 0.8,
    mode: "search",
  }));
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

describe("★ (١) «continue» بعد جوابٍ جزئيٍّ مستنِدٍ إلى ملفّين", () => {
  it("★ ★ ★ الاسترجاعُ مرّةً واحدة بالسؤال الأصليّ على الملفّين؛ النموذجُ يرى «continue»؛ الصفُّ يحمل query_source=continued", async () => {
    history = [U(Q), PARTIAL_ROW(CUT), U("continue")];

    const { status } = await callRoute({ message: "continue" });

    expect(status).toBe(200);
    expect(retrieveSnippets).toHaveBeenCalledTimes(1);
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q);
    expect(retrieveSnippets.mock.calls[0]![2]).toEqual(["file-1", "file-2"]);
    // الموجّهُ حمل المصادر، والدورُ الأخير للنموذج هو ما كتبه المستخدم
    expect(lastStreamArgs?.systemPrompt).toContain("zeta seven");
    expect(lastStreamArgs?.messages?.at(-1)).toEqual({ role: "user", content: "continue" });
    expect(lastStreamArgs?.messages?.some((m) => m.content === Q)).toBe(true);
    expect(filesScope()).toMatchObject({ ready: 2, retrieved: 2, query_source: "continued" });
    expect(logs.some((l) => l.includes("retrieval_query=continued"))).toBe(true);
  });

  it("★ ★ ★ «كمل» بالعربيّة ⇒ السؤالُ العربيّ", async () => {
    history = [U(Q_AR), PARTIAL_ROW("تُجرى مراجعة المخزون الشاملة في"), U("كمل")];
    await callRoute({ message: "كمل" });
    expect(retrieveSnippets).toHaveBeenCalledTimes(1);
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q_AR);
    expect(filesScope()).toMatchObject({ query_source: "continued" });
  });
});

describe("★ (٢) ما لم يتغيّر", () => {
  it("★ ★ ★ سؤالٌ جديدٌ غيرُ متّصل بعد الجزئيّ ⇒ الاسترجاعُ بالرسالة نفسِها، query_source=message", async () => {
    const NEW_Q = "Who is the safety officer of the eastern branch?";
    history = [U(Q), PARTIAL_ROW(CUT), U(NEW_Q)];
    await callRoute({ message: NEW_Q });
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(NEW_Q);
    expect(filesScope()).toMatchObject({ query_source: "message" });
    expect(logs.some((l) => l.includes("retrieval_query=message"))).toBe(true);
  });

  it("★ ★ ★ سؤالٌ عاديّ بلا جزئيّ قبله ⇒ كما كان", async () => {
    history = [U(Q)];
    await callRoute({ message: Q });
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q);
    expect(filesScope()).toMatchObject({ query_source: "message" });
  });

  it("★ ★ ★ بلا ملفّات في النطاق: لا استرجاعَ أصلًا، و«continue» يمرّ كما كان", async () => {
    contextFileIds = [];
    history = [U(Q), PARTIAL_ROW(CUT), U("continue")];
    await callRoute({ message: "continue" });
    expect(retrieveSnippets).not.toHaveBeenCalled();
    expect(filesScope()).toMatchObject({ ready: 0, retrieved: 0, mode: "none", query_source: "message" });
  });
});

describe("★ (٣) إعادةُ التوليد وإشعارُ الفشل", () => {
  it("★ ★ ★ إعادةُ توليدِ دورِ «continue» (بلا رسالة) ⇒ الاسترجاعُ بالسؤال الأصليّ، والردُّ يُستبدل في مكانه", async () => {
    // السياقُ المبنيّ ينتهي بالدور المُعاد («continue»)؛ الردُّ القديم مستبعَدٌ منه
    history = [U(Q), PARTIAL_ROW(CUT), U("continue")];
    regenerateTarget = { id: "msg-assistant-old", metadata: { provider: "openrouter" } };
    await callRoute({ regenerate: true });
    expect(retrieveSnippets).toHaveBeenCalledTimes(1);
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q);
    expect(updates.filter((u) => u.table === "messages" && "content" in u.row)).toHaveLength(1);
    expect(filesScope()).toMatchObject({ query_source: "continued" });
  });

  it("★ ★ ★ إعادةُ توليدِ السؤال نفسِه ⇒ الاسترجاعُ به كما كان", async () => {
    history = [U("Earlier question?"), PARTIAL_ROW("Earlier answer."), U(Q)];
    regenerateTarget = { id: "msg-assistant-old", metadata: { provider: "openrouter" } };
    await callRoute({ regenerate: true });
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q);
    expect(filesScope()).toMatchObject({ query_source: "message" });
  });

  it("★ ★ ★ السؤالُ الفاشل ليس في السياق المبنيّ، فلا يصير استعلامًا: تُكمَل آخرُ إجابةٍ حقيقيّة", async () => {
    // buildModelContext أسقطت السؤالَ الفاشل وإشعاريه؛ ما يصل المسارَ هو هذا
    const Q0 = "What colour lanyard must visitors wear in the warehouse?";
    history = [U(Q0), PARTIAL_ROW("Visitors wear an orange lanyard."), U("continue")];
    await callRoute({ message: "continue" });
    expect(retrieveSnippets.mock.calls[0]![1]).toBe(Q0);
  });
});
