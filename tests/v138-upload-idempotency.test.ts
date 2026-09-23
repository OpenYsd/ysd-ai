import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * رفعٌ حُفظ ثم وصل ردُّه 502 — الإخفاق الحيّ على التجربة.
 *
 * ★ المقيس على الخادم: إعادةُ الرفع بمعرّف العميل نفسه تُعيد الملفَّ القائم
 *   ولا تُنشئ ثانيًا؛ والرفعُ الأوّل يحفظ المعرّف في البيانات الوصفيّة، ولا
 *   يمحوه الاستخراجُ بعده.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const CLIENT_ID = "44444444-4444-4444-8444-444444444444";

interface Q { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }

const state = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  /** توأمُ المحتوى (بصمةُ البايتات) — `null` يعني: لا ملفَّ بالبايتات نفسِها */
  twin: null as Record<string, unknown> | null,
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  storageUploads: 0,
}));

function makeClient() {
  const from = (table: string) => {
    const q: Q = { table, op: "select", filters: [] };
    const settle = () => {
      state.calls.push(q);
      if (table === "files" && q.op === "select" && q.filters.some(([c]) => c === "metadata->>client_upload_id")) {
        return { data: state.existing, error: null };
      }
      if (table === "files" && q.op === "select" && q.filters.some(([c]) => c === "metadata->>content_sha256")) {
        return { data: state.twin, error: null };
      }
      if (table === "conversations") return { data: { id: CONV }, error: null };
      if (table === "files" && q.op === "insert") return { data: null, error: null };
      if (table === "files" && q.op === "select") return { data: { id: "new-file", status: "ready", original_name: "doc.txt" }, error: null };
      return { data: null, error: null };
    };
    const b = {
      select() { return b; },
      insert(p: unknown) { q.op = "insert"; q.payload = p; return b; },
      update(p: unknown) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      eq(c: string, v: unknown) { q.filters.push([c, v]); return b; },
      is(c: string, v: unknown) { q.filters.push([c, v]); return b; },
      limit() { return b; },
      maybeSingle: async () => settle(),
      single: async () => settle(),
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(settle()).then(res, rej); },
    };
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    from,
    storage: { from: () => ({ upload: async () => { state.storageUploads += 1; return { error: null }; } }) },
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

import { POST } from "@/app/api/files/upload/route";

function uploadRequest(clientUploadId?: string) {
  const fd = new FormData();
  fd.append("file", new File(["نصٌّ عربيّ للاختبار — some text"], "doc.txt", { type: "text/plain" }));
  fd.append("conversationId", CONV);
  if (clientUploadId !== undefined) fd.append("clientUploadId", clientUploadId);
  return new Request("http://x/api/files/upload", { method: "POST", body: fd }) as never;
}

beforeEach(() => {
  state.existing = null;
  state.twin = null;
  state.calls.length = 0;
  state.storageUploads = 0;
  service.processFile.mockClear();
  service.getFileLimits.mockClear();
  service.getFileUsage.mockClear();
});

describe("★ (١) إعادة رفعِ ملفٍّ حُفظ — لا نسخةَ ثانية", () => {
  it("★ ★ ★ المعرّف نفسه ⇒ 200 reused بالملف القائم، بلا إدراجٍ ولا تخزينٍ ولا حصّة", async () => {
    state.existing = { id: "saved-file", status: "ready", original_name: "doc.txt", metadata: { client_upload_id: CLIENT_ID } };
    const res = await POST(uploadRequest(CLIENT_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file: { id: string }; reused: boolean };
    expect(body).toMatchObject({ reused: true, file: { id: "saved-file" } });
    expect(state.calls.some((c) => c.op === "insert")).toBe(false);
    expect(state.storageUploads).toBe(0);
    expect(service.processFile).not.toHaveBeenCalled();
    // قبل فحص الحصّة: ملفُّ المستخدم نفسه لا يُعدّ عليه ثانيةً فيُرفض
    expect(service.getFileUsage).not.toHaveBeenCalled();
    // والبحث محصورٌ في ملفّات المستخدم غير المحذوفة
    const lookup = state.calls.find((c) => c.filters.some(([col]) => col === "metadata->>client_upload_id"))!;
    expect(lookup.filters).toEqual(expect.arrayContaining([["user_id", USER], ["deleted_at", null], ["metadata->>client_upload_id", CLIENT_ID]]));
  });

  it("★ ★ ★ أوّلُ رفعٍ بالمعرّف: يُحفظ في metadata ويُمرَّر للاستخراج ليُدمج لا ليُمحى", async () => {
    const res = await POST(uploadRequest(CLIENT_ID));
    expect(res.status).toBe(201);
    const insert = state.calls.find((c) => c.op === "insert")!;
    expect(insert.payload).toMatchObject({
      metadata: { client_upload_id: CLIENT_ID, content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      conversation_id: CONV,
      status: "uploaded",
    });
    expect(state.storageUploads).toBe(1);
    expect(service.processFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ client_upload_id: CLIENT_ID }) }),
    );
  });

  it("★ ★ ★ ومن غير معرّف: السلوك القديم كما هو (metadata فارغ)", async () => {
    const res = await POST(uploadRequest());
    expect(res.status).toBe(201);
    expect(state.calls.some((c) => c.filters.some(([col]) => col === "metadata->>client_upload_id"))).toBe(false);
    // ★ البصمةُ تُكتب ولو بلا معرّف عميل: بها وحدها تُمنع إعادةُ الاختيار من التكرار
    const payload = state.calls.find((c) => c.op === "insert")!.payload as { metadata: Record<string, unknown> };
    expect(Object.keys(payload.metadata)).toEqual(["content_sha256"]);
    expect(payload.metadata.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★ ★ ★ ومعرّفٌ غير صالح يُرفض 400 — لا يُحقن في استعلام", async () => {
    const res = await POST(uploadRequest("not-a-uuid'; drop table files; --"));
    expect(res.status).toBe(400);
    expect(state.calls.some((c) => c.op === "insert")).toBe(false);
  });
});

describe("★ (٢) processFile يدمج البيانات الوصفيّة", () => {
  it("★ ★ ★ client_upload_id يبقى بعد الاستخراج، ومعه extracted_chars", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      from: () => ({
        update(p: Record<string, unknown>) { updates.push(p); return { eq: async () => ({ error: null }) }; },
      }),
      storage: { from: () => ({ download: async () => ({ data: new Blob(["نصٌّ مستخرج للاختبار"]), error: null }) }) },
    };
    const { processFile: realProcessFile } = await vi.importActual<typeof import("@/lib/files/service")>("@/lib/files/service");
    const out = await realProcessFile(client as never, {
      id: "f1",
      storage_path: "u/f1/doc.txt",
      original_name: "doc.txt",
      mime_type: "text/plain",
      metadata: { client_upload_id: CLIENT_ID },
    });
    expect(out.status).toBe("ready");
    const final = updates.at(-1)!;
    expect(final.metadata).toMatchObject({ client_upload_id: CLIENT_ID });
    expect((final.metadata as Record<string, unknown>).extracted_chars).toBeGreaterThan(0);
  });
});
