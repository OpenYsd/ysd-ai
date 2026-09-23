import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v142 — بصمةُ المحتوى وربطُ المحادثة في مسار الرفع.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ ما يُحرس هنا — وكلُّه مقيسٌ في الإنتاج قبل أن يُكتب:
 *
 *  (١) إعادةُ اختيار الملفِّ نفسِه تحمل `clientUploadId` جديدًا، فكان يُنشأ
 *      صفٌّ ثانٍ: ثلاثةُ صفوفٍ لـ«اليوم الوطني.pdf» في الإنتاج. البصمةُ
 *      (sha256 + الحجم) داخل المحادثة تمنعه — والاسمُ ليس مفتاحًا: اسمٌ
 *      واحدٌ ببايتاتٍ مختلفة ملفّان.
 *
 *  (٢) رفعٌ بدأ في محادثة (أ) ثمّ انتقل صاحبُه إلى (ب): كان المعرّفُ وحده
 *      يعيد صفَّ (أ) إلى (ب) — ربطٌ خاطئٌ صامت. الآن: المحادثةُ نفسُها ⇒
 *      يُعاد؛ صفٌّ بلا محادثة ⇒ يُربط صراحةً؛ محادثةٌ أخرى ⇒ صفٌّ جديدٌ
 *      لـ(ب)، و(أ) لا تُمسّ.
 * ══════════════════════════════════════════════════════════════════
 *
 * القاعدةُ هنا جدولٌ في الذاكرة يطبّق مرشّحاتِ `eq`/`is` فعلًا (ومنها
 * `metadata->>key`) — فالتطابقُ يُقاس لا يُلقَّن.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CID_1 = "44444444-4444-4444-8444-444444444444";
const CID_2 = "55555555-5555-4555-8555-555555555555";

type FileRow = {
  id: string;
  user_id: string;
  conversation_id: string | null;
  original_name: string;
  size_bytes: number;
  status: string;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
  mime_type: string;
};

const db = vi.hoisted(() => ({
  files: [] as FileRow[],
  ownedConversations: new Set<string>(),
  storageUploads: 0,
  updates: [] as Array<{ id: unknown; payload: Record<string, unknown> }>,
  /** يحاكي سباقًا: الإدراجُ التالي يُرفض 23505 بعد أن يُدرج «الرابح» هذا الصف */
  raceWinner: null as FileRow | null,
}));

function read(row: Record<string, unknown>, col: string): unknown {
  if (col.startsWith("metadata->>")) return (row.metadata as Record<string, unknown>)?.[col.slice(11)] ?? null;
  return row[col] ?? null;
}

function makeClient() {
  const from = (table: string) => {
    const filters: Array<["eq" | "is", string, unknown]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Record<string, unknown> | null = null;

    const matches = (r: Record<string, unknown>) =>
      filters.every(([k, c, v]) => (k === "is" ? read(r, c) === v : read(r, c) === v));

    const settle = (): { data: unknown; error: unknown } => {
      if (table === "conversations") {
        const id = filters.find(([, c]) => c === "id")?.[2] as string;
        return { data: db.ownedConversations.has(id) ? { id } : null, error: null };
      }
      if (table !== "files") return { data: null, error: null };
      if (op === "insert") {
        if (db.raceWinner) {
          db.files.push(db.raceWinner);
          db.raceWinner = null;
          return { data: null, error: { code: "23505" } };
        }
        db.files.push({ ...(payload as FileRow), deleted_at: null });
        return { data: null, error: null };
      }
      if (op === "update") {
        const hits = db.files.filter(matches);
        for (const h of hits) {
          db.updates.push({ id: h.id, payload: payload! });
          Object.assign(h, payload);
        }
        return { data: hits[0] ?? null, error: null };
      }
      if (op === "delete") {
        db.files = db.files.filter((r) => !matches(r));
        return { data: null, error: null };
      }
      return { data: db.files.find(matches) ?? null, error: null };
    };

    const b: Record<string, unknown> = {
      select() { return b; },
      insert(p: Record<string, unknown>) { op = "insert"; payload = p; return b; },
      update(p: Record<string, unknown>) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: unknown) { filters.push(["eq", c, v]); return b; },
      is(c: string, v: unknown) { filters.push(["is", c, v]); return b; },
      in() { return b; },
      neq() { return b; },
      limit() { return b; },
      maybeSingle: async () => settle(),
      single: async () => settle(),
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        // استعلامُ فجوة الفضاء على file_chunks: لا مقاطعَ في هذه القاعدة
        if (table === "file_chunks") return Promise.resolve({ data: [], error: null }).then(res, rej);
        return Promise.resolve(settle()).then(res, rej);
      },
    };
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from,
    storage: { from: () => ({ upload: async () => { db.storageUploads += 1; return { error: null }; } }) },
  };
}

const service = vi.hoisted(() => ({
  processFile: vi.fn(async () => ({ status: "ready" as const })),
  getFileLimits: vi.fn(async () => ({ tier: "free", maxFileMb: 10, planMaxFileMb: 10, providerLimited: false, maxFiles: 50, maxStorageMb: 200 })),
  getFileUsage: vi.fn(async () => ({ count: 0, bytes: 0 })),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeClient() }));
vi.mock("@/lib/rate-limit-distributed", () => ({
  BUCKET_UPLOAD: "upload",
  consumeRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/files/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/files/service")>();
  return { ...real, processFile: service.processFile, getFileLimits: service.getFileLimits, getFileUsage: service.getFileUsage };
});
// التجهيزُ الخلفيّ خارج هذا الاختبار: لا وظائفَ ولا تصريف
vi.mock("@/lib/rag/worker", () => ({ drainOwnJobs: vi.fn(async () => ({ busy: false })) }));
vi.mock("@/lib/rag/jobs", () => ({ enqueueRagJob: vi.fn(async () => ({ job: { id: "j" }, created: true })) }));

import { POST } from "@/app/api/files/upload/route";

const BYTES_X = "تقريرٌ عن اليوم الوطني — national day report, version X";
const BYTES_Y = "تقريرٌ عن اليوم الوطني — national day report, version Y";

function upload(opts: { bytes?: string; name?: string; conversationId?: string | null; clientUploadId?: string }) {
  const fd = new FormData();
  fd.append("file", new File([opts.bytes ?? BYTES_X], opts.name ?? "اليوم الوطني.txt", { type: "text/plain" }));
  if (opts.conversationId) fd.append("conversationId", opts.conversationId);
  if (opts.clientUploadId) fd.append("clientUploadId", opts.clientUploadId);
  return POST(new Request("http://x/api/files/upload", { method: "POST", body: fd }) as never);
}

type Body = { file: { id: string; conversation_id: string | null }; reused?: boolean; relinked?: boolean; dedupedBy?: string };
const liveRows = () => db.files.filter((f) => f.deleted_at === null);

beforeEach(() => {
  db.files = [];
  db.ownedConversations = new Set([CONV_A, CONV_B]);
  db.storageUploads = 0;
  db.updates = [];
  db.raceWinner = null;
  service.processFile.mockClear();
});

describe("★ (١) البصمة — لا تكرارَ لنفس البايتات، ولا ابتلاعَ لمحتوًى مختلف", () => {
  it("★ ★ ★ إعادةُ الطلب نفسه (المعرّف نفسه، المحادثة نفسها) ⇒ الصفُّ نفسه", async () => {
    const first = (await (await upload({ conversationId: CONV_A, clientUploadId: CID_1 })).json()) as Body;
    const res = await upload({ conversationId: CONV_A, clientUploadId: CID_1 });
    const again = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(again).toMatchObject({ reused: true, file: { id: first.file.id } });
    expect(liveRows()).toHaveLength(1);
    expect(db.storageUploads).toBe(1);
  });

  it("★ ★ ★ إعادةُ اختيار الملفِّ نفسه (معرّفٌ جديد) ⇒ لا صفَّ ثانٍ ولا تخزينَ ثانٍ", async () => {
    const first = (await (await upload({ conversationId: CONV_A, clientUploadId: CID_1 })).json()) as Body;
    const res = await upload({ conversationId: CONV_A, clientUploadId: CID_2 });
    const repick = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(repick).toMatchObject({ reused: true, dedupedBy: "content", file: { id: first.file.id } });
    expect(liveRows()).toHaveLength(1);
    expect(db.storageUploads).toBe(1);
    expect(service.processFile).toHaveBeenCalledTimes(1);
  });

  it("★ ★ ★ وبلا معرّفٍ إطلاقًا (عميلٌ قديم) ⇒ البصمةُ وحدها تمنع التكرار", async () => {
    await upload({ conversationId: CONV_A });
    const res = await upload({ conversationId: CONV_A });
    expect(res.status).toBe(200);
    expect(liveRows()).toHaveLength(1);
  });

  it("★ ★ ★ الاسمُ نفسه والبايتاتُ مختلفة ⇒ ملفٌّ جديد (لا يُبتلع أحدُهما)", async () => {
    const a = (await (await upload({ conversationId: CONV_A, bytes: BYTES_X })).json()) as Body;
    const res = await upload({ conversationId: CONV_A, bytes: BYTES_Y });
    const b = (await res.json()) as Body;
    expect(res.status).toBe(201);
    expect(b.file.id).not.toBe(a.file.id);
    expect(liveRows()).toHaveLength(2);
    const shas = liveRows().map((r) => r.metadata.content_sha256);
    expect(new Set(shas).size).toBe(2);
  });

  it("★ ★ ★ البايتاتُ نفسها باسمٍ آخر ⇒ الملفُّ نفسه (الهويّةُ للمحتوى لا للاسم)", async () => {
    const a = (await (await upload({ conversationId: CONV_A, name: "a.txt" })).json()) as Body;
    const b = (await (await upload({ conversationId: CONV_A, name: "نسخة a.txt" })).json()) as Body;
    expect(b.file.id).toBe(a.file.id);
    expect(liveRows()).toHaveLength(1);
  });

  it("★ ★ ★ سباقٌ متزامن: الفهرسُ الفريدُ يرفض الثاني 23505 ⇒ يُعاد صفُّ الرابح", async () => {
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(Buffer.from(BYTES_X)).digest("hex");
    db.raceWinner = {
      id: "winner", user_id: USER, conversation_id: CONV_A, original_name: "اليوم الوطني.txt",
      size_bytes: Buffer.byteLength(BYTES_X), status: "ready", deleted_at: null,
      metadata: { content_sha256: sha }, mime_type: "text/plain",
    };
    const res = await upload({ conversationId: CONV_A, clientUploadId: CID_1 });
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reused: true, dedupedBy: "content", file: { id: "winner" } });
    expect(liveRows()).toHaveLength(1);
    expect(db.storageUploads).toBe(0);
  });

  it("★ ★ ★ صفٌّ محذوفٌ منطقيًّا لا يُعدّ توأمًا: إعادةُ الرفع بعد الحذف تُنشئ ملفًّا", async () => {
    const a = (await (await upload({ conversationId: CONV_A })).json()) as Body;
    db.files.find((f) => f.id === a.file.id)!.deleted_at = "2026-09-23T00:00:00Z";
    const res = await upload({ conversationId: CONV_A });
    expect(res.status).toBe(201);
    expect(liveRows()).toHaveLength(1);
    expect(liveRows()[0]!.id).not.toBe(a.file.id);
  });
});

describe("★ (٢) ربطُ المحادثة — لا يُعاد ربطٌ قديمٌ صامتًا أبدًا", () => {
  it("★ ★ ★ الملفُّ نفسُه مرفقًا عمدًا بمحادثةٍ أخرى ⇒ صفٌّ مستقلٌّ لها، والأولى لا تُمسّ", async () => {
    const a = (await (await upload({ conversationId: CONV_A })).json()) as Body;
    const res = await upload({ conversationId: CONV_B });
    const b = (await res.json()) as Body;
    expect(res.status).toBe(201);
    expect(b.file.id).not.toBe(a.file.id);
    const byConv = Object.fromEntries(liveRows().map((r) => [r.id, r.conversation_id]));
    expect(byConv).toEqual({ [a.file.id]: CONV_A, [b.file.id]: CONV_B });
    expect(db.updates).toEqual([]);
  });

  it("★ ★ ★ انتقالٌ أثناء الرفع: إعادةُ المعرّف لمحادثة (ب) لا تعيد صفَّ (أ)", async () => {
    // بدأ الرفعُ في (أ) وحُفظ، ثمّ انتقل صاحبُه إلى (ب) وأعاد الطلبَ بالمعرّف نفسه
    const a = (await (await upload({ conversationId: CONV_A, clientUploadId: CID_1 })).json()) as Body;
    const res = await upload({ conversationId: CONV_B, clientUploadId: CID_1 });
    const b = (await res.json()) as Body;
    expect(b.file.id).not.toBe(a.file.id);
    expect(b.file.conversation_id ?? liveRows().find((r) => r.id === b.file.id)!.conversation_id).toBe(CONV_B);
    // (أ) بقي مرفقُها كما هو — لا نقلَ ولا فكَّ ربط
    expect(liveRows().find((r) => r.id === a.file.id)!.conversation_id).toBe(CONV_A);
    expect(db.updates).toEqual([]);
  });

  it("★ ★ ★ صفٌّ بلا محادثة (رُفع قبل إنشائها) ⇒ يُربط صراحةً بالمحادثة الطالبة", async () => {
    const orphan = (await (await upload({ conversationId: null, clientUploadId: CID_1 })).json()) as Body;
    const res = await upload({ conversationId: CONV_B, clientUploadId: CID_1 });
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reused: true, relinked: true, file: { id: orphan.file.id } });
    expect(db.updates).toEqual([{ id: orphan.file.id, payload: { conversation_id: CONV_B } }]);
    expect(liveRows()).toHaveLength(1);
  });

  it("★ ★ ★ ولا يُربط بمحادثةٍ لا يملكها المستخدم", async () => {
    await upload({ conversationId: null, clientUploadId: CID_1 });
    db.ownedConversations.delete(CONV_B);
    const res = await upload({ conversationId: CONV_B, clientUploadId: CID_1 });
    expect(res.status).toBe(404);
    expect(db.updates).toEqual([]);
  });

  it("★ ★ ★ توأمُ البصمة محصورٌ في المحادثة: توأمٌ في (أ) لا يُعاد لطلبٍ في (ب)", async () => {
    await upload({ conversationId: CONV_A, clientUploadId: CID_1 });
    const res = await upload({ conversationId: CONV_B, clientUploadId: CID_2 });
    const b = (await res.json()) as Body;
    expect(res.status).toBe(201);
    expect(liveRows().find((r) => r.id === b.file.id)!.conversation_id).toBe(CONV_B);
  });
});
