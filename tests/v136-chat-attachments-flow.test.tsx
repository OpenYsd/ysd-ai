import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * مرفقات شريط الكتابة داخل `ChatView` الحقيقيّ — المسارات كما هي على الخادم.
 *
 * ★ الرفع مُحاكى بمقبضٍ يُتحكَّم فيه (تقدّم، نجاح، فشل، إلغاء)، و`fetch` موجَّهٌ
 *   حسب المسار. والمقيس: أيَّ المسارات نادت الواجهة، وبأيّ جسم، وما رسمته.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    t: (k: string) => (k === "suggestions" ? [] : k),
    locale: "en",
    setLocale: vi.fn(),
    dir: "ltr",
  }),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

interface FakeUpload {
  file: File;
  conversationId: string | null | undefined;
  onProgress?: (p: number) => void;
  resolve: (r: { ok: boolean; file?: Record<string, unknown>; error?: string; status?: number; retryAfterSec?: number }) => void;
  abort: ReturnType<typeof vi.fn>;
}
const uploads: FakeUpload[] = [];

vi.mock("@/components/files/upload", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/files/upload")>();
  return {
    ...real,
    uploadWithProgress: vi.fn((opts: { file: File; conversationId?: string | null; onProgress?: (p: number) => void }) => {
      let resolve!: FakeUpload["resolve"];
      const done = new Promise<Parameters<FakeUpload["resolve"]>[0]>((r) => (resolve = r));
      const abort = vi.fn(() => resolve({ ok: false, error: "aborted", status: 0 }));
      uploads.push({ file: opts.file, conversationId: opts.conversationId, onProgress: opts.onProgress, resolve, abort });
      return { abort, done };
    }),
  };
});

import { ChatView } from "@/components/chat/chat-view";
import type { Attachment } from "@/components/chat/chat-view";

const CONV = "11111111-1111-4111-8111-111111111111";
const CONV_B = "22222222-2222-4222-8222-222222222222";

let fetchMock: ReturnType<typeof vi.fn>;
let serverFiles: Record<string, Record<string, unknown>>;
let maxFileMb: number;

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function sse(frames: Record<string, unknown>[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.close();
    },
  });
}

function route(url: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/files?")) return json({ files: [], usage: {}, limits: { maxFileMb } });
  const m = /^\/api\/files\/([^/]+)(\/rag|\/process)?$/.exec(url);
  if (m) {
    const id = m[1] as string;
    if (m[2] === "/rag" && method === "POST") return json({ file: serverFiles[id] });
    if (!m[2] && method === "PATCH") return json({ file: { ...serverFiles[id], conversation_id: null } });
    if (!m[2] && method === "GET") return json({ file: serverFiles[id] });
  }
  if (url === "/api/chat" && method === "POST") {
    return Promise.resolve({ ok: true, status: 200, body: sse([{ type: "text", text: "ok" }, { type: "done", userMessageId: "u1", assistantMessageId: "a1" }]), json: async () => ({}) });
  }
  return json({ error: "unexpected" }, 500);
}

function mount(initialAttachments: Attachment[] = [], conversationId = CONV) {
  return render(
    <ChatView
      key={conversationId}
      conversationId={conversationId}
      initialMessages={[]}
      initialTitle="t"
      models={[{ id: "test/model", label: "m", minTier: "free", locked: false } as never]}
      initialModelId="test/model"
      greetingName=""
      initialAttachments={initialAttachments}
    />,
  );
}

const pdf = (name: string, size = 1024) => new File([new Uint8Array(size)], name, { type: "application/pdf" });
const png = (name: string) => new File([new Uint8Array(64)], name, { type: "image/png" });

function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector("[data-attachment-input]") as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const cards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-attachment-card]")];
const phases = (c: HTMLElement) => cards(c).map((el) => el.getAttribute("data-attachment-phase"));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function serverRow(id: string, name: string, mime: string, status: string, size = 1024) {
  const row = { id, original_name: name, mime_type: mime, size_bytes: size, status, project_id: null, conversation_id: CONV, extraction_error: null, metadata: {}, created_at: "", updated_at: "" };
  serverFiles[id] = row;
  return row;
}

async function typeMessage(text: string) {
  const ta = screen.getByRole("textbox");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  uploads.length = 0;
  serverFiles = {};
  maxFileMb = 5;
  fetchMock = vi.fn((url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("★ (١) عدّة ملفّات، اثنان في آنٍ واحد", () => {
  it("★ ★ ★ ثلاثة ملفّات: رفعان يبدآن والثالث ينتظر، ثم يبدأ حين يفرغ مكان", async () => {
    const { container } = mount();
    pick(container, [pdf("a.pdf"), pdf("b.pdf"), png("c.png")]);
    await waitFor(() => expect(uploads).toHaveLength(2));
    expect(phases(container)).toEqual(["uploading", "uploading", "selected"]);
    // كلُّ رفعٍ يحمل معرّف المحادثة التي اختير فيها
    expect(uploads.every((u) => u.conversationId === CONV)).toBe(true);

    await act(async () => uploads[0]!.onProgress?.(55));
    expect(screen.getAllByRole("progressbar")[0]?.getAttribute("aria-valuenow")).toBe("55");

    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: serverRow("fa", "a.pdf", "application/pdf", "ready") }));
    await waitFor(() => expect(uploads).toHaveLength(3));
    expect(uploads[2]!.file.name).toBe("c.png");
    // المستند الجاهز النص يُرسل للتجهيز عبر المسار نفسه كما كان
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/files/fa/rag" && i?.method === "POST")).toBe(true));
    expect(phases(container)[0]).toBe("indexing");

    await act(async () => uploads[2]!.resolve({ ok: true, status: 201, file: serverRow("fc", "c.png", "image/png", "ready") }));
    await waitFor(() => expect(phases(container)[2]).toBe("ready"));
    // والصورة لا تُرسل للتجهيز (بلا OCR)
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/files/fc/rag")).toBe(false);
  });

  it("★ ★ ★ التحقّق المسبق بحدّ الخادم: ما يتجاوزه أو لا يُدعم لا يُرفع أصلًا", async () => {
    maxFileMb = 1;
    const { container } = mount();
    const zip = new File([new Uint8Array(10)], "x.zip", { type: "application/zip" });
    pick(container, [pdf("big.pdf", 2 * 1024 * 1024), zip, pdf("ok.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]!.file.name).toBe("ok.pdf");
    await waitFor(() => expect(phases(container)).toEqual(["error", "error", "uploading"]));
    expect(cards(container)[0]?.textContent).toContain("1 MB");
    // الحدّ جاء من الخادم نفسه
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith(`/api/files?conversationId=${CONV}`))).toBe(true);
  });
});

describe("★ (٢) الفشل وإعادة المحاولة", () => {
  it("★ ★ ★ 429 يوقف الطابور كلَّه مدّةَ Retry-After — لا يُرمى باقي الدفعة على نافذةٍ مغلقة", async () => {
    const { container } = mount();
    pick(container, [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(2));
    const tooMany = { ok: false, status: 429, error: "عمليات رفع كثيرة | Too many uploads", retryAfterSec: 1 };

    await act(async () => uploads[0]!.resolve(tooMany));
    await act(async () => uploads[1]!.resolve({ ok: true, status: 201, file: serverRow("fb", "b.pdf", "application/pdf", "ready") }));
    await flush();
    await flush();
    // مكانان فرغا، وثلاثة ملفّات تنتظر — ولا طلبَ جديد قبل انقضاء المدّة
    expect(uploads).toHaveLength(2);
    expect(phases(container)).toEqual(["selected", "indexing", "selected", "selected"]);
    expect(cards(container)[0]?.querySelector("[data-attachment-status]")?.textContent).toContain("attachmentQueued");

    // بعد المدّة: الملف المرفوض أوّلًا (نفسه)، ثم التالي في الدفعة
    await waitFor(() => expect(uploads).toHaveLength(4), { timeout: 3000 });
    expect(uploads[2]!.file).toBe(uploads[0]!.file);
    expect(uploads[3]!.file.name).toBe("c.pdf");
  }, 10000);

  it("★ ★ ★ الانتظار التلقائيّ محدود: بعد ثلاثة 429 للملف نفسه خطأٌ بزرّ إعادةٍ يدويّة", async () => {
    const { container } = mount();
    pick(container, [pdf("a.pdf")]);
    const tooMany = { ok: false, status: 429, error: "عمليات رفع كثيرة | Too many uploads", retryAfterSec: 1 };
    for (let attempt = 1; attempt <= 4; attempt++) {
      await waitFor(() => expect(uploads).toHaveLength(attempt), { timeout: 3000 });
      await act(async () => uploads[attempt - 1]!.resolve(tooMany));
    }
    await waitFor(() => expect(phases(container)).toEqual(["error"]));
    await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
    expect(uploads).toHaveLength(4);

    // الإعادة اليدويّة ترفع الملف نفسه — بعد أن تنقضي مهلة الخادم
    fireEvent.click(screen.getByRole("button", { name: "retryUpload" }));
    await waitFor(() => expect(uploads).toHaveLength(5));
    expect(uploads[4]!.file).toBe(uploads[0]!.file);
    await act(async () => uploads[4]!.resolve({ ok: true, status: 201, file: serverRow("f1", "a.pdf", "application/pdf", "ready") }));
    await waitFor(() => expect(phases(container)).toEqual(["indexing"]));
  }, 15000);

  it("★ ★ ★ Retry-After يُقرأ من ردّ الخادم الحقيقيّ في uploadWithProgress", async () => {
    const real = await vi.importActual<typeof import("@/components/files/upload")>("@/components/files/upload");
    class FakeXhr {
      status = 0;
      responseText = "";
      upload = { onprogress: null as unknown };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      getResponseHeader(name: string) { return name.toLowerCase() === "retry-after" ? "42" : null; }
      send() {
        this.status = 429;
        this.responseText = JSON.stringify({ error: "Too many uploads" });
        queueMicrotask(() => this.onload?.());
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const res = await real.uploadWithProgress({ file: pdf("a.pdf"), conversationId: CONV }).done;
    expect(res).toMatchObject({ ok: false, status: 429, retryAfterSec: 42 });
  });

  it("★ ★ ★ 413 من الخادم: لا زرّ إعادة — الإعادة لن تغيّر الحجم", async () => {
    const { container } = mount();
    pick(container, [pdf("a.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: false, status: 413, error: "كبير | File exceeds plan limit" }));
    await waitFor(() => expect(phases(container)).toEqual(["error"]));
    expect(screen.queryByRole("button", { name: "retryUpload" })).toBeNull();
    expect(cards(container)[0]?.querySelector("[data-attachment-status]")?.getAttribute("title")).toBe("File exceeds plan limit");
  });
});

describe("★ (٣) الإزالة قبل الإرسال", () => {
  it("★ ★ ★ إلغاءُ رفعٍ جارٍ يُجهضه ولا يترك أثرًا", async () => {
    const { container } = mount();
    pick(container, [pdf("a.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "cancelUpload" }));
    await waitFor(() => expect(cards(container)).toHaveLength(0));
    expect(uploads[0]!.abort).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
  });

  it("★ ★ ★ ملفٌّ رُبط بالمحادثة يُفكّ منها بـPATCH — لا حذف", async () => {
    const { container } = mount();
    pick(container, [png("p.png")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: serverRow("fp", "p.png", "image/png", "ready") }));
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    fireEvent.click(screen.getByRole("button", { name: "removeFromContext" }));
    await waitFor(() => expect(cards(container)).toHaveLength(0));
    const patch = fetchMock.mock.calls.find(([u, i]) => u === "/api/files/fp" && i?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ conversationId: null });
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
  });
});

describe("★ (٤) الإرسال: ينتظر الرفع، ولا يدّعي علاقةً بالرسالة", () => {
  it("★ ★ ★ الإرسال معطّل حتى يُربط الملف، ثم تصير البطاقة سياقًا للمحادثة", async () => {
    const { container } = mount();
    await typeMessage("summarize the file");
    pick(container, [png("chart.png")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    const sendBtn = () => screen.getByRole("button", { name: /send/ }) as HTMLButtonElement;
    expect(sendBtn().disabled).toBe(true);

    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: serverRow("fch", "chart.png", "image/png", "ready") }));
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    await act(async () => { sendBtn().click(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/chat")).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => u === "/api/chat")?.[1]?.body));
    expect(body.message).toBe("summarize the file");
    // الخادم يأخذ الملفات من المحادثة لا من الطلب — ولم يُضف حقلٌ يوحي بغير ذلك
    expect(Object.keys(body)).not.toContain("attachments");
    await flush();
    await waitFor(() => expect(container.querySelector("[data-context-toggle]")).not.toBeNull());
    expect(cards(container)).toHaveLength(0);
    // ولا يُرسم الملف داخل فقاعة الرسالة: لا علاقة بينهما في المخطّط
    const bubble = screen.getByText("summarize the file");
    expect(bubble.closest("[data-attachment-card]")).toBeNull();
    expect(container.querySelectorAll("[title='chart.png']")).toHaveLength(0);
  });
});

describe("★ (٥) إعادة التحميل والتنقّل بين المحادثات", () => {
  it("★ ★ ★ بعد إعادة التحميل: ملفّات المحادثة بأحجامها، والتجهيز الجاري يُتابَع", async () => {
    serverRow("fr", "r.pdf", "application/pdf", "ready_for_rag", 4096);
    const { container } = mount([{ id: "fr", name: "r.pdf", status: "embedding", mime: "application/pdf", size: 4096, ragTotal: 4, ragDone: 1 }]);
    const toggle = container.querySelector("[data-context-toggle]") as HTMLButtonElement;
    expect(toggle.textContent).toContain("1");
    fireEvent.click(toggle);
    expect(phases(container)).toEqual(["indexing"]);
    expect(cards(container)[0]?.textContent).toContain("4 KB");
    await waitFor(() => expect(phases(container)).toEqual(["ready"]), { timeout: 4000 });
    expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/files/fr" && (i?.method ?? "GET") === "GET")).toBe(true);
  });

  it("★ ★ ★ الانتقال لمحادثةٍ أخرى يُلغي رفع الأولى، ولا يُظهر ملفّها في الثانية", async () => {
    const view = mount([], CONV);
    pick(view.container, [pdf("from-a.pdf")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(uploads[0]!.conversationId).toBe(CONV);

    view.rerender(
      <ChatView
        key={CONV_B}
        conversationId={CONV_B}
        initialMessages={[]}
        initialTitle="t"
        models={[{ id: "test/model", label: "m", minTier: "free", locked: false } as never]}
        initialModelId="test/model"
        greetingName=""
        initialAttachments={[{ id: "fb", name: "b-only.pdf", status: "ready_for_rag", mime: "application/pdf", size: 10 }]}
      />,
    );
    await flush();
    expect(uploads[0]!.abort).toHaveBeenCalledTimes(1);
    const toggle = view.container.querySelector("[data-context-toggle]") as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(cards(view.container).map((c) => c.querySelector("[title]")?.getAttribute("title"))).toEqual(["b-only.pdf"]);
  });
});
