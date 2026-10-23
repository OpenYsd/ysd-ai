/**
 * المكتبة والمشاريع — مسارات الخادم (المرحلة 2).
 *
 * ── ما تحرسه هذه المجموعة ──
 *
 *   - لا يصل مستخدمٌ إلى ملف غيره ولا مشروعه: قراءةً ولا تسميةً ولا ربطًا ولا رابطًا موقّتًا.
 *   - الربط بمشروع لا ينسخ ملفًّا ولا يمسّ التخزين؛ وفكّ الربط لا يحذف شيئًا.
 *   - إعادة التسمية تغيّر الاسم المعروض وحده، تعقّمه، ولا تغيّر الامتداد ولا مسار التخزين.
 *   - حذف المشروع يفكّ ربط ملفاته ولا يحذفها.
 *   - كل استعلام يحمل شرط user_id صريحًا فوق RLS (دفاعٌ مضاعف).
 *
 * قاعدة بيانات في الذاكرة تطبّق RLS كما في 0001_init.sql (الصفّ لصاحبه وحده)،
 * وتسجّل كل عملية وكل نداء تخزين.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = [string, "eq" | "is" | "in", unknown];

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MY_FILE = "11111111-1111-4111-8111-111111111111";
const MY_PDF = "11111111-1111-4111-8111-222222222222";
const THEIR_FILE = "22222222-2222-4222-8222-222222222222";
const MY_PROJECT = "33333333-3333-4333-8333-333333333333";
const MY_OTHER_PROJECT = "33333333-3333-4333-8333-444444444444";
const THEIR_PROJECT = "44444444-4444-4444-8444-444444444444";
const THEIR_CONV = "55555555-5555-4555-8555-555555555555";

let authUser: { id: string } | null;
let db: Record<string, Row[]>;
let ops: { table: string; op: string; filters: Filter[]; values?: Row }[];
let storageCalls: { op: string; args: unknown[] }[];

function builder(table: string) {
  let op: "select" | "update" | "insert" | "delete" = "select";
  let values: Row | undefined;
  let single: "one" | "maybe" | null = null;
  const filters: Filter[] = [];

  // RLS كما في الترحيلات: كل جدول بـuser_id لا يُرى ولا يُعدَّل إلا لصاحبه
  const visible = (r: Row) => r.user_id === undefined || r.user_id === authUser?.id;
  const matches = (r: Row) =>
    visible(r) &&
    filters.every(([c, k, v]) =>
      k === "eq" ? r[c] === v : k === "is" ? (r[c] ?? null) === v : (v as unknown[]).includes(r[c]),
    );

  async function exec() {
    ops.push({ table, op, filters: [...filters], values });
    const rows = (db[table] ??= []);
    let out: Row[] = [];
    if (op === "select") out = rows.filter(matches);
    if (op === "update") {
      out = rows.filter(matches);
      for (const r of out) Object.assign(r, values);
    }
    if (op === "delete") {
      out = rows.filter(matches);
      db[table] = rows.filter((r) => !out.includes(r));
    }
    if (op === "insert") {
      const r = { id: `new-${rows.length + 1}`, ...values };
      rows.push(r);
      out = [r];
    }
    if (single) {
      const r = out[0] ?? null;
      return single === "one" && !r ? { data: null, error: { message: "no rows" } } : { data: r, error: null };
    }
    return { data: out, error: null };
  }

  const api: Record<string, unknown> = {
    select: () => api,
    update: (v: Row) => ((op = "update"), (values = v), api),
    insert: (v: Row) => ((op = "insert"), (values = v), api),
    delete: () => ((op = "delete"), api),
    eq: (c: string, v: unknown) => (filters.push([c, "eq", v]), api),
    is: (c: string, v: unknown) => (filters.push([c, "is", v]), api),
    in: (c: string, v: unknown[]) => (filters.push([c, "in", v]), api),
    order: () => api,
    limit: () => api,
    maybeSingle: () => ((single = "maybe"), exec()),
    single: () => ((single = "one"), exec()),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser } }) },
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        remove: async (...args: unknown[]) => (storageCalls.push({ op: "remove", args }), { error: null }),
        createSignedUrl: async (...args: unknown[]) => (
          storageCalls.push({ op: "createSignedUrl", args }),
          { data: { signedUrl: `https://storage.example/sign/${String(args[0])}?token=t` }, error: null }
        ),
        upload: async (...args: unknown[]) => (storageCalls.push({ op: "upload", args }), { error: null }),
        copy: async (...args: unknown[]) => (storageCalls.push({ op: "copy", args }), { error: null }),
      }),
    },
  }),
}));

const file = (id: string, user_id: string, over: Row = {}): Row => ({
  id,
  user_id,
  original_name: "تقرير الربع.pdf",
  storage_path: `${user_id}/general/${id}/report.pdf`,
  mime_type: "application/pdf",
  size_bytes: 2048,
  status: "ready",
  project_id: null,
  conversation_id: null,
  deleted_at: null,
  ...over,
});

beforeEach(() => {
  vi.resetModules();
  authUser = { id: ME };
  ops = [];
  storageCalls = [];
  db = {
    files: [
      file(MY_FILE, ME, { project_id: MY_OTHER_PROJECT }),
      file(MY_PDF, ME, { original_name: "notes.pdf" }),
      file(THEIR_FILE, OTHER, { original_name: "secret.pdf" }),
    ],
    projects: [
      { id: MY_PROJECT, user_id: ME, name: "مشروعي", deleted_at: null },
      { id: MY_OTHER_PROJECT, user_id: ME, name: "آخر", deleted_at: null },
      { id: THEIR_PROJECT, user_id: OTHER, name: "ليس لي", deleted_at: null },
    ],
    conversations: [
      { id: "c-mine", user_id: ME, project_id: MY_PROJECT, deleted_at: null },
      { id: THEIR_CONV, user_id: OTHER, project_id: null, deleted_at: null },
    ],
  };
});

async function patchFile(id: string, body: unknown) {
  const mod = await import("@/app/api/files/[id]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://localhost/api/files/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  const res = await mod.PATCH(req as never, { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Row };
}

async function download(id: string) {
  const mod = await import("@/app/api/files/[id]/download/route");
  const { NextRequest } = await import("next/server");
  const res = await mod.GET(new NextRequest(`http://localhost/api/files/${id}/download`) as never, {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as Row };
}

async function deleteProject(id: string) {
  const mod = await import("@/app/api/projects/[id]/route");
  const { NextRequest } = await import("next/server");
  const res = await mod.DELETE(new NextRequest(`http://localhost/api/projects/${id}`, { method: "DELETE" }) as never, {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as Row };
}

const row = (id: string) => db.files!.find((f) => f.id === id)!;
const fileWrites = () => ops.filter((o) => o.table === "files" && o.op !== "select");

describe("إعادة التسمية", () => {
  it("تغيّر الاسم المعروض وحده — بلا مساس بمسار التخزين ولا بالتخزين نفسه", async () => {
    const before = String(row(MY_PDF).storage_path);
    const { status, body } = await patchFile(MY_PDF, { name: "ملاحظات الاجتماع.pdf" });
    expect(status).toBe(200);
    expect(body.name).toBe("ملاحظات الاجتماع.pdf");
    expect(row(MY_PDF).original_name).toBe("ملاحظات الاجتماع.pdf");
    expect(row(MY_PDF).storage_path).toBe(before);
    expect(storageCalls).toEqual([]);
  });

  it("تعقيم الاسم: لا مسارات ولا أحرف محظورة", async () => {
    const { status } = await patchFile(MY_PDF, { name: "../../etc/<pass>wd.pdf" });
    expect(status).toBe(200);
    expect(row(MY_PDF).original_name).toBe("passwd.pdf");
  });

  it("الامتداد لا يتغيّر — والمحاولة تُرفض بلا كتابة", async () => {
    const { status } = await patchFile(MY_PDF, { name: "notes.html" });
    expect(status).toBe(400);
    expect(row(MY_PDF).original_name).toBe("notes.pdf");
    expect(fileWrites()).toEqual([]);
  });

  it("ملف مستخدمٍ آخر ⇒ 404 ولا يتغيّر شيء", async () => {
    const { status } = await patchFile(THEIR_FILE, { name: "mine-now.pdf" });
    expect(status).toBe(404);
    expect(row(THEIR_FILE).original_name).toBe("secret.pdf");
  });

  it("اسمٌ فارغ بعد التعقيم ⇒ 400", async () => {
    expect((await patchFile(MY_PDF, { name: "   " })).status).toBe(400);
    expect((await patchFile(MY_PDF, { name: "<>.pdf" })).status).toBe(400);
  });
});

describe("الربط بمشروع", () => {
  it("يربط ملفًّا موجودًا بلا نسخة: نفس الصف، لا إدراج، لا تخزين", async () => {
    const count = db.files!.length;
    const { status } = await patchFile(MY_PDF, { projectId: MY_PROJECT });
    expect(status).toBe(200);
    expect(row(MY_PDF).project_id).toBe(MY_PROJECT);
    expect(db.files!.length).toBe(count);
    expect(ops.some((o) => o.op === "insert")).toBe(false);
    expect(storageCalls).toEqual([]);
  });

  it("مشروع مستخدمٍ آخر ⇒ 404 والملف كما هو", async () => {
    const { status } = await patchFile(MY_PDF, { projectId: THEIR_PROJECT });
    expect(status).toBe(404);
    expect(row(MY_PDF).project_id).toBeNull();
    expect(fileWrites()).toEqual([]);
  });

  it("ملف مستخدمٍ آخر إلى مشروعي ⇒ 404", async () => {
    const { status } = await patchFile(THEIR_FILE, { projectId: MY_PROJECT });
    expect(status).toBe(404);
    expect(row(THEIR_FILE).project_id).toBeNull();
  });

  it("فكّ الربط لا يحذف: الصف باقٍ، لا DELETE، لا إزالة من التخزين", async () => {
    const { status } = await patchFile(MY_FILE, { projectId: null });
    expect(status).toBe(200);
    expect(row(MY_FILE).project_id).toBeNull();
    expect(row(MY_FILE).deleted_at).toBeNull();
    expect(ops.some((o) => o.op === "delete")).toBe(false);
    expect(storageCalls).toEqual([]);
  });

  it("محادثة مستخدمٍ آخر ⇒ 404", async () => {
    const { status } = await patchFile(MY_PDF, { conversationId: THEIR_CONV });
    expect(status).toBe(404);
    expect(row(MY_PDF).conversation_id).toBeNull();
  });

  it("كل قراءة وكتابة على الملفات تحمل شرط user_id صريحًا", async () => {
    await patchFile(MY_PDF, { projectId: MY_PROJECT, name: "x.pdf" });
    const fileOps = ops.filter((o) => o.table === "files" || o.table === "projects");
    expect(fileOps.length).toBeGreaterThan(0);
    for (const o of fileOps) expect(o.filters, `${o.table}.${o.op}`).toContainEqual(["user_id", "eq", ME]);
  });
});

describe("الرابط الموقّت", () => {
  it("لصاحب الملف: رابطٌ لخمس دقائق من مسار القاعدة لا من الطلب", async () => {
    const { status, body } = await download(MY_PDF);
    expect(status).toBe(200);
    expect(String(body.url)).toContain("token=");
    expect(storageCalls).toEqual([{ op: "createSignedUrl", args: [row(MY_PDF).storage_path, 300] }]);
  });

  it("ملف مستخدمٍ آخر ⇒ 404 ولا رابط يُنشأ", async () => {
    const { status } = await download(THEIR_FILE);
    expect(status).toBe(404);
    expect(storageCalls).toEqual([]);
  });

  it("بلا جلسة ⇒ 401", async () => {
    authUser = null;
    expect((await download(MY_PDF)).status).toBe(401);
    expect(storageCalls).toEqual([]);
  });
});

describe("حذف المشروع", () => {
  it("يفكّ ربط ملفاته ولا يحذفها، ولا يمسّ ملفات المشاريع الأخرى", async () => {
    db.files!.push(file("f-in-project", ME, { project_id: MY_PROJECT }));
    const { status } = await deleteProject(MY_PROJECT);
    expect(status).toBe(200);
    expect(db.projects!.find((p) => p.id === MY_PROJECT)!.deleted_at).toBeTruthy();
    expect(row("f-in-project").project_id).toBeNull();
    expect(row("f-in-project").deleted_at).toBeNull();
    expect(row(MY_FILE).project_id).toBe(MY_OTHER_PROJECT);
    expect(ops.some((o) => o.table === "files" && o.op === "delete")).toBe(false);
    expect(storageCalls).toEqual([]);
  });

  it("مشروع مستخدمٍ آخر ⇒ 404 ولا يُفكّ شيء", async () => {
    db.files!.push(file("their-in-project", OTHER, { project_id: THEIR_PROJECT }));
    const { status } = await deleteProject(THEIR_PROJECT);
    expect(status).toBe(404);
    expect(ops.some((o) => o.table === "files" && o.op === "update")).toBe(false);
    expect(db.projects!.find((p) => p.id === THEIR_PROJECT)!.deleted_at).toBeNull();
  });
});
