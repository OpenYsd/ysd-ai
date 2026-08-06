import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * مسار فتح المقطع (v0.9.0، الإيداع السابع).
 *
 * كل ما يُختبر هنا يدور حول سؤالين: هل يمكن أن يصل محتوى مقطعٍ إلى غير صاحبه؟
 * وهل يفرّق الرد بين «غير موجود» و«ليس لك» فيصير مِسبارًا؟
 */

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
const fromCalls: string[] = [];

let user: { id: string } | null = { id: "user-1" };
let rpcRows: unknown = [];
let rpcError: unknown = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      fromCalls.push(table);
      return {};
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcError ? { data: null, error: rpcError } : { data: rpcRows, error: null };
    },
  }),
}));

const FILE = "11111111-1111-4111-8111-111111111111";
const CHUNK = "22222222-2222-4222-8222-222222222222";

const chunkRow = (index: number, isTarget: boolean, over: Record<string, unknown> = {}) => ({
  chunk_id: `chunk-${index}`,
  file_id: FILE,
  chunk_index: index,
  content: `محتوى المقطع ${index}`,
  page_number: index + 1,
  original_name: "تقرير.pdf",
  is_target: isTarget,
  ...over,
});

async function call(
  path = `?neighbors=1`,
  ids: { file?: string; chunk?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const mod = await import("@/app/api/files/[id]/chunks/[chunkId]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/files/${ids.file ?? FILE}/chunks/${ids.chunk ?? CHUNK}${path}`,
  );
  const res = await mod.GET(req as never, {
    params: Promise.resolve({ id: ids.file ?? FILE, chunkId: ids.chunk ?? CHUNK }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

let logs: string[];

beforeEach(() => {
  vi.resetModules();
  rpcCalls.length = 0;
  fromCalls.length = 0;
  user = { id: "user-1" };
  rpcError = null;
  rpcRows = [chunkRow(0, false), chunkRow(1, true), chunkRow(2, false)];

  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

describe("(٢٠)(٢١)(٢٢) نافذة الجوار", () => {
  it("(٢٠) neighbors=0 ⇒ الهدف وحده", async () => {
    rpcRows = [chunkRow(1, true)];
    const { status, body } = await call("?neighbors=0");

    expect(status).toBe(200);
    expect(rpcCalls[0]!.args.p_neighbors).toBe(0);
    expect(body.chunks).toHaveLength(1);
    expect(body.targetChunkId).toBe("chunk-1");
    expect(body.fileId).toBe(FILE);
    expect(body.fileName).toBe("تقرير.pdf");
  });

  it("(٢١) neighbors=1 ⇒ ثلاثة بترتيب chunkIndex", async () => {
    const { status, body } = await call("?neighbors=1");
    const chunks = body.chunks as { chunkIndex: number; isTarget: boolean }[];

    expect(status).toBe(200);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.filter((c) => c.isTarget)).toHaveLength(1);
    expect(chunks.find((c) => c.isTarget)!.chunkIndex).toBe(1);
  });

  it("(٢٢) neighbors=2 ⇒ خمسة", async () => {
    rpcRows = [0, 1, 2, 3, 4].map((i) => chunkRow(i, i === 2));
    const { status, body } = await call("?neighbors=2");

    expect(status).toBe(200);
    expect(rpcCalls[0]!.args.p_neighbors).toBe(2);
    expect(body.chunks).toHaveLength(5);
  });

  it("الافتراضي 1 حين يغيب المَعلَم", async () => {
    await call("");
    expect(rpcCalls[0]!.args.p_neighbors).toBe(1);
  });

  it("الترتيب حسب chunkIndex ولو ورد مبعثرًا", async () => {
    rpcRows = [chunkRow(2, false), chunkRow(0, false), chunkRow(1, true)];
    const { body } = await call();
    expect((body.chunks as { chunkIndex: number }[]).map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });
});

describe("(٢٣) القيم غير الصالحة ⇒ 400 عامة", () => {
  it.each([
    ["3", "?neighbors=3"],
    ["99", "?neighbors=99"],
    ["سالب", "?neighbors=-1"],
    ["كسر", "?neighbors=1.5"],
    ["نصّ", "?neighbors=abc"],
    // كشفها الاختبار: Number("") صفر، فكانت تُقرأ «صفر جيران» بدل أن تُرفض
    ["فارغ", "?neighbors="],
    ["ست عشري", "?neighbors=0x2"],
    ["بفراغات", "?neighbors=%201%20"],
    ["بإشارة", "?neighbors=%2B1"],
    ["عشري بصفر", "?neighbors=1.0"],
  ])("%s ⇒ 400 بلا نداء للقاعدة", async (_label, query) => {
    const { status, body } = await call(query);

    expect(status).toBe(400);
    expect(body).toEqual({ error: "طلب غير صحيح." });
    // ★ لا يُصحَّح صامتًا ولا يبلغ القاعدة أصلًا
    expect(rpcCalls).toHaveLength(0);
  });

  it("معرّف غير uuid ⇒ 400", async () => {
    const bad = await call("", { file: "not-a-uuid" });
    expect(bad.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);

    const bad2 = await call("", { chunk: "12345" });
    expect(bad2.status).toBe(400);
  });
});

describe("(٢٤)(٢٥)(٣٠) لا تفريق في الرفض", () => {
  /**
   * ملفٌ غير موجود، ومقطعٌ غير موجود، ومقطعٌ لمستخدم آخر، ومقطعٌ من ملف آخر،
   * ومصدرٌ محذوف: كلها **صفر صفوف** من الدالة ⇒ رد واحد. والتفريق مِسبار.
   */
  it.each([
    ["(٢٤) مقطع من ملف آخر"],
    ["(٢٥) ملف مستخدم آخر"],
    ["(٣٠) مصدر محذوف"],
    ["غير موجود أصلًا"],
  ])("%s ⇒ 404 عامة واحدة", async () => {
    rpcRows = [];
    const { status, body } = await call();

    expect(status).toBe(404);
    expect(body).toEqual({ error: "المصدر غير متاح." });
  });

  it("الردود الأربعة متطابقة حرفًا بحرف", async () => {
    rpcRows = [];
    const a = await call("", { file: FILE });
    const b = await call("", { chunk: "33333333-3333-4333-8333-333333333333" });
    expect(a.status).toBe(b.status);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it("(٣٠ب) المصدر المحذوف لا يُنتج 500", async () => {
    rpcRows = [];
    const { status } = await call();
    expect(status).not.toBe(500);
    expect(status).toBe(404);
  });
});

describe("(٢٦) الجلسة إلزامية", () => {
  it("بلا جلسة ⇒ 401 وبلا نداء للقاعدة", async () => {
    user = null;
    const { status, body } = await call();

    expect(status).toBe(401);
    expect(body).toEqual({ error: "غير مصرح" });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("(٢٧) سقف المقاطع", () => {
  it("لا يُعيد أكثر من خمسة مهما أعادت القاعدة", async () => {
    rpcRows = Array.from({ length: 12 }, (_, i) => chunkRow(i, i === 0));
    const { body } = await call();

    expect((body.chunks as unknown[])).toHaveLength(5);
    expect((body.chunks as { chunkIndex: number }[]).map((c) => c.chunkIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe("(٢٨) لا تخزين مؤقت", () => {
  it("Cache-Control: private, no-store في النجاح والفشل معًا", async () => {
    const ok = await call();
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");

    rpcRows = [];
    const missing = await call();
    expect(missing.headers.get("Cache-Control")).toBe("private, no-store");

    user = null;
    const unauth = await call();
    expect(unauth.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("(٢٩) ★ لا محتوى في السجلّات", () => {
  it("لا محتوى ولا اسم ملف ولا معرّفات عند النجاح", async () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";
    rpcRows = [chunkRow(1, true, { content: SECRET, original_name: `${SECRET}.pdf` })];

    await call();

    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(FILE);
    expect(all).not.toContain(CHUNK);
    expect(all).toContain("evidence.chunk");
  });

  it("لا تفصيل خطأ من القاعدة عند الفشل", async () => {
    const SECRET = "SECRET_QUOTE_MUST_NOT_APPEAR";
    rpcError = {
      message: `content=(${SECRET})`,
      details: `Key (content)=(${SECRET})`,
      hint: SECRET,
      code: "42501",
    };

    const { status, body } = await call();

    expect(status).toBe(500);
    expect(body).toEqual({ error: "تعذّر فتح المصدر." });
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("42501");
    expect(all).toContain("chunk_read_failed");
  });
});

describe("★ الطريق الوحيد هو الدالة", () => {
  it("لا استعلام مباشر على أي جدول", async () => {
    await call();

    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.fn).toBe("get_owned_file_chunk");
    expect(rpcCalls[0]!.args).toEqual({
      p_file_id: FILE,
      p_chunk_id: CHUNK,
      p_neighbors: 1,
    });
  });

  it("لا عميل خدمة ولا وصول مباشر في الشيفرة", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "app/api/files/[id]/chunks/[chunkId]/route.ts",
      "utf8",
    ).replace(/\r\n/g, "\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

    expect(code).not.toMatch(/getAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
    expect(code).not.toMatch(/\.from\s*\(/);
    expect(code).not.toMatch(/error\s*\.\s*(message|details|hint)/);
    // الدالة وحدها
    const rpcs = code.match(/\.rpc\(\s*"([a-z_]+)"/g) ?? [];
    expect(rpcs).toEqual(['.rpc("get_owned_file_chunk"']);
  });

  it("الرد لا يحمل relevance ولا حقولًا زائدة", async () => {
    const { body } = await call();

    expect(Object.keys(body).sort()).toEqual(["chunks", "fileId", "fileName", "targetChunkId"]);
    const chunk = (body.chunks as Record<string, unknown>[])[0]!;
    expect(Object.keys(chunk).sort()).toEqual([
      "chunkId", "chunkIndex", "content", "isTarget", "pageNumber",
    ]);
    expect(JSON.stringify(body)).not.toContain("relevance");
  });
});
