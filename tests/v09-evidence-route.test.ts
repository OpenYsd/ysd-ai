import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVIDENCE_END, EVIDENCE_START } from "@/lib/evidence/evidence-envelope";
import type { StreamChunk } from "@/lib/ai/types";

/**
 * ربط Evidence Mode بمسار المحادثة (v0.9.0، الإيداع السادس).
 *
 * ── لماذا مسار حقيقي لا وحدات ──
 *
 * الوحدات مُختبَرة وحدها. وما يُختبر هنا هو **الترتيب والشروط**: هل تُستدعى
 * الكتابة قبل وجود الرسالة؟ هل تُرسل أحداث الاستشهاد قبل نجاحها؟ هل يمرّ
 * الإجهاض من فوقها؟ هذه كلها أسئلة عن مواضع الاستدعاء في `route.ts`، ولا
 * يجيب عنها إلا استدعاء `POST` نفسه.
 *
 * والمزوّد والقاعدة والميزانية والمقعد كلها مموّهة: الغرض إثبات السلوك لا
 * إنفاق مال على مزوّد ولا لمس Supabase.
 */

// ── ما نراقبه ──
const replaceMessageEvidence = vi.fn();
const retrieveSnippets = vi.fn();
const releaseSlot = vi.fn();
const releaseChatBudget = vi.fn();
const finalizeChatBudget = vi.fn();

/** كل ما أُدرج في القاعدة، بترتيبه */
let inserts: { table: string; row: Record<string, unknown> }[] = [];
/** ما يُعيده إدراج رسالة المساعد — يُبدَّل لاختبار فشل الحفظ */
let assistantInsertResult: { data: { id: string } | null; error: unknown } = {
  data: { id: "msg-assistant-1" },
  error: null,
};
/** دفعات المزوّد */
let providerChunks: StreamChunk[] = [];
/** مقاطع RAG */
let snippets: unknown[] = [];

vi.mock("@/lib/evidence/evidence-repository", () => ({
  replaceMessageEvidence: (...args: unknown[]) => replaceMessageEvidence(...args),
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
  // سِنك القياس — أرقام فقط، والمسار يمرّره فيلزم وجوده في المحاكاة
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
  // مزوّد احتياطي غير مُهيّأ — المحاكاة تعكس عقد الوحدة كاملًا
  getFallbackProvider: () => null,
  resolveProviderForModel: () => ({
    id: "test-provider",
    // eslint-disable-next-line require-yield
    async *streamChat() {
      for (const chunk of providerChunks) yield chunk;
    },
  }),
}));

vi.mock("@/lib/chat/context", () => ({
  mergeServerTiming: () => "",
  gatherChatContext: async () => ({
    history: [{ role: "user", content: "سؤال" }],
    contextFileIds: ["file-1"],
    dbMs: 1,
  }),
}));

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

/** عميل قاعدة مموّه — سلسلة قابلة للانتظار في أي نقطة */
function makeSupabase() {
  const chainFor = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    for (const m of ["select", "eq", "is", "gt", "order", "limit", "update"]) {
      chain[m] = passthrough;
    }
    chain.insert = (row: Record<string, unknown>) => {
      inserted = row;
      inserts.push({ table, row });
      return chain;
    };
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.single = async () => {
      if (inserted && table === "messages") {
        return inserted.role === "assistant"
          ? assistantInsertResult
          : { data: { id: "msg-user-1" }, error: null };
      }
      if (table === "conversations") {
        return { data: { id: "conv-1", title: "محادثة", project_id: null }, error: null };
      }
      return { data: null, error: null };
    };
    // قابلة للانتظار مباشرةً (`await supabase.from(x).update(y).eq(z)`)
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return chain;
  };

  return {
    from: (table: string) => chainFor(table),
    rpc: async (fn: string) => (fn === "check_usage_allowed" ? { data: true } : { data: null }),
  };
}

// ── أدوات ──

const snippet = (over: Record<string, unknown> = {}) => ({
  content: CONTENT,
  fileId: "file-a",
  fileName: "تقرير.pdf",
  pageNumber: 7,
  similarity: 0.8,
  chunkId: "chunk-a",
  chunkIndex: 3,
  ...over,
});

const CONTENT =
  "النموذج اللغوي لا يعرف إلا ما أُعطي، والاسترجاع هو ما يعطيه المقاطع الحقيقية.";
const QUOTE = "والاسترجاع هو ما يعطيه المقاطع";

const text = (t: string): StreamChunk => ({ type: "text", text: t }) as StreamChunk;

/** رد نموذج كامل: نصّ بعلامات + غلاف آلي */
const modelReply = (body: string, quotes: { marker: number; quote: string }[]) =>
  `${body}\n${EVIDENCE_START}\n${JSON.stringify({ quotes })}\n${EVIDENCE_END}`;

async function callRoute(
  opts: { body?: Record<string, unknown>; aborted?: boolean } = {},
): Promise<{ status: number; frames: Record<string, unknown>[]; raw: string }> {
  const { POST } = await import("@/app/api/chat/route");
  const { NextRequest } = await import("next/server");

  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: "11111111-1111-4111-8111-111111111111",
      modelId: "test/model",
      message: "سؤال عن الملف",
      clientRequestId: "22222222-2222-4222-8222-222222222222",
      ...opts.body,
    }),
  };
  if (opts.aborted) {
    const ac = new AbortController();
    ac.abort();
    init.signal = ac.signal;
  }

  const req = new NextRequest("http://localhost/api/chat", init as never);
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
  return { status: res.status, frames, raw };
}

const framesOf = (frames: Record<string, unknown>[], type: string) =>
  frames.filter((f) => f.type === type);
const visibleText = (frames: Record<string, unknown>[]) =>
  framesOf(frames, "text").map((f) => f.text as string).join("");

let logs: string[];

beforeEach(() => {
  vi.resetModules();
  inserts = [];
  snippets = [snippet()];
  providerChunks = [];
  assistantInsertResult = { data: { id: "msg-assistant-1" }, error: null };
  replaceMessageEvidence.mockReset().mockResolvedValue({
    ok: true,
    unchanged: false,
    sourcesCount: 1,
    segmentsCount: 1,
  });
  retrieveSnippets.mockReset().mockImplementation(async () => ({
    snippets,
    searched: true,
    topSimilarity: 0.8,
  }));
  releaseSlot.mockReset().mockResolvedValue(undefined);
  releaseChatBudget.mockReset().mockResolvedValue(undefined);
  finalizeChatBudget.mockReset().mockResolvedValue(undefined);

  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

// ════════════════════════════════════════════════════════════

describe("(٢٥) بلا مصادر: الوضع العادي كما كان", () => {
  it("لا Evidence Mode ولا تعليمات في الموجّه ولا استدعاء للمستودع", async () => {
    snippets = [];
    const reply = "جواب عادي بلا أي استشهاد.";
    providerChunks = [text(reply)];

    const { frames } = await callRoute();

    expect(visibleText(frames)).toBe(reply);
    expect(replaceMessageEvidence).not.toHaveBeenCalled();
    expect(framesOf(frames, "citation")).toHaveLength(0);
    expect(framesOf(frames, "evidence")).toHaveLength(0);
  });

  /**
   * ★ الوضع العادي **بايتًا ببايت**: كل دفعة مزوّد تخرج إطارًا واحدًا بنفس
   * نصّها. أي تجميع أو احتجاز هنا انحدارٌ يمسّ كل مستخدم لا يرفع ملفات.
   */
  it("كل دفعة تخرج كما دخلت — بلا تجميع ولا احتجاز", async () => {
    snippets = [];
    const parts = ["جواب ", "بلا ", "مصادر ", "[[1]] ", `و${EVIDENCE_START}`, " ونهاية"];
    providerChunks = parts.map(text);

    const { frames } = await callRoute();
    const got = framesOf(frames, "text").map((f) => f.text);

    expect(got).toEqual(parts);
    expect(visibleText(frames)).toBe(parts.join(""));
    // حتى العلامة والسنتينل يبقيان: بلا مصادر لا معنى لتجريدهما
    expect(visibleText(frames)).toContain("[[1]]");
    expect(visibleText(frames)).toContain(EVIDENCE_START);
  });

  it("الرسالة المحفوظة تطابق ما عُرض", async () => {
    snippets = [];
    const reply = "جواب عادي [[1]] بعلامة.";
    providerChunks = [text(reply)];

    const { frames } = await callRoute();
    const saved = inserts.find((i) => i.table === "messages" && i.row.role === "assistant");

    expect(saved?.row.content).toBe(reply);
    expect(saved?.row.content).toBe(visibleText(frames));
  });
});

describe("(٢٦) سجلّ المصادر يطابق ترقيم السياق", () => {
  it("marker = index في <source index=\"n\">", async () => {
    const { buildSourceRegistry, buildSourcesContext } = await import("@/lib/rag/retrieval");
    const three = [
      snippet({ chunkId: "c1", fileName: "أ.pdf" }),
      snippet({ chunkId: "c2", fileName: "ب.pdf" }),
      snippet({ chunkId: "c3", fileName: "ج.pdf" }),
    ];
    const context = buildSourcesContext(three as never);
    const registry = buildSourceRegistry(three as never);

    const indices = [...context.matchAll(/<source index="(\d+)"/g)].map((m) => Number(m[1]));
    expect(indices).toEqual([1, 2, 3]);
    expect(registry.map((r) => r.marker)).toEqual(indices);
    // والمقطع المقرون بكل رقم هو الذي كُتب في السياق بذلك الرقم
    registry.forEach((r, i) => expect(r.snippet).toBe(three[i]));
  });

  it("المسار يبني السجلّ من المقاطع التي دخلت الموجّه", async () => {
    snippets = [
      snippet({ chunkId: "c1", content: CONTENT }),
      snippet({ chunkId: "c2", content: "محتوى مختلف تمامًا لا يحوي الاقتباس." }),
    ];
    // النموذج يستشهد بالمصدر الثاني برقمه — واقتباسه من الأول
    providerChunks = [text(modelReply("جواب [[2]].", [{ marker: 2, quote: QUOTE }]))];

    await callRoute();

    // الاقتباس ليس في المقطع الثاني ⇒ لا يُحفظ: الرقم يشير إلى مقطعه هو
    const arg = replaceMessageEvidence.mock.calls[0]?.[0] as { evidence: { sources: unknown[] } };
    expect(arg.evidence.sources).toHaveLength(0);
  });
});

describe("(٢٧)(٢٨) الحفظ بعد الرسالة، ومرة واحدة", () => {
  beforeEach(() => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
  });

  it("(٢٧) يُستدعى المستودع بعد إدراج رسالة المساعد وبمعرّفها", async () => {
    await callRoute();

    expect(replaceMessageEvidence).toHaveBeenCalledTimes(1);
    const arg = replaceMessageEvidence.mock.calls[0]![0] as { messageId: string };
    expect(arg.messageId).toBe("msg-assistant-1");
    // وقد أُدرجت الرسالة فعلًا قبل ذلك
    expect(inserts.some((i) => i.table === "messages" && i.row.role === "assistant")).toBe(true);
  });

  it("(٢٨) استدعاء واحد لا أكثر مهما تعدّدت المصادر", async () => {
    snippets = [snippet({ chunkId: "c1" }), snippet({ chunkId: "c2", content: CONTENT })];
    providerChunks = [
      text(
        modelReply("أ [[1]] وب [[2]].", [
          { marker: 1, quote: QUOTE },
          { marker: 2, quote: "النموذج اللغوي لا يعرف إلا ما أُعطي" },
        ]),
      ),
    ];
    await callRoute();
    expect(replaceMessageEvidence).toHaveBeenCalledTimes(1);
  });

  it("(٢٩) userId من الجلسة لا من جسم الطلب", async () => {
    await callRoute({ body: { userId: "attacker-supplied" } });

    const arg = replaceMessageEvidence.mock.calls[0]![0] as { userId: string };
    expect(arg.userId).toBe("user-from-session");
    expect(arg.userId).not.toBe("attacker-supplied");
  });

  it("(٣٠) السقف 4 ثابت خادميًا ولا يأتي من العميل", async () => {
    await callRoute({ body: { maxVerifiedSources: 99, evidenceLimit: 99 } });

    const arg = replaceMessageEvidence.mock.calls[0]![0] as {
      evidence: { sources: unknown[] };
    };
    // العميل طلب 99؛ الحلّ جرى بسقف الخادم
    expect(arg.evidence.sources.length).toBeLessThanOrEqual(4);

    const routeSrc = await import("node:fs").then((fs) =>
      fs.readFileSync("app/api/chat/route.ts", "utf8"),
    );
    expect(routeSrc).toMatch(/maxVerifiedSources:\s*MAX_VERIFIED_SOURCES/);
    expect(routeSrc).toMatch(/const MAX_VERIFIED_SOURCES = 4/);
  });
});

describe("(٣١)(٣٢) ما لا يثبت لا يُحفظ", () => {
  it("(٣١) رقم لا مصدر له لا يُحفظ", async () => {
    providerChunks = [text(modelReply("جواب [[9]].", [{ marker: 9, quote: QUOTE }]))];
    await callRoute();

    const arg = replaceMessageEvidence.mock.calls[0]![0] as {
      evidence: { sources: unknown[]; unsupportedSegments: number[] };
    };
    expect(arg.evidence.sources).toHaveLength(0);
    expect(arg.evidence.unsupportedSegments).toEqual([0]);
  });

  it("(٣٢) اقتباس غير متحقق لا يُحفظ", async () => {
    providerChunks = [
      text(modelReply("جواب [[1]].", [{ marker: 1, quote: "جملة لا وجود لها في المقطع" }])),
    ];
    await callRoute();

    const arg = replaceMessageEvidence.mock.calls[0]![0] as {
      evidence: { sources: unknown[] };
    };
    expect(arg.evidence.sources).toHaveLength(0);
  });
});

describe("(٣٣) غلاف مفقود أو تالف — بلا 500", () => {
  it.each([
    ["مفقود", "جواب [[1]] بلا كتلة آلية."],
    ["تالف", `جواب [[1]].\n${EVIDENCE_START}\n{{{\n${EVIDENCE_END}`],
    ["بلا نهاية", `جواب [[1]].\n${EVIDENCE_START}\n{"quotes":[]}`],
    ["نهاية يتيمة", `جواب [[1]].\n${EVIDENCE_END}`],
  ])("%s ⇒ الرد يصل والحالة 200", async (_label, reply) => {
    providerChunks = [text(reply)];
    const { status, frames } = await callRoute();

    expect(status).toBe(200);
    expect(visibleText(frames)).toContain("جواب");
    expect(visibleText(frames)).not.toContain("[[1]]");
    expect(visibleText(frames)).not.toContain("<<<");
    expect(framesOf(frames, "done")).toHaveLength(1);
    // الحفظ يقع بلا مصادر — الفقرة تُوسم غير مدعومة
    const arg = replaceMessageEvidence.mock.calls[0]![0] as {
      evidence: { sources: unknown[]; unsupportedSegments: number[] };
    };
    expect(arg.evidence.sources).toHaveLength(0);
    expect(arg.evidence.unsupportedSegments).toEqual([0]);
  });
});

describe("(٣٤)(٣٥)(٤٠) فشل الحفظ لا يكسر شيئًا ولا يرسل استشهادًا", () => {
  beforeEach(() => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
  });

  const failures: [string, unknown][] = [
    ["رمز فشل", { ok: false, code: "evidence_validation_failed" }],
    ["تعذّر النداء", { ok: false, code: "evidence_rpc_unavailable" }],
    ["استثناء", new Error("boom")],
  ];

  it.each(failures)("%s ⇒ 200 والرد كامل", async (_label, outcome) => {
    if (outcome instanceof Error) replaceMessageEvidence.mockRejectedValue(outcome);
    else replaceMessageEvidence.mockResolvedValue(outcome);

    const { status, frames } = await callRoute();

    expect(status).toBe(200);
    // السطر الجديد قبل الكتلة الآلية جزءٌ من النصّ المرئي ولا يُقصّ
    expect(visibleText(frames)).toBe("جواب مدعوم.\n");
    expect(framesOf(frames, "done")).toHaveLength(1);
    expect(framesOf(frames, "error")).toHaveLength(0);
  });

  it.each(failures)("%s ⇒ لا حدث استشهاد ولا ملخّص", async (_label, outcome) => {
    if (outcome instanceof Error) replaceMessageEvidence.mockRejectedValue(outcome);
    else replaceMessageEvidence.mockResolvedValue(outcome);

    const { frames } = await callRoute();

    expect(framesOf(frames, "citation")).toHaveLength(0);
    expect(framesOf(frames, "evidence")).toHaveLength(0);
    expect(framesOf(frames, "evidence_unavailable")).toHaveLength(1);
  });

  it("(٣٤ب) رسالة المساعد تبقى محفوظة رغم فشل الأدلة", async () => {
    replaceMessageEvidence.mockResolvedValue({ ok: false, code: "evidence_write_failed" });
    await callRoute();

    const saved = inserts.find((i) => i.table === "messages" && i.row.role === "assistant");
    expect(saved).toBeDefined();
    expect(saved!.row.content).toBe("جواب مدعوم.\n");
  });

  /** الحدث يسبق `done` كي تعرف الواجهة أن لا مراجع قادمة قبل أن تُغلق */
  it("(٣٥ب) evidence_unavailable يسبق done", async () => {
    replaceMessageEvidence.mockResolvedValue({ ok: false, code: "evidence_write_failed" });
    const { frames } = await callRoute();

    const types = frames.map((f) => f.type);
    expect(types.indexOf("evidence_unavailable")).toBeLessThan(types.indexOf("done"));
  });
});

describe("(٣٦)(٣٧) المسارات التي لا يُستدعى فيها المستودع", () => {
  beforeEach(() => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
  });

  it("(٣٦) إجهاض العميل ⇒ لا أدلة ولا رسالة مساعد", async () => {
    await callRoute({ aborted: true });

    expect(replaceMessageEvidence).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === "messages" && i.row.role === "assistant")).toBe(false);
  });

  it("(٣٧) فشل حفظ رسالة المساعد ⇒ لا استدعاء للمستودع", async () => {
    assistantInsertResult = { data: null, error: { message: "insert failed" } };
    const { status, frames } = await callRoute();

    expect(replaceMessageEvidence).not.toHaveBeenCalled();
    // ومع ذلك ينتهي البثّ بسلام
    expect(status).toBe(200);
    expect(framesOf(frames, "done")).toHaveLength(1);
    expect(framesOf(frames, "citation")).toHaveLength(0);
  });

  it("(٣٧ب) ردّ فارغ ⇒ لا رسالة ولا أدلة", async () => {
    providerChunks = [text("   ")];
    await callRoute();
    expect(replaceMessageEvidence).not.toHaveBeenCalled();
  });
});

describe("(٣٨) الميزانية والمقعد لم يتغيّرا", () => {
  it("المقعد يُحرَّر في كل مسار — نجاح وفشل أدلة وإجهاض", async () => {
    providerChunks = [text(modelReply("جواب [[1]].", [{ marker: 1, quote: QUOTE }]))];

    await callRoute();
    expect(releaseSlot).toHaveBeenCalledTimes(1);

    releaseSlot.mockClear();
    replaceMessageEvidence.mockRejectedValue(new Error("boom"));
    await callRoute();
    expect(releaseSlot).toHaveBeenCalledTimes(1);

    releaseSlot.mockClear();
    await callRoute({ aborted: true });
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("الحجز يُحرَّر حين لا استهلاك — وفشل الأدلة لا يغيّره", async () => {
    providerChunks = [text(modelReply("جواب [[1]].", [{ marker: 1, quote: QUOTE }]))];
    replaceMessageEvidence.mockResolvedValue({ ok: false, code: "evidence_write_failed" });

    await callRoute();

    expect(releaseChatBudget).toHaveBeenCalledTimes(1);
    expect(finalizeChatBudget).not.toHaveBeenCalled();
  });

  it("الاستهلاك المرصود يُسوّى مرة واحدة", async () => {
    providerChunks = [
      text(modelReply("جواب [[1]].", [{ marker: 1, quote: QUOTE }])),
      { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } } as StreamChunk,
    ];
    await callRoute();

    expect(finalizeChatBudget).toHaveBeenCalledTimes(1);
    expect(releaseChatBudget).not.toHaveBeenCalled();
    expect(inserts.filter((i) => i.table === "usage_events")).toHaveLength(1);
  });
});

describe("(٣٩) ★ لا محتوى في السجلّات", () => {
  it("لا نصّ مزوّد ولا اقتباس ولا محتوى مقطع ولا اسم ملف", async () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";
    snippets = [
      snippet({ content: `${SECRET} داخل المقطع الحقيقي هنا`, fileName: `${SECRET}-ملف.pdf` }),
    ];
    providerChunks = [
      text(
        modelReply(`جواب [[1]] يذكر ${SECRET} في النصّ.`, [
          { marker: 1, quote: `${SECRET} داخل المقطع الحقيقي` },
        ]),
      ),
    ];

    await callRoute();

    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("YSD_EVIDENCE");
    expect(all).not.toContain('"quotes"');
    // ومع ذلك سُجّلت العدّادات
    expect(all).toMatch(/evidence_status=/);
    expect(all).toMatch(/evidence_sources=\d+/);
  });

  it("فشل الأدلة يسجّل رمزًا لا تفصيلًا", async () => {
    replaceMessageEvidence.mockRejectedValue(new Error("SECRET_QUOTE_MUST_NOT_APPEAR in error"));
    providerChunks = [text(modelReply("جواب [[1]].", [{ marker: 1, quote: QUOTE }]))];

    await callRoute();

    const all = logs.join("\n");
    expect(all).not.toContain("SECRET_QUOTE_MUST_NOT_APPEAR");
    expect(all).toMatch(/evidence_write=evidence_exception/);
  });
});

describe("(٤٠)(٤١)(٤٢) أحداث SSE", () => {
  it("(٤٠) أحداث الاستشهاد بعد نجاح الكتابة فقط", async () => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
    const { frames } = await callRoute();

    const citations = framesOf(frames, "citation");
    expect(citations).toHaveLength(1);
    expect(replaceMessageEvidence).toHaveBeenCalledTimes(1);

    // الترتيب: الكتابة قبل أول إطار استشهاد
    const types = frames.map((f) => f.type);
    expect(types.indexOf("citation")).toBeGreaterThan(-1);
    expect(types.indexOf("citation")).toBeLessThan(types.indexOf("done"));
  });

  it("شكل إطار الاستشهاد — وبلا relevance", async () => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
    const { frames } = await callRoute();

    const c = framesOf(frames, "citation")[0]!;
    expect(Object.keys(c).sort()).toEqual([
      "chunkId", "fileId", "fileName", "marker", "pageNumber",
      "quote", "segmentIndex", "type", "verification",
    ]);
    expect(c.marker).toBe(1);
    expect(c.segmentIndex).toBe(0);
    expect(c.chunkId).toBe("chunk-a");
    expect(c.fileId).toBe("file-a");
    expect(c.verification).toBe("exact");
    expect(c.quote).toBe(QUOTE);
    expect(c).not.toHaveProperty("relevance");
  });

  it("(٤١) الترتيب ثابت: segmentIndex ثم marker", async () => {
    snippets = [
      snippet({ chunkId: "c1", similarity: 0.2 }),
      snippet({ chunkId: "c2", similarity: 0.9 }),
    ];
    providerChunks = [
      text(
        modelReply("أولى [[1]] و[[2]].\n\nثانية [[2]].", [
          { marker: 1, quote: QUOTE },
          { marker: 2, quote: "النموذج اللغوي لا يعرف إلا ما أُعطي" },
        ]),
      ),
    ];

    const { frames } = await callRoute();
    const seen = framesOf(frames, "citation").map((c) => `${c.segmentIndex}:${c.marker}`);

    // مرتّبة رغم أن ترتيب المصادر داخليًا بالصلة (2 قبل 1)
    expect(seen).toEqual(["0:1", "0:2", "1:2"]);
    expect([...seen].sort()).toEqual(seen);
  });

  it("ملخّص evidence يلي الاستشهادات ويسبق done", async () => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
    const { frames } = await callRoute();

    const types = frames.map((f) => f.type);
    expect(types.indexOf("citation")).toBeLessThan(types.indexOf("evidence"));
    expect(types.indexOf("evidence")).toBeLessThan(types.indexOf("done"));

    const e = framesOf(frames, "evidence")[0]!;
    expect(e).toMatchObject({
      supported: true,
      supportedSegments: 1,
      unsupportedSegments: [],
      sourcesCount: 1,
      version: 1,
    });
  });

  /** العملاء القدامى يتجاهلون ما لا يعرفون — و`done` لم يتغيّر شكله */
  it("(٤٢) done يبقى متوافقًا وآخر إطار", async () => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]].", [{ marker: 1, quote: QUOTE }]))];
    const { frames } = await callRoute();

    const done = framesOf(frames, "done")[0]!;
    expect(done.userMessageId).toBe("msg-user-1");
    expect(done.assistantMessageId).toBe("msg-assistant-1");
    expect(frames[frames.length - 1]!.type).toBe("done");

    // الأنواع الجديدة إضافية بحتة: القديمة كلها ما زالت تظهر
    const types = new Set(frames.map((f) => f.type));
    expect(types.has("text")).toBe(true);
    expect(types.has("done")).toBe(true);
  });
});

describe("★ لا تسرّب إلى العميل في المسار الحقيقي", () => {
  it("لا سنتينل ولا JSON ولا علامة خام في أي إطار", async () => {
    providerChunks = [
      text("جواب "),
      text("مدعوم [[1"),
      text("]] وينتهي.\n"),
      text(`${EVIDENCE_START.slice(0, 8)}`),
      text(`${EVIDENCE_START.slice(8)}\n{"quotes":[{"marker":1,`),
      text(`"quote":"${QUOTE}"}]}\n${EVIDENCE_END}`),
    ];

    const { frames } = await callRoute();
    const shown = visibleText(frames);

    expect(shown).toBe("جواب مدعوم وينتهي.\n");
    expect(shown).not.toContain("<<<");
    expect(shown).not.toContain("YSD_EVIDENCE");
    expect(shown).not.toContain("quotes");
    expect(shown).not.toContain("[[1]]");
    // والاستشهاد نجح رغم انقسام الغلاف على أربع دفعات
    expect(framesOf(frames, "citation")).toHaveLength(1);
  });

  it("النصّ المحفوظ يساوي النصّ المعروض", async () => {
    providerChunks = [text(modelReply("جواب مدعوم [[1]] هنا.", [{ marker: 1, quote: QUOTE }]))];
    const { frames } = await callRoute();

    const saved = inserts.find((i) => i.table === "messages" && i.row.role === "assistant");
    expect(saved!.row.content).toBe(visibleText(frames));
    expect(saved!.row.content).not.toContain("<<<");
    expect(saved!.row.content).not.toContain("[[1]]");
  });
});
