import { readFileSync } from "node:fs";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgSupabase } from "./helpers/pg-supabase";
import { fake } from "./helpers/fake-embedder";

vi.mock("@/lib/rag/embeddings", async () => (await import("./helpers/fake-embedder")).embeddingsMock());

import { chunkText, contentHash } from "@/lib/rag/chunking";
import { RAG_JOB_TYPE_E5, RAG_JOB_TYPE_F2LLM } from "@/lib/rag/embedding-space";
import { F2LLM } from "@/lib/rag/f2llm-manifest";
import { claimRagJob, enqueueRagJob } from "@/lib/rag/jobs";
import { getContextFileIds, retrieveSnippets } from "@/lib/rag/retrieval";
import { drainOwnJobs, runRagJob } from "@/lib/rag/worker";

/**
 * بروفة الترحيل على PostgreSQL حقيقي (pgvector) يحمل سلسلة الترحيلات الحقيقية 0001–0047 — والكود المُختبَر هو
 * الحقيقي كلُّه: worker وjobs وretrieval ومسار /rag. الوهميّ المزوّدُ وحده (بُعده يتبع العَلَم كالحقيقي).
 *
 *   scripts/f2llm/rehearsal/apply-chain.sh 47
 *   YSD_PG_URL=postgres://postgres:rehearsal@127.0.0.1:54329/ysd npx vitest run tests/v139-f2llm-pg-rehearsal.test.ts
 *
 * بلا YSD_PG_URL يُتخطّى (لا تشغيل على قاعدة أحد). الاختبارات متسلسلة عمدًا: كل مرحلةٍ تبني على حالة القاعدة بعدها.
 * كل استعلام من التطبيق يجري بدور `authenticated` تحت RLS (انظر helpers/pg-supabase.ts).
 */
const PG_URL = process.env.YSD_PG_URL;
const rehearsal = PG_URL ? describe : describe.skip;

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAG = F2LLM.tag;
const FLAG = "YSD_RAG_EMBEDDING_MODEL";
const UP = readFileSync("supabase/migrations/0048_f2llm_embedding_v2.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0048_f2llm_embedding_v2.down.sql", "utf8");

type Row = Record<string, unknown>;
let admin: pg.Client;
let pool: pg.Pool;
let sbA: SupabaseClient;
let sbB: SupabaseClient;

const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await admin.query(sql, params)).rows as Row[];
const scalar = async (sql: string, params: unknown[] = []): Promise<unknown> => {
  const r = await q(sql, params);
  return r[0] ? Object.values(r[0])[0] : null;
};

/** n فقرات بكلماتٍ فريدة — عدد المقاطع يقرّره المقطِّع */
const doc = (n: number, salt: string): string => Array.from({ length: n }, (_, p) => Array.from({ length: 150 }, (_, i) => `${salt}w${p}x${i}`).join(" ")).join("\n\n");
const nChunks = (t: string) => chunkText(t).length;

const flagOn = () => vi.stubEnv(FLAG, "f2llm-v2-80m");
const flagOff = () => vi.stubEnv(FLAG, "");

async function v2Objects(): Promise<{ columns: number; fn: number; index: number }> {
  return {
    columns: Number(await scalar("select count(*) from information_schema.columns where table_schema='public' and ((table_name='file_chunks' and column_name in ('embedding_v2','embedding_v2_model')) or (table_name='files' and column_name='rag_v2_model'))")),
    fn: Number(await scalar("select count(*) from pg_proc where proname='match_file_chunks_v2'")),
    index: Number(await scalar("select count(*) from pg_indexes where indexname='idx_chunks_embedding_v2'")),
  };
}

async function addFile(owner: string, name: string, text: string, conv: string | null = CONV): Promise<string> {
  const r = await q(
    "insert into files (user_id, file_name, original_name, mime_type, size_bytes, storage_path, status, extracted_text, conversation_id) values ($1,$2,$2,'text/plain',$3,$4,'ready',$5,$6) returning id",
    [owner, name, text.length, `${owner}/${name}`, text, conv],
  );
  return r[0]!.id as string;
}

async function enqueueAndDrain(sb: SupabaseClient, userId: string, fileId: string, text: string, jobType?: string, worker = "w:rehearsal") {
  const enq = await enqueueRagJob(sb, { userId, fileId, contentHash: contentHash(text), ...(jobType ? { jobType } : {}), ...(jobType === RAG_JOB_TYPE_F2LLM ? { keySuffix: TAG } : {}) });
  if ("error" in enq) throw new Error(`enqueue failed: ${enq.error}`);
  await drainOwnJobs(sb, { workerId: worker });
  return enq;
}
/** مسار POST /api/files/:id/rag الحقيقي فوق عميل القاعدة الحقيقيّة (التوثيق وحدّ المعدّل فقط مُبدَّلان) */
async function callRoute(sb: SupabaseClient, userId: string, fileId: string) {
  vi.resetModules();
  const client = Object.assign({}, sb as object, { auth: { getUser: async () => ({ data: { user: { id: userId } } }) } });
  vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => client }));
  vi.doMock("@/lib/rate-limit-distributed", () => ({ BUCKET_RAG_RUN: "rag_run", consumeRateLimit: async () => ({ allowed: true }) }));
  const { POST } = await import("@/app/api/files/[id]/rag/route");
  const res = await POST(new Request("http://x/api/files/f/rag", { method: "POST" }) as never, { params: Promise.resolve({ id: fileId }) });
  const body = (await res.json()) as { skipped?: boolean; job?: { job_type: string } };
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/rate-limit-distributed");
  return { status: res.status, body };
}
const jobsOf = (fileId: string) => q("select * from rag_jobs where file_id = $1 order by created_at", [fileId]);
/** يجعل وظيفةً مؤجَّلة (retrying) متاحةً الآن — بدل انتظار التراجع */
const makeDue = (fileId: string) => q("update rag_jobs set available_at = now() - interval '1 second' where file_id = $1 and status in ('retrying','queued')", [fileId]);

async function snapshotV1() {
  return {
    chunks: await scalar("select md5(coalesce(string_agg(id::text || '|' || embedding::text || '|' || content, ',' order by id), '')) from file_chunks where embedding is not null"),
    n: Number(await scalar("select count(*) from file_chunks where embedding is not null")),
    idx: await scalar("select indexdef from pg_indexes where indexname = 'idx_chunks_embedding'"),
    fn: await scalar("select md5(pg_get_functiondef('match_file_chunks(vector,uuid[],int,float)'::regprocedure))"),
    col: await scalar("select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'file_chunks'::regclass and attname = 'embedding'"),
    acl: await scalar("select md5(coalesce(proacl::text, 'null')) from pg_proc where oid = 'match_file_chunks(vector,uuid[],int,float)'::regprocedure"),
  };
}

const chunkVec = async (col: "embedding" | "embedding_v2", where: string, params: unknown[]): Promise<number[][]> =>
  (await q(`select ${col}::text as v from file_chunks where ${where} order by chunk_index`, params)).map((r) => JSON.parse(r.v as string) as number[]);

/** نتائج استرجاعٍ قابلة للمقارنة: المعرّف والتشابه بست خانات */
const shape = (o: { snippets: Array<{ chunkId: string; similarity: number }> }) => o.snippets.map((s) => `${s.chunkId}:${s.similarity.toFixed(6)}`);

/** لا فضاءان مخلوطان في أي صف — يُفحص في نهاية كل مرحلة */
async function assertNoSpaceMixing(allowStaleTag = false) {
  expect(Number(await scalar("select count(*) from file_chunks where embedding is not null and vector_dims(embedding) <> 384"))).toBe(0);
  if ((await v2Objects()).columns === 0) return;
  expect(Number(await scalar("select count(*) from file_chunks where embedding_v2 is not null and vector_dims(embedding_v2) <> 320"))).toBe(0);
  expect(Number(await scalar("select count(*) from file_chunks where (embedding_v2 is null) <> (embedding_v2_model is null)"))).toBe(0);
  if (!allowStaleTag) expect(Number(await scalar("select count(*) from file_chunks where embedding_v2_model is not null and embedding_v2_model <> $1", [TAG]))).toBe(0);
  // ملفٌّ موسومٌ مكتملًا في v2 ⇒ كل مقاطعه بمتجه v2 وبالوسم نفسه
  expect(
    Number(await scalar("select count(*) from files f where f.rag_v2_model is not null and exists (select 1 from file_chunks c where c.file_id = f.id and (c.embedding_v2 is null or c.embedding_v2_model is distinct from f.rag_v2_model))")),
  ).toBe(0);
}

// ---- ما يُشترك بين المراحل ----
let S0: Awaited<ReturnType<typeof snapshotV1>>;
const baseline: Record<string, string[]> = {};
const files: Record<string, { id: string; text: string }> = {};
const V1_QUERY = (k: string) => chunkText(files[k]!.text)[1]!.content;

beforeAll(async () => {
  if (!PG_URL) return;
  admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  pool = new pg.Pool({ connectionString: PG_URL, max: 8 });
  sbA = createPgSupabase(pool, A) as unknown as SupabaseClient;
  sbB = createPgSupabase(pool, B) as unknown as SupabaseClient;

  // نقطة بدء نظيفة: حالة ما قبل الترحيل (0047) بلا بيانات — التراجع يعيدها بالضبط (يُثبَت أدناه أيضًا)
  if ((await v2Objects()).columns > 0) await admin.query(DOWN);
  await admin.query("set session_replication_role = replica"); // مُشغِّل التسجيل (دعوة الإصدار التجريبي) لا يهمّ هنا
  for (const [id, email] of [[A, "a@rehearsal.test"], [B, "b@rehearsal.test"]] as const) {
    await admin.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [id, email]);
    await admin.query("insert into profiles (id) values ($1) on conflict do nothing", [id]);
  }
  await admin.query("set session_replication_role = origin");
  await admin.query("delete from rag_jobs");
  await admin.query("delete from file_chunks");
  await admin.query("delete from files");
  await admin.query("delete from conversations");
  await admin.query("insert into conversations (id, user_id) values ($1, $2)", [CONV, A]);

  // سجلّ تدقيق لكل تغيّرٍ في status الملفات — يُثبت أن الإضافة لا تقلب حالة ملفٍّ جاهز ولو لحظة
  await admin.query("drop table if exists rehearsal_status_log");
  await admin.query("create table rehearsal_status_log (id bigserial primary key, file_id uuid, old_status text, new_status text, at timestamptz default clock_timestamp())");
  await admin.query(`create or replace function rehearsal_log_status() returns trigger language plpgsql as $$
    begin
      if old.status::text is distinct from new.status::text then
        insert into rehearsal_status_log (file_id, old_status, new_status) values (new.id, old.status::text, new.status::text);
      end if;
      return new;
    end $$`);
  await admin.query("drop trigger if exists rehearsal_status_trg on files");
  await admin.query("create trigger rehearsal_status_trg after update of status on files for each row execute function rehearsal_log_status()");
});

afterAll(async () => {
  if (!PG_URL) return;
  await admin.query("drop trigger if exists rehearsal_status_trg on files").catch(() => undefined);
  await admin.query("drop function if exists rehearsal_log_status()").catch(() => undefined);
  await admin.query("drop table if exists rehearsal_status_log").catch(() => undefined);
  await pool.end();
  await admin.end();
});

beforeEach(() => {
  fake.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

rehearsal("★ المرحلة أ — قبل الترحيل (0047)، العَلَم مطفأ", () => {
  it("★ ★ ★ لا كائنات v2 في القاعدة", async () => {
    expect(await v2Objects()).toEqual({ columns: 0, fn: 0, index: 0 });
  });

  it("★ ★ ★ التجهيز الحقيقي: 3 ملفات لـA وواحد لـB تكتمل بمتجهات e5 (384) عبر RLS وclaim_rag_job الحقيقيَّين", async () => {
    flagOff();
    for (const [k, owner, sb] of [["A1", A, sbA], ["A2", A, sbA], ["A3", A, sbA], ["B1", B, sbB]] as const) {
      const text = doc(3, k.toLowerCase());
      files[k] = { id: await addFile(owner, `${k}.txt`, text, owner === A ? CONV : null), text };
      const enq = await enqueueAndDrain(sb, owner, files[k]!.id, text);
      expect(enq.job.job_type).toBe(RAG_JOB_TYPE_E5);
    }
    for (const k of ["A1", "A2", "A3", "B1"]) {
      const f = (await q("select status::text as status, rag_total_chunks from files where id = $1", [files[k]!.id]))[0]!;
      expect(f.status).toBe("ready_for_rag");
      expect(Number(f.rag_total_chunks)).toBe(nChunks(files[k]!.text));
      expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding is not null and vector_dims(embedding) = 384", [files[k]!.id]))).toBe(nChunks(files[k]!.text));
      expect((await jobsOf(files[k]!.id))[0]!.status).toBe("completed");
    }
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ استرجاع e5 (384) يعمل ويُنتج خط الأساس المرجعيّ الذي تُقارَن به كل مرحلةٍ لاحقة", async () => {
    flagOff();
    for (const k of ["A1", "A2", "A3"]) {
      const out = await retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]);
      expect(out.searched).toBe(true);
      expect(out.snippets[0]!.fileId).toBe(files[k]!.id);
      expect(out.snippets[0]!.content).toBe(V1_QUERY(k));
      expect(out.snippets[0]!.similarity).toBeGreaterThan(0.99);
      expect(fake.queries.at(-1)!.dims).toBe(384);
      baseline[k] = shape(out);
    }
    expect((await getContextFileIds(sbA, A, CONV, null)).sort()).toEqual(["A1", "A2", "A3"].map((k) => files[k]!.id).sort());
  });

  it("★ ★ ★ لقطة v1 (S0): متجهات ومحتوى وفهرس ودالة وصلاحيات — مرجع «لم يُمسّ»", async () => {
    S0 = await snapshotV1();
    expect(S0.col).toBe("vector(384)");
    expect(S0.n).toBe(["A1", "A2", "A3", "B1"].reduce((s, k) => s + nChunks(files[k]!.text), 0));
    expect(String(S0.idx)).toContain("hnsw");
  });
});

rehearsal("★ المرحلة ب — تطبيق 0048", () => {
  it("★ ★ ★ الترحيل يُطبَّق، ومتجهات v1 وفهرسها ودالتها وصلاحياتها بايت-ببايت كما كانت", async () => {
    await admin.query(UP);
    expect(await v2Objects()).toEqual({ columns: 3, fn: 1, index: 1 });
    const now = await snapshotV1();
    expect(now).toEqual(S0);
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ العَلَم مطفأ بعد الترحيل: نتائج الاسترجاع مطابقة لخط الأساس تمامًا (المعرّفات والتشابه)", async () => {
    flagOff();
    for (const k of ["A1", "A2", "A3"]) expect(shape(await retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]))).toEqual(baseline[k]);
  });

  it("★ ★ ★ إعادة تطبيق 0048 (idempotent) لا تغيّر شيئًا", async () => {
    await admin.query(UP);
    expect(await snapshotV1()).toEqual(S0);
    expect(await v2Objects()).toEqual({ columns: 3, fn: 1, index: 1 });
  });
});

rehearsal("★ المرحلة ج — العَلَم مشتعل: ملفاتٌ مختارة تنال متجهات v2", () => {
  it("★ ★ ★ إضافة v2 لـA1 وA2 (وظيفة backfill): 320 بُعدًا منتهية مُطبَّعة بوسم النموذج، ولا تُقلَب حالةُ الملف لحظةً واحدة", async () => {
    flagOn();
    const logBefore = Number(await scalar("select count(*) from rehearsal_status_log"));
    for (const k of ["A1", "A2"]) {
      const enq = await enqueueAndDrain(sbA, A, files[k]!.id, files[k]!.text, RAG_JOB_TYPE_F2LLM);
      expect(enq.job.job_type).toBe(RAG_JOB_TYPE_F2LLM);
      expect((await jobsOf(files[k]!.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!.status).toBe("completed");
      const vecs = await chunkVec("embedding_v2", "file_id = $1", [files[k]!.id]);
      expect(vecs).toHaveLength(nChunks(files[k]!.text));
      for (const v of vecs) {
        expect(v).toHaveLength(320);
        expect(v.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...v)).toBeCloseTo(1, 5);
      }
      expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding_v2_model = $2", [files[k]!.id, TAG]))).toBe(vecs.length);
      const f = (await q("select status::text as status, rag_v2_model, rag_error from files where id = $1", [files[k]!.id]))[0]!;
      expect(f).toMatchObject({ status: "ready_for_rag", rag_v2_model: TAG, rag_error: null });
    }
    // ★ لا سجلّ تحوّلٍ في status أثناء الإضافة كلّها — لا chunking ولا embedding ولا أي انقلاب
    expect(Number(await scalar("select count(*) from rehearsal_status_log"))).toBe(logBefore);
    // غير المختارة لم تُمسّ
    for (const k of ["A3", "B1"]) {
      expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and (embedding_v2 is not null or embedding_v2_model is not null)", [files[k]!.id]))).toBe(0);
      expect(await scalar("select rag_v2_model from files where id = $1", [files[k]!.id])).toBeNull();
    }
    expect(await snapshotV1()).toEqual(S0); // v1 لم يتغيّر بايتًا
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ الاستعلام يمرّ بفضاء F2LLM (320) والمقاطع كذلك: يجد المقطع نفسه بتشابه ≈ 1 ولا يخلط", async () => {
    flagOn();
    for (const k of ["A1", "A2"]) {
      const out = await retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]);
      expect(fake.queries.at(-1)!.dims).toBe(320);
      expect(out.snippets[0]).toMatchObject({ fileId: files[k]!.id, content: V1_QUERY(k) });
      expect(out.snippets[0]!.similarity).toBeGreaterThan(0.99);
    }
  });

  it("★ ★ ★ ملفٌّ جاهزٌ في e5 فقط (A3) لا يظهر في سياق v2 ولا يجيب بحثَ v2 — لا رجوع صامت إلى متجهات 384", async () => {
    flagOn();
    expect((await getContextFileIds(sbA, A, CONV, null)).sort()).toEqual([files.A1!.id, files.A2!.id].sort());
    const out = await retrieveSnippets(sbA, V1_QUERY("A3"), [files.A3!.id]);
    expect(out.snippets).toEqual([]);
    // وحتى إن سُئل عن الثلاثة معًا: لا مقطع من A3 أبدًا
    const all = await retrieveSnippets(sbA, V1_QUERY("A1"), [files.A1!.id, files.A2!.id, files.A3!.id]);
    expect(all.snippets.every((s) => s.fileId !== files.A3!.id)).toBe(true);
  });

  it("★ ★ ★ الملكية: مستخدمٌ آخر (B) لا يرى مقاطع A في v2 مطلقًا", async () => {
    flagOn();
    const out = await retrieveSnippets(sbB, V1_QUERY("A1"), [files.A1!.id, files.A2!.id]);
    expect(out.snippets).toEqual([]);
  });

  it("★ ★ ★ حواجز القاعدة نفسها (بدور authenticated): بُعدٌ خاطئ، وسمٌ ناقص، ونموذجٌ آخر — كلٌّ يُرفض أو لا يُعيد شيئًا", async () => {
    const c = await pool.connect();
    const as = async <T>(fn: () => Promise<T>) => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [A]);
      try {
        return await fn();
      } finally {
        await c.query("rollback");
      }
    };
    const lit = (n: number) => "[" + Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0)).join(",") + "]";
    const err = async (sql: string, params: unknown[]) => (await c.query(sql, params).then(() => null, (e: { code?: string }) => e.code ?? "?"));
    try {
      const target = (await chunkVec("embedding_v2", "file_id = $1", [files.A1!.id])).length && (await q("select id from file_chunks where file_id = $1 order by chunk_index limit 1", [files.A1!.id]))[0]!.id;
      // 384 بُعدًا في عمود v2
      expect(await as(() => err("update file_chunks set embedding_v2 = $1::vector where id = $2", [lit(384), target]))).toBe("22000");
      // 320 بُعدًا في عمود e5
      expect(await as(() => err("update file_chunks set embedding = $1::vector where id = $2", [lit(320), target]))).toBe("22000");
      // متجهٌ بلا وسم / وسمٌ بلا متجه
      expect(await as(() => err("update file_chunks set embedding_v2_model = null where id = $1", [target]))).toBe("23514");
      const bare = (await q("select id from file_chunks where file_id = $1 limit 1", [files.A3!.id]))[0]!.id;
      expect(await as(() => err("update file_chunks set embedding_v2_model = 'x' where id = $1", [bare]))).toBe("23514");
      // استعلامٌ بـ384 بُعدًا إلى دالة v2
      expect(await as(() => err("select * from match_file_chunks_v2($1::vector, $2::uuid[], $3, 8, 0.0)", [lit(384), [files.A1!.id], TAG]))).toBe("22023");
      // وسمُ نموذجٍ آخر ⇒ لا صفوف
      const rows = await as(async () => (await c.query("select * from match_file_chunks_v2($1::vector, $2::uuid[], $3, 8, 0.0)", [lit(320), [files.A1!.id], "f2llm-v2-80m@other.onnx-000000000000"])).rows);
      expect(rows).toHaveLength(0);
      // دالة v2 بلا هويّة مستخدم ⇒ لا صفوف
      await c.query("begin");
      await c.query("set local role authenticated");
      const anon = (await c.query("select * from match_file_chunks_v2($1::vector, $2::uuid[], $3, 8, 0.0)", [lit(320), [files.A1!.id], TAG])).rows;
      await c.query("rollback");
      expect(anon).toHaveLength(0);
      // anon لا يملك EXECUTE أصلًا
      await c.query("begin");
      await c.query("set local role anon");
      expect(await err("select * from match_file_chunks_v2($1::vector, $2::uuid[], $3, 8, 0.0)", [lit(320), [files.A1!.id], TAG])).toBe("42501");
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});

rehearsal("★ المرحلة د — التراجع", () => {
  it("★ ★ ★ (١) تراجعٌ ناعم: إطفاء العَلَم يعيد بحث 384 بنتائج خط الأساس نفسها، وتبقى متجهات v2 خاملةً بلا أذى", async () => {
    flagOff();
    for (const k of ["A1", "A2", "A3"]) {
      expect(shape(await retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]))).toEqual(baseline[k]);
      expect(fake.queries.at(-1)!.dims).toBe(384);
    }
    expect((await getContextFileIds(sbA, A, CONV, null)).sort()).toEqual(["A1", "A2", "A3"].map((k) => files[k]!.id).sort());
    expect(Number(await scalar("select count(*) from file_chunks where embedding_v2 is not null"))).toBeGreaterThan(0);
    expect(await snapshotV1()).toEqual(S0);
  });

  it("★ ★ ★ (٢) العَلَم مطفأ والأعمدة موجودة: ملفٌّ جديد يُجهَّز في e5 كالمعتاد ولا يكتب v2", async () => {
    flagOff();
    const text = doc(2, "n1");
    files.N1 = { id: await addFile(A, "N1.txt", text), text };
    await enqueueAndDrain(sbA, A, files.N1.id, text);
    expect(await scalar("select status::text from files where id = $1", [files.N1.id])).toBe("ready_for_rag");
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding is not null and embedding_v2 is null and embedding_v2_model is null", [files.N1.id]))).toBe(nChunks(text));
    expect(await scalar("select rag_v2_model from files where id = $1", [files.N1.id])).toBeNull();
  });

  it("★ ★ ★ (٢ب) ملفٌّ جُهِّز في F2LLM وحده ثم تراجعٌ ناعم: e5 لا يجده؛ POST /rag لا يتخطّاه فيُعاد تضمينه بـe5 وتعود الإجابة — وv2 يبقى خاملًا", async () => {
    flagOn();
    const text = doc(3, "n3");
    files.N3 = { id: await addFile(A, "N3.txt", text), text };
    await enqueueAndDrain(sbA, A, files.N3.id, text, RAG_JOB_TYPE_F2LLM);
    const n = nChunks(text);
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding is null and embedding_v2 is not null", [files.N3.id]))).toBe(n);
    flagOff();
    const q3 = chunkText(text)[1]!.content;
    expect((await retrieveSnippets(sbA, q3, [files.N3.id])).snippets).toEqual([]); // e5: لا متجهات بعدُ لهذا الملف
    const v2md5 = () => scalar("select md5(string_agg(id::text || '|' || embedding_v2::text || '|' || embedding_v2_model, ',' order by id)) from file_chunks where file_id = $1", [files.N3!.id]);
    const v2Before = await v2md5();
    const first = await callRoute(sbA, A, files.N3.id);
    expect(first.body.skipped).toBe(false);
    expect(first.body.job!.job_type).toBe(RAG_JOB_TYPE_E5);
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding is not null and vector_dims(embedding) = 384", [files.N3.id]))).toBe(n);
    expect((await retrieveSnippets(sbA, q3, [files.N3.id])).snippets[0]!.similarity).toBeGreaterThan(0.99);
    expect(await v2md5()).toBe(v2Before);
    expect((await callRoute(sbA, A, files.N3.id)).body.skipped).toBe(true);
  });

  it("★ ★ ★ (٣) تراجعٌ كامل: 0048.down يزيل كائنات v2 (ووظائفها) وحدها، ويعود v1 إلى ما كان عليه بالضبط", async () => {
    // نُزيل ما أُضيف بعد اللقطة الأولى كي تعود إلى S0 حرفيًّا
    for (const k of ["N1", "N3"]) {
      await admin.query("delete from file_chunks where file_id = $1", [files[k]!.id]);
      await admin.query("delete from rag_jobs where file_id = $1", [files[k]!.id]);
      await admin.query("delete from files where id = $1", [files[k]!.id]);
      delete files[k];
    }
    await admin.query(DOWN);
    expect(await v2Objects()).toEqual({ columns: 0, fn: 0, index: 0 });
    expect(await snapshotV1()).toEqual(S0);
    expect(Number(await scalar("select count(*) from rag_jobs where job_type = $1", [RAG_JOB_TYPE_F2LLM]))).toBe(0); // وظائف v2 زالت معها
    expect(Number(await scalar("select count(*) from rag_jobs where job_type = $1 and status = 'completed'", [RAG_JOB_TYPE_E5]))).toBeGreaterThanOrEqual(4); // ووظائف e5 لم تُمسّ
    flagOff();
    for (const k of ["A1", "A2", "A3"]) expect(shape(await retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]))).toEqual(baseline[k]);
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ (٤) بعد التراجع الكامل: التجهيز بـe5 يعمل على المخطّط القديم (الكود لا يشير إلى v2 أصلًا)", async () => {
    flagOff();
    const text = doc(2, "n2");
    files.N2 = { id: await addFile(A, "N2.txt", text), text };
    await enqueueAndDrain(sbA, A, files.N2.id, text);
    expect(await scalar("select status::text from files where id = $1", [files.N2.id])).toBe("ready_for_rag");
    expect((await jobsOf(files.N2.id))[0]!.status).toBe("completed");
  });

  it("★ ★ ★ (٥) عَلَمٌ مشتعل على قاعدةٍ تراجعت (خللُ إعداد): وظيفة v2 لا تُفسد شيئًا — الملف يبقى جاهزًا وv1 كما هو والبحث لا ينهار", async () => {
    flagOn();
    const before = await snapshotV1();
    await enqueueAndDrain(sbA, A, files.A1!.id, files.A1!.text, RAG_JOB_TYPE_F2LLM);
    const job = (await jobsOf(files.A1!.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!;
    expect(job.status).not.toBe("completed");
    expect(await scalar("select status::text from files where id = $1", [files.A1!.id])).toBe("ready_for_rag");
    expect(await scalar("select rag_error from files where id = $1", [files.A1!.id])).toBeNull();
    expect(await snapshotV1()).toEqual(before);
    expect(await getContextFileIds(sbA, A, CONV, null)).toEqual([]); // v2 غير مطبَّقة ⇒ لا سياق، لا استثناء
    const out = await retrieveSnippets(sbA, V1_QUERY("A1"), [files.A1!.id]);
    expect(out.snippets).toEqual([]);
    // تنظيف: نُلغي الوظيفة العالقة كي لا تتداخل مع المرحلة التالية
    await admin.query("delete from rag_jobs where file_id = $1 and job_type = $2", [files.A1!.id, RAG_JOB_TYPE_F2LLM]);
  });

  it("★ ★ ★ (٦) دورة تراجعٍ ثم إعادة تطبيق: UP يعمل من جديد، وتُبنى v2 من الصفر دون المساس بـv1", async () => {
    await admin.query(UP);
    expect(await v2Objects()).toEqual({ columns: 3, fn: 1, index: 1 });
    flagOn();
    await enqueueAndDrain(sbA, A, files.A1!.id, files.A1!.text, RAG_JOB_TYPE_F2LLM);
    expect(await scalar("select rag_v2_model from files where id = $1", [files.A1!.id])).toBe(TAG);
    const out = await retrieveSnippets(sbA, V1_QUERY("A1"), [files.A1!.id]);
    expect(out.snippets[0]!.similarity).toBeGreaterThan(0.99);
    await assertNoSpaceMixing();
    // N2 أُضيف بعد اللقطة الأولى — نتحقّق أن متجهات A1..A3 وB1 القديمة نفسها لم تتغيّر
    expect(await scalar("select md5(string_agg(id::text || '|' || embedding::text || '|' || content, ',' order by id)) from file_chunks where embedding is not null and file_id <> $1", [files.N2!.id])).toBe(S0.chunks);
  });
});

rehearsal("★ المرحلة هـ — انقطاع، استئناف، إعادة تشغيل، وظيفة عالقة", () => {
  it("★ ★ ★ انقطاعٌ في منتصف إضافة v2: متجهاتٌ جزئية لا تُرى، e5 يبقى يعمل، والاستئناف يُكمل المتبقّي وحده", async () => {
    flagOff();
    const text = doc(12, "big");
    files.BIG = { id: await addFile(A, "BIG.txt", text), text };
    await enqueueAndDrain(sbA, A, files.BIG.id, text); // e5
    const total = nChunks(text);
    expect(total).toBeGreaterThan(8);
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding is not null", [files.BIG.id]))).toBe(total);

    flagOn();
    fake.reset();
    fake.failOnBatch = 2; // الدفعة الأولى (8) تُحفظ ثم تنهار الثانية
    await enqueueAndDrain(sbA, A, files.BIG.id, text, RAG_JOB_TYPE_F2LLM);
    const job = (await jobsOf(files.BIG.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!;
    expect(job.status).toBe("retrying");
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding_v2 is not null", [files.BIG.id]))).toBe(8);
    expect(await scalar("select rag_v2_model from files where id = $1", [files.BIG.id])).toBeNull();
    expect(await scalar("select status::text from files where id = $1", [files.BIG.id])).toBe("ready_for_rag");
    expect(await scalar("select rag_error from files where id = $1", [files.BIG.id])).toBeNull();
    // غير مرئيّ في v2، ومرئيّ في e5
    expect(await getContextFileIds(sbA, A, CONV, null)).not.toContain(files.BIG.id);
    expect((await retrieveSnippets(sbA, chunkText(text)[15]!.content, [files.BIG.id])).snippets).toEqual([]);
    flagOff();
    expect((await retrieveSnippets(sbA, chunkText(text)[15]!.content, [files.BIG.id])).snippets[0]!.similarity).toBeGreaterThan(0.99);

    // استئناف
    flagOn();
    fake.reset();
    await makeDue(files.BIG.id);
    await drainOwnJobs(sbA, { workerId: "w:resume" });
    expect((await jobsOf(files.BIG.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!.status).toBe("completed");
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding_v2_model = $2", [files.BIG.id, TAG]))).toBe(total);
    expect(await scalar("select rag_v2_model from files where id = $1", [files.BIG.id])).toBe(TAG);
    // ضُمِّن المتبقّي فقط — لا الثمانية الأولى مرّةً ثانية
    expect(fake.embedded).toHaveLength(total - 8);
    expect(new Set(fake.embedded).size).toBe(total - 8);
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ إعادة تشغيل الإضافة idempotent: لا وظيفة جديدة، ولا تضمين، ولا تغيّر في أي متجه (v1 ولا v2)", async () => {
    flagOn();
    fake.reset();
    const before = {
      v2: await scalar("select md5(string_agg(id::text || '|' || embedding_v2::text || '|' || embedding_v2_model, ',' order by id)) from file_chunks where file_id = $1", [files.BIG!.id]),
      v1: await scalar("select md5(string_agg(id::text || '|' || embedding::text, ',' order by id)) from file_chunks where file_id = $1", [files.BIG!.id]),
    };
    const again = await enqueueRagJob(sbA, { userId: A, fileId: files.BIG!.id, contentHash: contentHash(files.BIG!.text), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
    expect(again).toMatchObject({ created: false });
    expect(await drainOwnJobs(sbA, { workerId: "w:again" })).toMatchObject({ processed: 0 });
    // وتشغيلٌ إجباريٌّ لوظيفةٍ صريحة على ملفٍّ مكتمل: لا مقاطع معلّقة ⇒ لا تضمين
    await admin.query("update rag_jobs set status = 'running', locked_by = 'w:forced', heartbeat_at = now() where file_id = $1 and job_type = $2", [files.BIG!.id, RAG_JOB_TYPE_F2LLM]);
    const forced = (await jobsOf(files.BIG!.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!;
    await runRagJob(sbA, forced as never, "w:forced");
    expect(fake.batches).toEqual([]);
    expect({
      v2: await scalar("select md5(string_agg(id::text || '|' || embedding_v2::text || '|' || embedding_v2_model, ',' order by id)) from file_chunks where file_id = $1", [files.BIG!.id]),
      v1: await scalar("select md5(string_agg(id::text || '|' || embedding::text, ',' order by id)) from file_chunks where file_id = $1", [files.BIG!.id]),
    }).toEqual(before);
    expect(await scalar("select status::text from files where id = $1", [files.BIG!.id])).toBe("ready_for_rag");
  });

  it("★ ★ ★ وظيفةٌ عالقة (العامل مات وانتهى قفلُه): تُستردّ بـclaim_rag_job الحقيقية وتُكمل من حيث توقّفت، لا من الصفر", async () => {
    flagOff();
    const text = doc(6, "stall");
    files.STALL = { id: await addFile(A, "STALL.txt", text), text };
    await enqueueAndDrain(sbA, A, files.STALL.id, text); // e5
    const total = nChunks(text);
    expect(total).toBeGreaterThan(4);

    // نُنشئ وظيفة v2 ونجعلها «تعمل» بعامل ميّت: نبضتُه قبل عشر دقائق، وقد حفظ 4 مقاطع فقط
    flagOn();
    const enq = await enqueueRagJob(sbA, { userId: A, fileId: files.STALL.id, contentHash: contentHash(text), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
    if ("error" in enq) throw new Error(enq.error);
    await admin.query("update rag_jobs set status = 'running', locked_by = 'w:dead', locked_at = now() - interval '10 minutes', heartbeat_at = now() - interval '10 minutes', attempts = 1 where id = $1", [enq.job.id]);
    const firstFour = (await q("select id, content from file_chunks where file_id = $1 order by chunk_index limit 4", [files.STALL.id])) as Array<{ id: string; content: string }>;
    for (const c of firstFour) {
      const v = Array.from({ length: 320 }, (_, i) => (i === firstFour.indexOf(c) ? 1 : 0));
      await admin.query("update file_chunks set embedding_v2 = $1::vector, embedding_v2_model = $2 where id = $3", ["[" + v.join(",") + "]", TAG, c.id]);
    }
    fake.reset();
    await drainOwnJobs(sbA, { workerId: "w:recover" });
    const job = (await jobsOf(files.STALL.id)).find((j) => j.job_type === RAG_JOB_TYPE_F2LLM)!;
    expect(job.status).toBe("completed");
    expect(Number(job.attempts)).toBe(2); // الأولى الميّتة والثانية المستردّة
    expect(job.locked_by).not.toBe("w:dead");
    expect(Number(await scalar("select count(*) from file_chunks where file_id = $1 and embedding_v2_model = $2", [files.STALL.id, TAG]))).toBe(total);
    expect(fake.embedded).toHaveLength(total - 4); // الأربعة المحفوظة لم تُضمَّن ثانيةً
    expect(new Set(fake.embedded).size).toBe(total - 4);
    expect(await scalar("select rag_v2_model from files where id = $1", [files.STALL.id])).toBe(TAG);
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ متجهٌ بوسم نموذجٍ آخر يُعاد تضمينه وحده — والبقية لا تُمسّ", async () => {
    flagOn();
    const [victim] = (await q("select id, content from file_chunks where file_id = $1 order by chunk_index limit 1", [files.STALL!.id])) as Array<{ id: string; content: string }>;
    const keepBefore = await scalar("select md5(string_agg(id::text || '|' || embedding_v2::text, ',' order by id)) from file_chunks where file_id = $1 and id <> $2", [files.STALL!.id, victim!.id]);
    await admin.query("update file_chunks set embedding_v2_model = 'f2llm-v2-80m@old.onnx-000000000000' where id = $1", [victim!.id]);
    await admin.query("update files set rag_v2_model = null where id = $1", [files.STALL!.id]);
    await admin.query("delete from rag_jobs where file_id = $1 and job_type = $2", [files.STALL!.id, RAG_JOB_TYPE_F2LLM]);
    fake.reset();
    await enqueueAndDrain(sbA, A, files.STALL!.id, files.STALL!.text, RAG_JOB_TYPE_F2LLM);
    expect(fake.embedded).toEqual([victim!.content]);
    expect(await scalar("select embedding_v2_model from file_chunks where id = $1", [victim!.id])).toBe(TAG);
    expect(await scalar("select md5(string_agg(id::text || '|' || embedding_v2::text, ',' order by id)) from file_chunks where file_id = $1 and id <> $2", [files.STALL!.id, victim!.id])).toBe(keepBefore);
    expect(await scalar("select rag_v2_model from files where id = $1", [files.STALL!.id])).toBe(TAG);
    await assertNoSpaceMixing();
  });
});

rehearsal("★ المرحلة و — تزامن على PostgreSQL الحقيقي", () => {
  it("★ ★ ★ ثلاث وظائف v2 وثلاثة التقاطاتٍ متزامنة: كل وظيفةٍ لعاملٍ واحد بالضبط (FOR UPDATE SKIP LOCKED)", async () => {
    flagOff();
    const ids: string[] = [];
    for (const n of ["c1", "c2", "c3"]) {
      const text = doc(2, n);
      files[n.toUpperCase()] = { id: await addFile(A, `${n}.txt`, text), text };
      await enqueueAndDrain(sbA, A, files[n.toUpperCase()]!.id, text); // e5
    }
    flagOn();
    for (const n of ["C1", "C2", "C3"]) {
      const enq = await enqueueRagJob(sbA, { userId: A, fileId: files[n]!.id, contentHash: contentHash(files[n]!.text), jobType: RAG_JOB_TYPE_F2LLM, keySuffix: TAG });
      if ("error" in enq) throw new Error(enq.error);
      ids.push(enq.job.id);
    }
    const claims = await Promise.all([claimRagJob(sbA, "w1"), claimRagJob(sbA, "w2"), claimRagJob(sbA, "w3"), claimRagJob(sbA, "w4")]);
    const got = claims.filter(Boolean).map((j) => j!.id);
    expect(got).toHaveLength(3); // الرابع لا يجد شيئًا
    expect(new Set(got).size).toBe(3); // لا وظيفة لعاملين
    expect(new Set(got)).toEqual(new Set(ids));
    // نُعيد الوظائف إلى الطابور ونُنهيها بالمسار العاديّ
    await admin.query("update rag_jobs set status = 'queued', locked_by = null, locked_at = null, heartbeat_at = null, attempts = 0 where id = any($1)", [ids]);
  });

  it("★ ★ ★ تصريفان متزامنان + استرجاعاتٌ متزامنة: يُعالَج كل ملفٍّ مرّةً واحدة، والاسترجاع لا يتعثّر ولا يخلط فضاءين", async () => {
    flagOn();
    fake.reset();
    // ملفاتٌ جاهزة في v2 بمتجهاتٍ حقيقية: A1 (أُعيد تجهيزه بعد دورة التراجع) وBIG. (A2 لم يُعَد؛ وSTALL أربعةُ متجهاتٍ منه اصطناعيّة)
    const queries = ["A1", "BIG", "BIG", "A1"].map((k) => retrieveSnippets(sbA, V1_QUERY(k), [files[k]!.id]));
    const [d1, d2] = await Promise.all([drainOwnJobs(sbA, { workerId: "w:d1" }), drainOwnJobs(sbA, { workerId: "w:d2" })]);
    const results = await Promise.all(queries);
    expect(d1.busy !== d2.busy || d1.busy === false).toBe(true); // بوابة التصريف: واحدٌ يعمل والآخر «مشغول»
    for (const r of results) expect(r.snippets[0]!.similarity).toBeGreaterThan(0.99);
    // بعد أن يُنهي أحدهما (وربما يُعيد الآخر): كل الوظائف مكتملة وبمحاولةٍ واحدة
    await drainOwnJobs(sbA, { workerId: "w:d3" });
    for (const n of ["C1", "C2", "C3"]) {
      const j = (await jobsOf(files[n]!.id)).find((x) => x.job_type === RAG_JOB_TYPE_F2LLM)!;
      expect(j.status).toBe("completed");
      expect(Number(j.attempts)).toBe(1);
      expect(await scalar("select rag_v2_model from files where id = $1", [files[n]!.id])).toBe(TAG);
    }
    const totalC = ["C1", "C2", "C3"].reduce((s, n) => s + nChunks(files[n]!.text), 0);
    expect(fake.embedded).toHaveLength(totalC); // كل مقطعٍ ضُمِّن مرّةً واحدة
    expect(new Set(fake.embedded).size).toBe(totalC);
    await assertNoSpaceMixing();
  });

  it("★ ★ ★ الحالة النهائية للتجربة كلّها: لا خلط فضاءات في أي صف، وv1 المعتمد للملفات الأصلية كما في S0", async () => {
    await assertNoSpaceMixing();
    expect(
      await scalar("select md5(string_agg(id::text || '|' || embedding::text || '|' || content, ',' order by id)) from file_chunks where embedding is not null and file_id = any($1)", [
        ["A1", "A2", "A3", "B1"].map((k) => files[k]!.id),
      ]),
    ).toBe(S0.chunks);
  });
});
