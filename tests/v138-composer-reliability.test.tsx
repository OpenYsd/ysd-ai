import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * موثوقيّة المرفقات والتجهيز — الإخفاقات الثلاثة كما رُصدت حيًّا على التجربة.
 *
 * ١) ردٌّ 502 بعد أن حُفظ الملفُّ على الخادم ⇒ بطاقة «تعذّر الرفع» بزرّ إعادةٍ يكرّر الملف.
 * ٢) تجهيزٌ توقّف (إعادة تشغيل الخادم) ⇒ وظيفةٌ «تعمل» بنبضٍ ميّت إلى الأبد.
 * ٣) الاستطلاع ينقطع بعد ٥ دقائق ⇒ بطاقةٌ عالقةٌ على «يُجهَّز».
 *
 * الرفع مُحاكى بمقبضٍ يُتحكَّم فيه، و`fetch` موجَّهٌ حسب المسار، والتوقيتات
 * مُصغَّرة عبر `COMPOSER_TIMINGS` كي تجري الاختبارات بالزمن الحقيقيّ.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => (k === "suggestions" ? [] : k), locale: "en", setLocale: vi.fn(), dir: "ltr" }),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

interface FakeUpload {
  file: File;
  conversationId: string | null | undefined;
  clientUploadId: string | null | undefined;
  resolve: (r: { ok: boolean; file?: Record<string, unknown>; error?: string; status?: number }) => void;
  abort: ReturnType<typeof vi.fn>;
}
const uploads: FakeUpload[] = [];

vi.mock("@/components/files/upload", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/files/upload")>();
  return {
    ...real,
    uploadWithProgress: vi.fn((opts: { file: File; conversationId?: string | null; clientUploadId?: string | null }) => {
      let resolve!: FakeUpload["resolve"];
      const done = new Promise<Parameters<FakeUpload["resolve"]>[0]>((r) => (resolve = r));
      const abort = vi.fn(() => resolve({ ok: false, error: "aborted", status: 0 }));
      uploads.push({ file: opts.file, conversationId: opts.conversationId, clientUploadId: opts.clientUploadId, resolve, abort });
      return { abort, done };
    }),
  };
});

import { ChatView } from "@/components/chat/chat-view";
import type { Attachment } from "@/components/chat/chat-view";
import { COMPOSER_TIMINGS, discardCarriedAttachments } from "@/components/chat/use-composer-attachments";

const CONV = "11111111-1111-4111-8111-111111111111";
const DEFAULT_TIMINGS = { ...COMPOSER_TIMINGS };

type Row = Record<string, unknown> & { id: string; status: string };
type Job = { status: string; heartbeat_at?: string | null; available_at?: string | null } | null;

let fetchMock: ReturnType<typeof vi.fn>;
/** ما «حفظه» الخادم لكل معرّف عميل — يُسأل عنه عند المصالحة */
let savedByClientId: Map<string, Row>;
/** ما يعيده GET /api/files/:id — دالّةٌ كي تتطوّر الحالة عبر الاستطلاعات */
let fileState: Record<string, () => { file: Row; job: Job }>;
let ragPosts: string[];
let processPosts: string[];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function route(url: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/files?clientUploadId=")) {
    const id = decodeURIComponent(url.split("=")[1] ?? "");
    const row = savedByClientId.get(id);
    return json({ files: row ? [row] : [], usage: {}, limits: { maxFileMb: 5 } });
  }
  if (url.startsWith("/api/files?")) return json({ files: [], usage: {}, limits: { maxFileMb: 5 } });
  const m = /^\/api\/files\/([^/]+)(\/rag|\/process)?$/.exec(url);
  if (m) {
    const id = m[1] as string;
    if (m[2] === "/process" && method === "POST") {
      processPosts.push(id);
      return json({ file: fileState[id]?.().file ?? { id, status: "processing" }, job: null });
    }
    if (m[2] === "/rag" && method === "POST") {
      ragPosts.push(id);
      return json({ file: fileState[id]?.().file ?? { id, status: "ready" }, queued: true }, 202);
    }
    if (!m[2] && method === "GET") {
      const s = fileState[id];
      return s ? json(s()) : json({ error: "not found" }, 404);
    }
  }
  return json({ error: "unexpected" }, 500);
}

function mount(initialAttachments: Attachment[] = []) {
  return render(
    <ChatView
      key={CONV}
      conversationId={CONV}
      initialMessages={[]}
      initialTitle="t"
      models={[{ id: "test/model", label: "m", minTier: "free", locked: false } as never]}
      initialModelId="test/model"
      greetingName=""
      initialAttachments={initialAttachments}
    />,
  );
}

const doc = (name: string) => new File([new Uint8Array(512)], name, { type: "text/plain" });
const cards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("[data-attachment-card]")];
const phases = (c: HTMLElement) => cards(c).map((el) => el.getAttribute("data-attachment-phase"));
const statusText = (c: HTMLElement) => cards(c).map((el) => el.querySelector("[data-attachment-status]")?.textContent ?? "");
const pick = (c: HTMLElement, files: File[]) =>
  fireEvent.change(c.querySelector("[data-attachment-input]") as HTMLInputElement, { target: { files } });
const reconcileCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/files?clientUploadId="));
const pollCalls = (id: string) => fetchMock.mock.calls.filter(([u, i]) => u === `/api/files/${id}` && (i?.method ?? "GET") === "GET");
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function row(id: string, status: string, extra: Record<string, unknown> = {}): Row {
  return { id, original_name: `${id}.txt`, mime_type: "text/plain", size_bytes: 512, status, project_id: null, conversation_id: CONV, extraction_error: null, metadata: {}, created_at: "", updated_at: "", rag_total_chunks: null, rag_done_chunks: null, rag_error: null, ...extra };
}

beforeEach(() => {
  uploads.length = 0;
  savedByClientId = new Map();
  fileState = {};
  ragPosts = [];
  processPosts = [];
  Object.assign(COMPOSER_TIMINGS, DEFAULT_TIMINGS, {
    pollMinMs: 10,
    pollMaxMs: 40,
    reconcileDelaysMs: [0, 20, 20],
    stallMinAgeMs: 0,
    nudgeGapMs: 0,
    maxNudges: 2,
  });
  fetchMock = vi.fn((url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  discardCarriedAttachments();
  vi.unstubAllGlobals();
  Object.assign(COMPOSER_TIMINGS, DEFAULT_TIMINGS);
});

describe("★ (١) 502 بعد الحفظ على الخادم — مصالحةٌ قبل أيّ إعادة", () => {
  it("★ ★ ★ الإخفاق الحيّ: الملف حُفظ ثم وصل 502 ⇒ يُتبنّى، بلا زرّ إعادة، بلا رفعٍ ثانٍ، وتجهيزٌ مرّةً واحدة", async () => {
    const { container } = mount();
    pick(container, [doc("notes.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    const clientId = uploads[0]!.clientUploadId!;
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);

    // الخادم حفظ الملف بهذا المعرّف… ثم قطع الوسيطُ الردّ
    savedByClientId.set(clientId, row("fs", "ready", { metadata: { client_upload_id: clientId } }));
    fileState.fs = () => ({ file: row("fs", "chunking"), job: { status: "running", heartbeat_at: new Date().toISOString() } });
    await act(async () => uploads[0]!.resolve({ ok: false, status: 502, error: "HTTP 502" }));

    await waitFor(() => expect(phases(container)).toEqual(["indexing"]));
    expect(reconcileCalls()[0]![0]).toBe(`/api/files?clientUploadId=${encodeURIComponent(clientId)}`);
    expect(uploads).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "retryUpload" })).toBeNull();
    await waitFor(() => expect(ragPosts).toEqual(["fs"]));
  });

  it("★ ★ ★ وأثناء السؤال: «نتحقّق من حفظ الملف» — والإرسال والإزالة محجوبان", async () => {
    COMPOSER_TIMINGS.reconcileDelaysMs = [0, 150, 150];
    const { container } = mount();
    pick(container, [doc("slow.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: false, status: 502, error: "HTTP 502" }));
    await waitFor(() => expect(statusText(container)[0]).toContain("attachmentVerifying"));
    expect(phases(container)).toEqual(["processing"]);
    expect((cards(container)[0]!.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    // حُفظ في الأثناء: المحاولة التالية تجده
    savedByClientId.set(uploads[0]!.clientUploadId!, row("fl", "ready_for_rag"));
    await waitFor(() => expect(phases(container)).toEqual(["ready"]), { timeout: 2000 });
    expect(uploads).toHaveLength(1);
  });

  it("★ ★ ★ 502 ولم يُحفظ شيء ⇒ إعادةٌ متاحة، والإعادة بالمعرّف نفسه (فيُعيد الخادم ما حُفظ في الأثناء)", async () => {
    const { container } = mount();
    pick(container, [doc("lost.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: false, status: 502, error: "HTTP 502" }));
    await waitFor(() => expect(phases(container)).toEqual(["error"]));
    expect(reconcileCalls()).toHaveLength(COMPOSER_TIMINGS.reconcileDelaysMs.length);

    fireEvent.click(screen.getByRole("button", { name: "retryUpload" }));
    await waitFor(() => expect(uploads).toHaveLength(2));
    expect(uploads[1]!.clientUploadId).toBe(uploads[0]!.clientUploadId);
    expect(uploads[1]!.file).toBe(uploads[0]!.file);
  });

  it("★ ★ ★ انقطاع الشبكة (لا ردّ أصلًا) يُصالَح كذلك", async () => {
    const { container } = mount();
    pick(container, [doc("net.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    savedByClientId.set(uploads[0]!.clientUploadId!, row("fn", "ready_for_rag"));
    await act(async () => uploads[0]!.resolve({ ok: false, status: 0, error: "network" }));
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    expect(uploads).toHaveLength(1);
  });

  it("★ ★ ★ ولا مصالحةَ حيث المصيرُ معلوم: إلغاءٌ من المستخدم، أو 413", async () => {
    const { container } = mount();
    pick(container, [doc("cancel.txt"), doc("big.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "cancelUpload" })[0]!);
    await act(async () => uploads[1]!.resolve({ ok: false, status: 413, error: "too big" }));
    await waitFor(() => expect(phases(container)).toEqual(["error"]));
    await wait(80);
    expect(reconcileCalls()).toHaveLength(0);
  });
});

describe("★ (٢) تجهيزٌ متوقّف — كشفٌ من بيانات الخادم واستئنافٌ محدود", () => {
  async function uploadDoc(container: HTMLElement, id: string) {
    pick(container, [doc(`${id}.txt`)]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: row(id, "ready") }));
  }

  it("★ ★ ★ الإخفاق الحيّ: وظيفةٌ «تعمل» بنبضٍ ميّت ⇒ يُستأنف بطلب تجهيزٍ فيكتمل", async () => {
    // الاستئنافُ (طلبُ التجهيز الثاني) هو ما يُحيي الوظيفة — لا مؤقّتُ الاختبار
    fileState.fd = () =>
      ragPosts.length >= 2
        ? { file: row("fd", "ready_for_rag", { rag_total_chunks: 4, rag_done_chunks: 4 }), job: { status: "completed" } }
        : { file: row("fd", "embedding", { rag_total_chunks: 4 }), job: { status: "running", heartbeat_at: minutesAgo(10) } };
    const { container } = mount();
    await uploadDoc(container, "fd");
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    expect(ragPosts).toEqual(["fd", "fd"]);
  });

  it("★ ★ ★ الاستئناف محدود: بعد maxNudges خطأٌ «توقّف» بزرّ إعادة، ويتوقّف الاستطلاع", async () => {
    fileState.fx = () => ({ file: row("fx", "embedding"), job: { status: "running", heartbeat_at: minutesAgo(10) } });
    const { container } = mount();
    await uploadDoc(container, "fx");
    await waitFor(() => expect(phases(container)).toEqual(["error"]), { timeout: 3000 });
    // طلب التجهيز الأوّل + استئنافان — لا أكثر
    expect(ragPosts).toEqual(["fx", "fx", "fx"]);
    expect(statusText(container)[0]).toContain("attachmentErrStalled");
    const pollsAtError = pollCalls("fx").length;
    await wait(120);
    expect(pollCalls("fx").length).toBe(pollsAtError);

    // إعادةٌ يدويّة: طلبٌ جديد، وتعود محاولات الاستئناف
    fireEvent.click(screen.getByRole("button", { name: "ragRetry" }));
    await waitFor(() => expect(ragPosts.length).toBeGreaterThanOrEqual(4));
    await waitFor(() => expect(phases(container)).toEqual(["error"]), { timeout: 3000 });
    expect(ragPosts).toHaveLength(6);
  });

  it("★ ★ ★ وظيفةٌ مستحقّةٌ في الطابور لم يلتقطها أحد ⇒ تُستأنف", async () => {
    let n = 0;
    fileState.fq = () => (n++ < 3 ? { file: row("fq", "ready"), job: { status: "queued", available_at: minutesAgo(5) } } : { file: row("fq", "ready_for_rag"), job: { status: "completed" } });
    const { container } = mount();
    await uploadDoc(container, "fq");
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    expect(ragPosts.length).toBeGreaterThanOrEqual(2);
  });

  it("★ ★ ★ وبطءٌ مشروع لا يُستعجل: نبضٌ حيّ ⇒ لا استئناف", async () => {
    fileState.fs = () => ({ file: row("fs", "embedding", { rag_total_chunks: 50 }), job: { status: "running", heartbeat_at: new Date().toISOString() } });
    const { container } = mount();
    await uploadDoc(container, "fs");
    await wait(300);
    expect(ragPosts).toEqual(["fs"]);
    expect(phases(container)).toEqual(["indexing"]);
  });

  it("★ ★ ★ وبعد إعادة التحميل: ملفٌّ عالقٌ في embedding يُستأنف عند التركيب", async () => {
    fileState.fr = () => ({ file: row("fr", "embedding", { rag_total_chunks: 3 }), job: { status: "running", heartbeat_at: minutesAgo(10) } });
    mount([{ id: "fr", name: "fr.txt", status: "embedding", mime: "text/plain", size: 512, ragTotal: 3, ragDone: 0 }]);
    await waitFor(() => expect(ragPosts).toContain("fr"));
  });
});

describe("★ (٣) الاستطلاع لا ينقطع بعد مدّةٍ ثابتة — ولا يُلحّ", () => {
  it("★ ★ ★ أكثر من ٢٠٠ استطلاعٍ ما دام التجهيز جاريًا (الحدّ القديم)، ثم يتوقّف عند الاكتمال", async () => {
    Object.assign(COMPOSER_TIMINGS, { pollMinMs: 1, pollMaxMs: 2 });
    let done = false;
    let beat = 0;
    fileState.fp = () =>
      done
        ? { file: row("fp", "ready_for_rag"), job: { status: "completed" } }
        : { file: row("fp", "embedding"), job: { status: "running", heartbeat_at: new Date(Date.now() - (beat++ % 2)).toISOString() } };
    const { container } = mount();
    pick(container, [doc("fp.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: row("fp", "ready") }));
    await waitFor(() => expect(pollCalls("fp").length).toBeGreaterThan(220), { timeout: 8000 });
    expect(phases(container)).toEqual(["indexing"]);
    done = true;
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    const final = pollCalls("fp").length;
    await wait(60);
    expect(pollCalls("fp").length).toBe(final);
  }, 15000);

  it("★ ★ ★ ويتباطأ حين لا يتغيّر شيء — لا إلحاح على الخادم", async () => {
    Object.assign(COMPOSER_TIMINGS, { pollMinMs: 10, pollMaxMs: 80, pollFactor: 2 });
    const heartbeat = new Date().toISOString();
    fileState.fb = () => ({ file: row("fb", "embedding"), job: { status: "running", heartbeat_at: heartbeat } });
    const { container } = mount();
    pick(container, [doc("fb.txt")]);
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0]!.resolve({ ok: true, status: 201, file: row("fb", "ready") }));
    await wait(900);
    // 10 → 20 → 40 → 80 → 80 … ≈ 12 استطلاعًا في 900ms؛ بلا تباطؤٍ لكانت ~90
    const n = pollCalls("fb").length;
    expect(n).toBeGreaterThan(4);
    expect(n).toBeLessThan(25);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  ★ (٤) انتقالُ فضاء التضمين — «قيد التجهيز لفضاء البحث الحالي»
 *
 *  ملفٌّ حالتُه `ready_for_rag` لكنه مفهرسٌ في الفضاء الآخر: الخادمُ يقول
 *  `needs_active_embedding: true`. فالواجهةُ لا تقول «جاهز»، والإرسالُ
 *  محجوب، والتجهيزُ يُطلب تلقائيًّا (لا زرَّ على المستخدم)، ثمّ يُفتح
 *  الإرسالُ وحدَه حين يحكم الخادمُ بالجاهزيّة.
 *
 *  وبلا الاستئناف من الواجهة كانت حلقةَ جمود: الإرسالُ محجوب ⇒ لا يصل
 *  مسارَ المحادثة طلبٌ يُدرج الوظيفة ⇒ يبقى محجوبًا إلى الأبد.
 * ══════════════════════════════════════════════════════════════════
 */
describe("★ (٤) انتقال فضاء التضمين — لا إخفاء، ولا حجبٌ دائم", () => {
  /** ملفّاتُ المحادثة تحت مفتاح «ملفات هذه المحادثة» — تُفتح لتُرى بطاقاتُها */
  const openContext = (c: HTMLElement) => fireEvent.click(c.querySelector("[data-context-toggle]") as HTMLButtonElement);

  const spaceGapFile = (id: string): Attachment => ({
    id,
    name: `${id}.txt`,
    status: "ready_for_rag",
    mime: "text/plain",
    size: 512,
    needsActiveEmbedding: true,
  });

  it("★ ★ ★ بعد التحميل: «يُجهَّز لفضاء البحث الحالي»، والإرسالُ محجوب، والتجهيزُ يُطلب تلقائيًّا ثمّ يُفتح", async () => {
    fileState.sg = () =>
      ragPosts.includes("sg")
        ? { file: row("sg", "ready_for_rag", { needs_active_embedding: false, rag_total_chunks: 3, rag_done_chunks: 3 }), job: { status: "completed" } }
        : { file: row("sg", "ready_for_rag", { needs_active_embedding: true }), job: null };
    COMPOSER_TIMINGS.pollMinMs = 60; // يُتاح رسمُ الحالة الأولى قبل أوّل استطلاع
    const { container } = mount([spaceGapFile("sg")]);
    openContext(container);

    // ★ لا «جاهز» كاذب: المرحلةُ تجهيز، والعبارةُ عبارةُ انتقال الفضاء لا عبارةُ عطل
    expect(phases(container)).toEqual(["indexing"]);
    expect(statusText(container)[0]).toContain("ragPreparingSpace");
    expect(container.textContent).toContain("filePreparing");

    // ★ استئنافٌ من الواجهة بلا تدخّل: طلبُ تجهيزٍ واحد للفضاء الفعّال
    await waitFor(() => expect(ragPosts).toEqual(["sg"]));
    // ★ ثمّ يُفتح الإرسالُ وحدَه حين يحكم الخادم
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    expect(statusText(container)[0]).toContain("ragReady");
    expect(container.textContent).not.toContain("filePreparing");
  });

  it("★ ★ ★ ووظيفةُ الفضاء الجديد تعمل بنبضٍ حيّ: يُنتظر بلا إلحاح، والحجبُ باقٍ حتى الاكتمال", async () => {
    let done = false;
    fileState.sw = () =>
      done
        ? { file: row("sw", "ready_for_rag", { needs_active_embedding: false }), job: { status: "completed" } }
        : { file: row("sw", "ready_for_rag", { needs_active_embedding: true }), job: { status: "running", heartbeat_at: new Date().toISOString() } };
    const { container } = mount([spaceGapFile("sw")]);
    openContext(container);
    await waitFor(() => expect(pollCalls("sw").length).toBeGreaterThanOrEqual(3));
    // نبضٌ حيّ ⇒ لا استئناف: الوظيفةُ قائمة، والإلحاحُ عليها يضاعف الحِمل
    expect(ragPosts).toEqual([]);
    expect(phases(container)).toEqual(["indexing"]);
    expect(container.textContent).toContain("filePreparing");
    done = true;
    await waitFor(() => expect(phases(container)).toEqual(["ready"]));
    expect(container.textContent).not.toContain("filePreparing");
  });

  it("★ ★ ★ ملفٌّ جاهزٌ في الفضاء الفعّال لا يُستطلع ولا يُعاد تجهيزه", async () => {
    const { container } = mount([{ ...spaceGapFile("ok"), needsActiveEmbedding: false }]);
    openContext(container);
    await wait(80);
    expect(phases(container)).toEqual(["ready"]);
    expect(pollCalls("ok")).toHaveLength(0);
    expect(ragPosts).toEqual([]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════
 *  ★ (٥) بياناتٌ عالقة من قبل — تُستعاد بلا زرّ
 *
 *  الإنتاجُ يحمل عشرةَ ملفّاتٍ على `ready` (نصٌّ مستخرَج، لا تجهيز) وملفًّا
 *  على `processing` (استخراجٌ مات في منتصفه). كلاهما يحجب الإرسالَ في
 *  محادثته، ولم يكن شيءٌ يحرّكهما: الأوّل ينتظر زرًّا، والثاني لا يُستطلع.
 * ══════════════════════════════════════════════════════════════════
 */
describe("★ (٥) الملفّات العالقة قبل النشر — استعادةٌ تلقائيّة", () => {
  const openContext = (c: HTMLElement) => fireEvent.click(c.querySelector("[data-context-toggle]") as HTMLButtonElement);
  const legacy = (id: string, status: string): Attachment => ({ id, name: `${id}.txt`, status, mime: "text/plain", size: 512 });

  it("★ ★ ★ مستندٌ على `ready` منذ ما قبل النشر ⇒ يُطلب تجهيزُه عند الفتح، ويُفتح الإرسال حين يجهز", async () => {
    fileState.lr = () =>
      ragPosts.includes("lr")
        ? { file: row("lr", "ready_for_rag", { rag_total_chunks: 2, rag_done_chunks: 2 }), job: { status: "completed" } }
        : { file: row("lr", "ready"), job: null };
    const { container } = mount([legacy("lr", "ready")]);
    openContext(container);
    await waitFor(() => expect(ragPosts).toEqual(["lr"]));
    await waitFor(() => expect(statusText(container)[0]).toContain("ragReady"));
    expect(container.textContent).not.toContain("filePreparing");
  });

  it("★ ★ ★ استخراجٌ مات في منتصفه (`processing` قديم) ⇒ يُعاد تلقائيًّا ثمّ يُجهَّز", async () => {
    COMPOSER_TIMINGS.extractStallMs = 60_000;
    fileState.lp = () =>
      ragPosts.includes("lp")
        ? { file: row("lp", "ready_for_rag", { rag_total_chunks: 2, rag_done_chunks: 2 }), job: { status: "completed" } }
        : processPosts.includes("lp")
          ? { file: row("lp", "ready", { updated_at: new Date().toISOString() }), job: null }
          : { file: row("lp", "processing", { updated_at: minutesAgo(30) }), job: null };
    const { container } = mount([legacy("lp", "processing")]);
    openContext(container);
    expect(container.textContent).toContain("filePreparing");
    await waitFor(() => expect(processPosts).toEqual(["lp"]));
    // «جاهزٌ للمحادثة» بحكم الخادم — لا المرحلةُ الوسيطة «استُخرج النصّ»
    await waitFor(() => expect(statusText(container)[0]).toContain("ragReady"), { timeout: 3000 });
    expect(ragPosts).toEqual(["lp"]);
    expect(container.textContent).not.toContain("filePreparing");
  });

  it("★ ★ ★ ولا يُعاد استخراجٌ حيّ: `processing` حديثٌ يُنتظر بلا تدخّل", async () => {
    COMPOSER_TIMINGS.extractStallMs = 60_000;
    fileState.lf = () => ({ file: row("lf", "processing", { updated_at: new Date().toISOString() }), job: null });
    const { container } = mount([legacy("lf", "processing")]);
    openContext(container);
    await waitFor(() => expect(pollCalls("lf").length).toBeGreaterThanOrEqual(3));
    expect(processPosts).toEqual([]);
  });

  it("★ ★ ★ ميّتٌ لا يحيا: بعد maxNudges خطأٌ بزرّ «أعد الاستخراج» — والإرسالُ لا يُحجب به", async () => {
    COMPOSER_TIMINGS.extractStallMs = 60_000;
    fileState.ld = () => ({ file: row("ld", "processing", { updated_at: minutesAgo(30) }), job: null });
    const { container } = mount([legacy("ld", "processing")]);
    openContext(container);
    await waitFor(() => expect(phases(container)).toEqual(["error"]), { timeout: 3000 });
    expect(processPosts).toEqual(["ld", "ld"]);
    expect(container.textContent).not.toContain("filePreparing");
    expect(screen.getByRole("button", { name: "retryExtract" })).toBeTruthy();
  });
});
