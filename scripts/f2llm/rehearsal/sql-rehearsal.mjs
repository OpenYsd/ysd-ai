#!/usr/bin/env node
/**
 * SQL-level migration rehearsal for the F2LLM (v2, 320-d) embedding lane, against a REAL pgvector Postgres
 * carrying the app's real migration chain 0001..0047 (see apply-chain.sh).
 *
 *   scripts/f2llm/rehearsal/apply-chain.sh 47          # fresh database at the pre-migration state
 *   node scripts/f2llm/rehearsal/sql-rehearsal.mjs      # YSD_PG_URL to override the connection
 *
 * Proves: the existing 384-d vectors, their HNSW index and match_file_chunks are untouched by 0048; the v2
 * lane only ever returns v2-tagged, fully-embedded, owned rows; the two spaces cannot mix; the migration is
 * idempotent; the down migration restores the exact pre-migration v1 state and can be re-applied.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const UP = readFileSync(join(root, "supabase", "migrations", "0048_f2llm_embedding_v2.sql"), "utf8");
const DOWN = readFileSync(join(root, "supabase", "rollbacks", "0048_f2llm_embedding_v2.down.sql"), "utf8");
const MODEL = "f2llm-v2-80m@ad88d7a1.onnx-fcd9084eb3f4";

const client = new pg.Client({ connectionString: process.env.YSD_PG_URL ?? "postgres://postgres:rehearsal@127.0.0.1:54329/ysd" });
await client.connect();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---- deterministic vectors ----
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unitVec(dim, seed) {
  const r = rng(seed);
  const v = Array.from({ length: dim }, () => r() * 2 - 1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const lit = (v) => "[" + v.map((x) => x.toFixed(7)).join(",") + "]";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const F = { A1: "a1000000-0000-4000-8000-000000000001", A2: "a2000000-0000-4000-8000-000000000002", A3: "a3000000-0000-4000-8000-000000000003", B1: "b1000000-0000-4000-8000-000000000001" };
const chunkId = (file, i) => `${file.slice(0, 2)}c${String(i).padStart(5, "0")}-0000-4000-8000-${file.slice(-12)}`;

async function asUser(uid, fn) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

async function scalar(sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

// ---------------- test data at the pre-migration state ----------------
// the private-beta signup trigger (handle_new_user) demands an invite code; setup inserts bypass triggers
await client.query("set session_replication_role = replica");
for (const [id, email] of [[A, "a@rehearsal.test"], [B, "b@rehearsal.test"]]) {
  await client.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [id, email]);
  await client.query("insert into profiles (id) values ($1) on conflict do nothing", [id]);
}
const fileDefs = [["A1", A, "أ-١.txt"], ["A2", A, "a-2.txt"], ["A3", A, "a-3-v1-only.txt"], ["B1", B, "b-1.txt"]];
for (const [k, owner, name] of fileDefs) {
  await client.query(
    "insert into files (id, user_id, file_name, original_name, mime_type, size_bytes, storage_path, status) values ($1,$2,$3,$3,'text/plain',10,$4,'ready_for_rag') on conflict do nothing",
    [F[k], owner, name, `${owner}/${F[k]}/${name}`],
  );
}
await client.query("set session_replication_role = origin");
const v1Vec = (file, i) => unitVec(384, Number(BigInt("0x" + file.slice(0, 6)) % 100000n) * 10 + i);
const v2Vec = (file, i) => unitVec(320, Number(BigInt("0x" + file.slice(0, 6)) % 100000n) * 10 + i + 5000);
const chunkFiles = [["A1", A, 3], ["A2", A, 3], ["A3", A, 3], ["B1", B, 3]];
for (const [k, owner, n] of chunkFiles) {
  for (let i = 0; i < n; i++) {
    await client.query(
      "insert into file_chunks (id, file_id, user_id, chunk_index, content, character_count, embedding) values ($1,$2,$3,$4,$5,$6,$7::vector) on conflict do nothing",
      [chunkId(F[k], i), F[k], owner, i, `محتوى ${k}#${i} content`, 20, lit(v1Vec(F[k], i))],
    );
  }
}

// ---------------- v1 state snapshot ----------------
async function snapshotV1() {
  const chunks = await scalar("select md5(string_agg(id::text || '|' || embedding::text || '|' || content, ',' order by id)) from file_chunks");
  const n = await scalar("select count(*) from file_chunks where embedding is not null");
  const idx = await scalar("select indexdef from pg_indexes where indexname = 'idx_chunks_embedding'");
  const fn = await scalar("select md5(pg_get_functiondef('match_file_chunks(vector,uuid[],int,float)'::regprocedure))");
  const col = await scalar("select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'file_chunks'::regclass and attname = 'embedding'");
  const acl = await scalar("select md5(coalesce(proacl::text, 'null')) from pg_proc where oid = 'match_file_chunks(vector,uuid[],int,float)'::regprocedure");
  const rpc = {};
  for (const [k, owner] of [["A1", A], ["A2", A], ["A3", A]]) {
    rpc[k] = await asUser(owner, async () => {
      const q = lit(v1Vec(F[k], 1));
      const r = await client.query("select chunk_id, round(similarity::numeric, 6) as s from match_file_chunks($1::vector, $2::uuid[], 8, 0.5)", [q, [F[k]]]);
      return r.rows.map((x) => `${x.chunk_id}:${x.s}`).join(",");
    });
  }
  return { chunks, n: Number(n), idx, fn, col, acl, rpc };
}

const before = await snapshotV1();
check("pre-migration: v1 column is vector(384) with 12 embedded chunks", before.col === "vector(384)" && before.n === 12, `${before.col}, n=${before.n}`);
check("pre-migration: no v2 objects exist", (await scalar("select count(*) from information_schema.columns where table_name='file_chunks' and column_name='embedding_v2'")) == 0);

// ---------------- apply 0048 ----------------
await client.query(UP);
const after = await snapshotV1();
check("0048 applied", (await scalar("select count(*) from information_schema.columns where table_name='file_chunks' and column_name in ('embedding_v2','embedding_v2_model')")) == 2);
check("v1 vectors bit-identical after 0048 (md5 over id|embedding|content)", before.chunks === after.chunks && before.n === after.n, `${after.chunks}`);
check("v1 column type unchanged (vector(384))", after.col === "vector(384)");
check("v1 HNSW index definition unchanged", before.idx === after.idx);
check("match_file_chunks function body unchanged", before.fn === after.fn);
check("match_file_chunks privileges unchanged", before.acl === after.acl);
check("v1 RPC results identical for every file (ids and similarities)", JSON.stringify(before.rpc) === JSON.stringify(after.rpc));

// idempotent
await client.query(UP);
const again = await snapshotV1();
check("0048 is idempotent (re-run: no error, v1 still identical)", again.chunks === before.chunks && again.fn === before.fn);
check("exactly one v2 index and one v2 function after re-run", (await scalar("select count(*) from pg_indexes where indexname='idx_chunks_embedding_v2'")) == 1 && (await scalar("select count(*) from pg_proc where proname='match_file_chunks_v2'")) == 1);

// ---------------- populate v2 for selected documents ----------------
const upd = "update file_chunks set embedding_v2 = $1::vector, embedding_v2_model = $2 where id = $3";
for (let i = 0; i < 3; i++) await client.query(upd, [lit(v2Vec(F.A1, i)), MODEL, chunkId(F.A1, i)]);
for (let i = 0; i < 3; i++) await client.query(upd, [lit(v2Vec(F.B1, i)), MODEL, chunkId(F.B1, i)]);
for (let i = 0; i < 2; i++) await client.query(upd, [lit(v2Vec(F.A2, i)), MODEL, chunkId(F.A2, i)]); // A2 only partially embedded
await client.query("update files set rag_v2_model = $1 where id = any($2::uuid[])", [MODEL, [F.A1, F.B1]]);
// one A1 chunk carries a DIFFERENT model tag
await client.query(upd, [lit(v2Vec(F.A1, 2)), "some-other-model@1", chunkId(F.A1, 2)]);

const afterV2 = await snapshotV1();
check("populating v2 leaves the 384-d column untouched", afterV2.chunks === before.chunks, afterV2.chunks);

const v2q = (file, i) => lit(v2Vec(F[file], i));
const rpc2 = (user, q, files, model = MODEL, n = 8, min = 0.0) =>
  asUser(user, async () => (await client.query("select chunk_id, file_id, round(similarity::numeric, 5) as s, original_name from match_file_chunks_v2($1::vector, $2::uuid[], $3, $4, $5)", [q, files, model, n, min])).rows);

let r = await rpc2(A, v2q("A1", 0), [F.A1]);
check("v2: nearest chunk is the planted one (similarity 1.0)", r[0]?.chunk_id === chunkId(F.A1, 0) && Number(r[0].s) === 1, JSON.stringify(r[0]));
check("v2: the chunk with a different model tag is excluded", !r.some((x) => x.chunk_id === chunkId(F.A1, 2)), `returned ${r.length} rows`);
r = await rpc2(A, v2q("A2", 0), [F.A2]);
check("v2: a partially-embedded file (files.rag_v2_model null) returns nothing", r.length === 0);
r = await rpc2(A, v2q("A1", 0), [F.A3]);
check("v2: a v1-only file returns nothing", r.length === 0);
r = await rpc2(A, v2q("A1", 0), [F.A1], "wrong-model");
check("v2: a mismatching model tag returns nothing", r.length === 0);
r = await rpc2(A, v2q("A1", 0), [F.A1], "");
check("v2: an empty model tag returns nothing", r.length === 0);
r = await rpc2(A, v2q("B1", 0), [F.B1]);
check("v2 RLS/ownership: user A cannot read user B's v2 chunks", r.length === 0);
r = await rpc2(B, v2q("B1", 0), [F.B1]);
check("v2: user B reads their own", r.length > 0 && r[0].chunk_id === chunkId(F.B1, 0));
const anon = await client.query("begin").then(async () => { await client.query("set local role authenticated"); const x = await client.query("select count(*) c from match_file_chunks_v2($1::vector, $2::uuid[], $3)", [v2q("A1", 0), [F.A1], MODEL]); await client.query("rollback"); return Number(x.rows[0].c); });
check("v2: no session (auth.uid() null) returns nothing", anon === 0);
check("v2 privileges: anon cannot execute, authenticated can", (await scalar("select has_function_privilege('anon','match_file_chunks_v2(vector,uuid[],text,int,float)','execute')")) === false && (await scalar("select has_function_privilege('authenticated','match_file_chunks_v2(vector,uuid[],text,int,float)','execute')")) === true);

// ---------------- the two spaces cannot mix ----------------
let err = null;
try { await asUser(A, () => client.query("select * from match_file_chunks_v2($1::vector, $2::uuid[], $3)", [lit(unitVec(384, 1)), [F.A1], MODEL])); } catch (e) { err = e.message; }
check("v2 function rejects a 384-d query vector (explicit error, not an empty result)", err && /expects a 320-dimensional/i.test(err), err ?? "no error");
err = null;
try { await asUser(A, () => client.query("select * from match_file_chunks($1::vector, $2::uuid[], 8, 0.0)", [lit(unitVec(320, 1)), [F.A1]])); } catch (e) { err = e.message; }
check("v1 function fails on a 320-d query vector (dimension mismatch in the operator)", err && /different vector dimensions/i.test(err), err ?? "no error");
err = null;
try { await client.query("update file_chunks set embedding_v2 = $1::vector where id = $2", [lit(unitVec(384, 2)), chunkId(F.A1, 0)]); } catch (e) { err = e.message; }
check("embedding_v2 column rejects a 384-d vector", err && /dimensions/i.test(err), err ?? "no error");
err = null;
try { await client.query("update file_chunks set embedding_v2 = $1::vector where id = $2", [lit(unitVec(320, 3)), chunkId(F.A3, 0)]); } catch (e) { err = e.message; }
check("constraint: a v2 vector without a model tag is rejected", err && /embedding_v2_model_pair/.test(err), err ?? "no error");
err = null;
try { await client.query("update file_chunks set embedding_v2_model = 'x' where id = $1", [chunkId(F.A3, 1)]); } catch (e) { err = e.message; }
check("constraint: a model tag without a vector is rejected", err && /embedding_v2_model_pair/.test(err), err ?? "no error");
const v1Only = await asUser(A, async () => (await client.query("select chunk_id from match_file_chunks($1::vector, $2::uuid[], 8, 0.5)", [lit(v1Vec(F.A3, 0)), [F.A3]])).rows.length);
check("v1 lane still finds v1-only files while v2 exists", v1Only >= 1);

// the partial HNSW index can serve the v2 ordering
await client.query("begin");
await client.query("set local enable_seqscan = off");
const plan = (await client.query("explain select id from file_chunks where embedding_v2 is not null order by embedding_v2 <=> $1::vector limit 3".replace("$1", `'${v2q("A1", 0)}'`))).rows.map((x) => x["QUERY PLAN"]).join("\n");
await client.query("rollback");
check("v2 ordering can use the dedicated HNSW index", /idx_chunks_embedding_v2/.test(plan), plan.split("\n").find((l) => /Index/.test(l)) ?? plan.slice(0, 120));

// ---------------- rollback ----------------
await client.query(DOWN);
const rolled = await snapshotV1();
check("down migration: no v2 objects remain", (await scalar("select count(*) from information_schema.columns where table_name='file_chunks' and column_name like 'embedding_v2%'")) == 0 && (await scalar("select count(*) from pg_proc where proname='match_file_chunks_v2'")) == 0 && (await scalar("select count(*) from pg_indexes where indexname='idx_chunks_embedding_v2'")) == 0 && (await scalar("select count(*) from information_schema.columns where table_name='files' and column_name='rag_v2_model'")) == 0);
check("down migration: v1 state identical to the pre-migration snapshot", rolled.chunks === before.chunks && rolled.idx === before.idx && rolled.fn === before.fn && rolled.acl === before.acl && rolled.col === before.col && JSON.stringify(rolled.rpc) === JSON.stringify(before.rpc));
await client.query(DOWN);
check("down migration is idempotent", true);
await client.query(UP);
check("re-applying 0048 after the rollback works and starts empty", (await scalar("select count(*) from file_chunks where embedding_v2 is not null")) == 0 && (await snapshotV1()).chunks === before.chunks);

await client.end();
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ at: new Date().toISOString(), postgres: "17 + pgvector", results }, null, 2));
process.exit(failed.length ? 1 : 0);
