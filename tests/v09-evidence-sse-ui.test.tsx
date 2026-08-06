import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { ChatView } from "@/components/chat/chat-view";

/**
 * البثّ الحيّ في الواجهة (v0.9.0، الإيداع الثامن).
 *
 * تُدار `ChatView` فعليًا ببثٍّ مموّه: أسئلة هذا القسم عن **الحالة** — بأي
 * رسالة تُربط الاستشهادات؟ وهل تتكرر؟ وماذا يبقى حين يفشل الحفظ؟ — ولا يجيب
 * عنها إلا المكوّن نفسه وهو يستهلك الإطارات.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/i18n", () => ({
  // `suggestions` مصفوفة في القاموس الحقيقي — مُحاكاة تُعيد نصًّا لكل مفتاح
  // كانت تُسقط المكوّن عند `suggestions.map`
  useI18n: () => ({
    t: (k: string) => (k === "suggestions" ? [] : k),
    lang: "ar",
    setLang: vi.fn(),
    dir: "rtl",
  }),
}));

vi.mock("@/components/files/upload", () => ({ uploadWithProgress: vi.fn() }));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

/** يبني بثًّا من إطارات SSE */
function sseStream(frames: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
}

const citationFrame = (over: Record<string, unknown> = {}) => ({
  type: "citation",
  segmentIndex: 0,
  marker: 1,
  chunkId: "chunk-1",
  fileId: "file-1",
  chunkIndex: 3,
  fileName: "تقرير.pdf",
  pageNumber: 12,
  quote: "اقتباس حرفي من المصدر",
  quoteStart: 0,
  quoteEnd: 21,
  verification: "exact",
  sourceAvailable: true,
  ...over,
});

const evidenceFrame = (over: Record<string, unknown> = {}) => ({
  type: "evidence",
  supported: true,
  supportedSegments: 1,
  unsupportedSegments: [],
  sourcesCount: 1,
  version: 1,
  ...over,
});

const doneFrame = {
  type: "done",
  userMessageId: "msg-user-1",
  assistantMessageId: "msg-assistant-1",
};

let fetchMock: ReturnType<typeof vi.fn>;

function mountChat(initialMessages: Parameters<typeof ChatView>[0]["initialMessages"] = []) {
  return render(
    <ChatView
      conversationId="11111111-1111-4111-8111-111111111111"
      initialMessages={initialMessages}
      initialTitle="محادثة"
      models={[{ id: "test/model", label: "نموذج", minTier: "free", locked: false } as never]}
      initialModelId="test/model"
      greetingName="مستخدم"
      initialAttachments={[]}
    />,
  );
}

/** يرسل رسالة ويستهلك البثّ */
async function sendAndStream(frames: Record<string, unknown>[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    body: sseStream(frames),
    status: 200,
    json: async () => ({}),
  });

  const textarea = screen.getByRole("textbox");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "سؤال");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const send = screen.getByRole("button", { name: /send/i });
  await act(async () => {
    send.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const citationButtons = () => screen.queryAllByRole("button", { name: /^المصدر \d+/ });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("(٣٤)(٣٥) الأحداث تُربط بالرسالة الجارية", () => {
  it("(٣٤) الاستشهاد يظهر على رسالة المساعد نفسها", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "جواب مدعوم." },
      citationFrame(),
      evidenceFrame(),
      doneFrame,
    ]);

    await waitFor(() => expect(citationButtons()).toHaveLength(1));
    expect(citationButtons()[0]!.textContent).toBe("[1]");
    // ولا رسالة مساعد ثانية
    expect(screen.getAllByText("جواب مدعوم.")).toHaveLength(1);
  });

  it("(٣٥) evidence يحدّث الملخّص فتظهر الفقرة غير الموثّقة", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "الأولى مدعومة.\n\nالثانية غير مدعومة." },
      citationFrame({ segmentIndex: 0 }),
      evidenceFrame({ supportedSegments: 1, unsupportedSegments: [1], sourcesCount: 1 }),
      doneFrame,
    ]);

    await waitFor(() => expect(citationButtons()).toHaveLength(1));
    expect(screen.getByText("غير موثق")).toBeTruthy();
  });
});

describe("(٣٦) فشل الحفظ", () => {
  it("evidence_unavailable يمسح المؤقّت ويُبقي النصّ", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "جواب مدعوم." },
      citationFrame(),
      { type: "evidence_unavailable" },
      doneFrame,
    ]);

    await waitFor(() => expect(screen.getByText("جواب مدعوم.")).toBeTruthy());
    // الاستشهاد المؤقّت أُزيل — لا مرجع يختفي عند إعادة التحميل
    expect(citationButtons()).toHaveLength(0);
    expect(screen.queryByText("غير موثق")).toBeNull();
  });
});

describe("(٣٧)(٣٨)(٣٩)(٤٠) الدمج والترتيب", () => {
  it("(٣٧) الإطار المكرر لا يُنتج زرّين", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "جواب." },
      citationFrame(),
      citationFrame(), // نفس (الفقرة، الرقم)
      evidenceFrame(),
      doneFrame,
    ]);

    await waitFor(() => expect(citationButtons()).toHaveLength(1));
  });

  it("(٤٠) الترتيب تصاعديّ داخل الفقرة", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "جواب بمصادر." },
      citationFrame({ marker: 9 }),
      citationFrame({ marker: 2 }),
      citationFrame({ marker: 10 }),
      evidenceFrame({ sourcesCount: 3 }),
      doneFrame,
    ]);

    await waitFor(() => expect(citationButtons()).toHaveLength(3));
    expect(citationButtons().map((b) => b.textContent)).toEqual(["[2]", "[9]", "[10]"]);
  });

  it("(٣٩) sourceId فارغ في الحيّ لا يكسر الدمج", async () => {
    mountChat();
    await sendAndStream([
      { type: "text", text: "جواب." },
      citationFrame(),
      evidenceFrame(),
      doneFrame,
    ]);
    await waitFor(() => expect(citationButtons()).toHaveLength(1));
  });

  /**
   * (٣٨) البثّ ثم إعادة الجلب: النسخة المُعادة تحمل `sourceId` والحيّة لا.
   * والمفتاح `(الفقرة، الرقم)` يجعلهما واحدًا — والاعتماد على `sourceId` كان
   * سيُبقي الاثنين.
   */
  it("(٣٨) إعادة الجلب بعد البثّ لا تُكرّر", async () => {
    const { mergeCitations, citationFromEvent, citationFromRow } = await import(
      "@/lib/evidence/client-citation"
    );
    const live = [citationFromEvent(citationFrame() as never)];
    const reloaded = [
      citationFromRow({
        source_id: "src-1",
        message_id: "msg-assistant-1",
        segment_index: 0,
        marker: 1,
        chunk_id: "chunk-1",
        file_id: "file-1",
        chunk_index: 3,
        file_name: "تقرير.pdf",
        page_number: 12,
        quote: "اقتباس حرفي من المصدر",
        quote_start: 0,
        quote_end: 21,
        verification: "exact",
        source_available: true,
      }),
    ];
    const merged = mergeCitations(live, reloaded);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sourceId).toBe("src-1");
  });
});

describe("(٤١) الرسائل بلا أدلة", () => {
  it("بثّ بلا إطارات أدلة ⇒ لا زرّ ولا وسم", async () => {
    mountChat();
    await sendAndStream([{ type: "text", text: "جواب عادي." }, doneFrame]);

    await waitFor(() => expect(screen.getByText("جواب عادي.")).toBeTruthy());
    expect(citationButtons()).toHaveLength(0);
    expect(screen.queryByText("غير موثق")).toBeNull();
  });

  it("الرسائل القديمة المحمّلة تُعرض بلا أدلة", () => {
    mountChat([
      {
        id: "old-1",
        role: "assistant",
        content: "ردّ قديم.",
        citations: [],
        evidence: null,
      } as never,
    ]);
    expect(screen.getByText("ردّ قديم.")).toBeTruthy();
    expect(citationButtons()).toHaveLength(0);
  });
});

describe("(١٨)(٢٠)(٥٥) اللوحة من داخل المحادثة", () => {
  it("(١٨) النقر يفتح اللوحة · (٢٠) الإغلاق يعيد التركيز", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/chunks/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            fileId: "file-1",
            fileName: "تقرير.pdf",
            targetChunkId: "chunk-1",
            chunks: [
              {
                chunkId: "chunk-1",
                chunkIndex: 3,
                content: "اقتباس حرفي من المصدر هنا.",
                pageNumber: 12,
                isTarget: true,
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, body: sseStream([]), status: 200, json: async () => ({}) });
    });

    mountChat([
      {
        id: "m-1",
        role: "assistant",
        content: "جواب مدعوم.",
        citations: [
          {
            sourceId: "src-1",
            segmentIndex: 0,
            marker: 1,
            chunkId: "chunk-1",
            fileId: "file-1",
            chunkIndex: 3,
            fileName: "تقرير.pdf",
            pageNumber: 12,
            quote: "اقتباس حرفي من المصدر",
            quoteStart: 0,
            quoteEnd: 21,
            verification: "exact",
            sourceAvailable: true,
          },
        ],
        evidence: {
          supported: true,
          supportedSegments: 1,
          unsupportedSegments: [],
          sourcesCount: 1,
          version: 1,
        },
      } as never,
    ]);

    // (٥٤) لا جلب قبل اختيار مصدر
    expect(fetchMock).not.toHaveBeenCalled();

    const btn = citationButtons()[0]!;
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByRole("dialog", { name: "المصدر 1" })).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes("/chunks/chunk-1?neighbors=1")),
      ).toBe(true),
    );

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    // (٢٠) التركيز عاد إلى الزرّ الذي فتحها — بعد إطار الرسم كي لا يسرقه الحبس
    await waitFor(() => expect(document.activeElement).toBe(citationButtons()[0]));
  });
});
