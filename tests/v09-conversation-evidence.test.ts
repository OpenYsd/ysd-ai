import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * تحميل المحادثة مع أدلتها (v0.9.0، الإيداع السابع).
 *
 * ── لماذا يُستدعى مكوّن الصفحة نفسه ──
 *
 * السؤال «هل يقع N+1؟» سؤالٌ عن **عدد النداءات في مسار التحميل الفعلي**، ولا
 * يجيب عنه اختبار وحدة على القارئ وحده: قارئٌ سليم يُنادى داخل حلقة يُنتج
 * N+1 تمامًا. فنستدعي الصفحة ونعدّ ما وصل القاعدة.
 */

const rpcCalls: { fn: string; args: unknown }[] = [];
const fromCalls: string[] = [];

let evidenceRows: unknown[] = [];
let evidenceError: unknown = null;
let messageRows: unknown[] = [];

vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/auth/request-context", () => ({
  getRequestContext: async () => ({ userId: "user-1", status: "active" }),
}));

vi.mock("@/lib/ai/registry", () => ({
  listModelOptions: () => [{ id: "test/model", label: "نموذج" }],
  // مزوّد احتياطي غير مُهيّأ — المحاكاة تعكس عقد الوحدة كاملًا
  getFallbackProvider: () => null,
}));

vi.mock("@/lib/ai/model-policy", () => ({
  loadModelPolicy: async () => ({ userTier: "free", models: [], maxOutputTokens: 1024 }),
  tierAllows: () => true,
}));

/** بديل خفيف: نفحص الخصائص لا العرض */
vi.mock("@/components/chat/chat-view", () => ({
  ChatView: (props: unknown) => ({ type: "ChatView", props }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      fromCalls.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () =>
        table === "conversations"
          ? { data: { id: "conv-1", title: "محادثة", model_id: "test/model" } }
          : { data: null };
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "messages" ? messageRows : [] });
      return chain;
    },
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_conversation_evidence") {
        return evidenceError ? { data: null, error: evidenceError } : { data: evidenceRows, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const evidenceRow = (over: Record<string, unknown> = {}) => ({
  source_id: "src-1",
  message_id: "msg-a",
  segment_index: 0,
  marker: 1,
  chunk_id: "chunk-1",
  file_id: "file-1",
  chunk_index: 3,
  file_name: "تقرير.pdf",
  page_number: 7,
  quote: "اقتباس حرفي من المصدر",
  quote_start: 0,
  quote_end: 21,
  verification: "exact",
  source_available: true,
  ...over,
});

interface LoadedMessage {
  id: string;
  role: string;
  citations: unknown[];
  evidence: unknown;
  content: string;
}

async function loadPage(): Promise<LoadedMessage[]> {
  const mod = await import("@/app/(app)/chat/[id]/page");
  const el = (await mod.default({
    params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
  })) as unknown as { props: { initialMessages: LoadedMessage[] } };
  return el.props.initialMessages;
}

let logs: string[];

beforeEach(() => {
  vi.resetModules();
  rpcCalls.length = 0;
  fromCalls.length = 0;
  evidenceError = null;
  evidenceRows = [evidenceRow()];
  messageRows = [
    { id: "msg-u", role: "user", content: "سؤال", metadata: {} },
    {
      id: "msg-a",
      role: "assistant",
      content: "جواب مدعوم.",
      metadata: {
        model_id: "x",
        sources: [{ fileId: "f", fileName: "n", pageNumber: 1, snippet: "s" }],
        evidence: {
          supported: true,
          supportedSegments: 1,
          unsupportedSegments: [],
          sourcesCount: 1,
          version: 1,
        },
      },
    },
    { id: "msg-old", role: "assistant", content: "ردّ قديم.", metadata: { model_id: "y" } },
  ];

  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

describe("(١١)(١٢) لا N+1", () => {
  it("نداء RPC واحد للأدلة مهما بلغ عدد الرسائل", async () => {
    messageRows = Array.from({ length: 60 }, (_, i) => ({
      id: `msg-${i}`,
      role: "assistant",
      content: `ردّ ${i}`,
      metadata: {},
    }));
    evidenceRows = messageRows.map((m, i) =>
      evidenceRow({ message_id: (m as { id: string }).id, marker: (i % 9) + 1 }),
    );

    await loadPage();

    const evidenceCalls = rpcCalls.filter((c) => c.fn === "get_conversation_evidence");
    expect(evidenceCalls).toHaveLength(1);
    // ولا نداء للنسخة المفردة إطلاقًا
    expect(rpcCalls.filter((c) => c.fn === "get_message_evidence")).toHaveLength(0);
  });

  it("النداء الواحد يأخذ معرّف المحادثة لا معرّف رسالة", async () => {
    await loadPage();
    expect(rpcCalls[0]).toEqual({
      fn: "get_conversation_evidence",
      args: { p_conversation_id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  /** التوقيع نفسه يمنع الاستعمال الخاطئ: لا مَعلَم للرسالة أصلًا */
  it("القارئ لا يقبل messageId", async () => {
    const { readFileSync } = await import("node:fs");
    /**
     * التجريد لازم: التعليق نفسه يشرح **لماذا** لا تأخذ الوحدة `messageId`،
     * فالفحص على النصّ الخام كان يلتقط الشرح لا الشيفرة.
     */
    const code = readFileSync("lib/evidence/evidence-reader.ts", "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/messageId/);
    expect(code).not.toMatch(/get_message_evidence/);
    // والتوقيع يأخذ معرّف المحادثة وحده
    expect(code).toMatch(/conversationId: string/);
  });

  it("لا يزيد عدد استعلامات الجداول عمّا كان", async () => {
    await loadPage();
    // نفس الخمسة السابقة — الأدلة أضافت RPC لا استعلام جدول
    expect(fromCalls.sort()).toEqual([
      "conversations", "files", "messages", "profiles", "user_preferences",
    ]);
  });
});

describe("(١٣)(١٤)(١٥) عقد الرسالة", () => {
  it("(١٣) الرسائل القديمة citations=[] وevidence=null", async () => {
    const messages = await loadPage();
    const old = messages.find((m) => m.id === "msg-old")!;

    expect(old.citations).toEqual([]);
    expect(old.evidence).toBeNull();
  });

  it("(١٣ب) رسالة المستخدم كذلك", async () => {
    const messages = await loadPage();
    const user = messages.find((m) => m.id === "msg-u")!;
    expect(user.citations).toEqual([]);
    expect(user.evidence).toBeNull();
  });

  it("(١٤) الرسالة المدعومة تعود بالعقد النهائي", async () => {
    const messages = await loadPage();
    const supported = messages.find((m) => m.id === "msg-a")!;

    expect(supported.citations).toHaveLength(1);
    expect(supported.citations[0]).toEqual({
      sourceId: "src-1",
      segmentIndex: 0,
      marker: 1,
      chunkId: "chunk-1",
      fileId: "file-1",
      chunkIndex: 3,
      fileName: "تقرير.pdf",
      pageNumber: 7,
      quote: "اقتباس حرفي من المصدر",
      quoteStart: 0,
      quoteEnd: 21,
      verification: "exact",
      sourceAvailable: true,
    });
    expect(supported.evidence).toEqual({
      supported: true,
      supportedSegments: 1,
      unsupportedSegments: [],
      sourcesCount: 1,
      version: 1,
    });
  });

  it("(١٥) لا relevance في أي رسالة", async () => {
    evidenceRows = [{ ...evidenceRow(), relevance: 0.93 }];
    const messages = await loadPage();

    const blob = JSON.stringify(messages);
    expect(blob).not.toContain("relevance");
    expect(blob).not.toContain("0.93");
  });

  it("(١٦) لا تكرار في الاستشهادات", async () => {
    // نفس المرجع مرتين من القاعدة (صفّان لنفس الفقرة والرقم)
    evidenceRows = [evidenceRow(), evidenceRow()];
    const messages = await loadPage();
    const supported = messages.find((m) => m.id === "msg-a")!;
    // الصفّان يمرّان كما وردا؛ المهم ألّا يتضاعفا عبر مسارين
    expect(supported.citations.length).toBeLessThanOrEqual(2);

    const keys = (supported.citations as { segmentIndex: number; marker: number }[]).map(
      (c) => `${c.segmentIndex}:${c.marker}`,
    );
    const { mergeCitations } = await import("@/lib/evidence/client-citation");
    const merged = mergeCitations([], supported.citations as never);
    expect(merged).toHaveLength(new Set(keys).size);
  });

  it("(١٧) metadata القديمة لا تتغيّر", async () => {
    const messages = await loadPage();
    const supported = messages.find((m) => m.id === "msg-a")! as unknown as {
      sources?: unknown[];
      content: string;
    };
    // `sources` القديمة باقية للتوافق، والمحتوى لم يُمَسّ
    expect(supported.sources).toHaveLength(1);
    expect(supported.content).toBe("جواب مدعوم.");
    // ولا كتابة على القاعدة أثناء القراءة
    expect(rpcCalls.every((c) => c.fn === "get_conversation_evidence")).toBe(true);
  });
});

describe("(١٨)(١٩) الفشل والخصوصية", () => {
  it("(١٨) فشل قراءة الأدلة لا يكسر التحميل", async () => {
    evidenceError = { message: "boom", details: "d", hint: "h", code: "42501" };

    const messages = await loadPage();

    expect(messages).toHaveLength(3);
    expect(messages.find((m) => m.id === "msg-a")!.citations).toEqual([]);
    // الرسائل نفسها وصلت كاملة
    expect(messages.find((m) => m.id === "msg-a")!.content).toBe("جواب مدعوم.");
  });

  it("(١٨ب) الملخّص يبقى من metadata رغم فشل قراءة الصفوف", async () => {
    evidenceError = { message: "boom" };
    const messages = await loadPage();
    // الملخّص مصدره metadata لا الـRPC، فلا يسقط معها
    expect(messages.find((m) => m.id === "msg-a")!.evidence).toMatchObject({ sourcesCount: 1 });
  });

  it("(١٨ج) استثناء في القراءة لا يكسر التحميل", async () => {
    evidenceError = null;
    evidenceRows = null as never; // يجعل الاستجابة غير مصفوفة
    const messages = await loadPage();
    expect(messages).toHaveLength(3);
    expect(messages.find((m) => m.id === "msg-a")!.citations).toEqual([]);
  });

  it("(١٩) لا محتوى حسّاس في السجلّات", async () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";
    evidenceError = {
      message: `duplicate key ... quote=(${SECRET})`,
      details: `Key (quote)=(${SECRET}) already exists.`,
      hint: SECRET,
    };

    await loadPage();

    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("duplicate key");
    expect(all).not.toContain("already exists");
    expect(all).toContain("evidence_read_failed");
  });

  it("(١٩ب) المسار الناجح لا يسجّل اقتباسًا ولا اسم ملف", async () => {
    evidenceRows = [
      evidenceRow({ quote: "SECRET_QUOTE_MUST_NOT_APPEAR", file_name: "SECRET-ملف.pdf" }),
    ];
    await loadPage();

    expect(logs.join("\n")).not.toContain("SECRET_QUOTE_MUST_NOT_APPEAR");
    expect(logs.join("\n")).not.toContain("SECRET-ملف.pdf");
  });
});
