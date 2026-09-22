#!/usr/bin/env node
/**
 * Realistic local acceptance of the F2LLM space under a HARD 512 MB memory limit. Nothing is deployed.
 *
 *   node scripts/f2llm/acceptance/build-image.mjs --secret-file <file>          (once; bakes the URL/anon key the run uses)
 *   node scripts/f2llm/acceptance/run-acceptance.mjs --secret-file <file> --image ysd-f2llm-accept:local --out <dir> [--pdf <file.pdf>] [--mem 512m]
 *
 * What runs (all real, except the LLM provider and the Supabase edge):
 *   • the production image (Next.js standalone server, docker-entrypoint.sh, baked + hash-verified F2LLM artifact)
 *     in a container with `--memory=512m --memory-swap=512m` and the staging-only flag on
 *   • a real Postgres 17 + pgvector with migrations 0001..0048, behind a real PostgREST (RLS + security-definer RPCs apply)
 *   • gateway.mjs: GoTrue-style /auth/v1/user, the PostgREST proxy, an in-memory Storage, and a scripted OpenAI-compatible provider
 *
 * Scenarios (HTTP through the app's own routes, session cookie of a real user):
 *   M0 health · M1 uploads incl. the PR #9 lost-response reconciliation (clientUploadId) · M2 indexing of 6 documents (5 project
 *   docs + a PDF) fired at once like the composer does (drain gate, 202/409 backoff) with concurrent chat/retrieval waves ·
 *   M3 retrieval + re-index requests on ready files · then R1: SIGKILL of the server mid-indexing, restart, lease expiry, resume.
 * Measured: cgroup memory.peak/current/anon, process VmRSS/VmHWM (sampled every 500 ms), OOM kills, RestartCount.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { anonKey, GW_PORT, loadSecret, mintJwt, SUPABASE_URL } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const IMAGE = arg("--image", "ysd-f2llm-accept:local");
const OUT = resolve(arg("--out", join(root, ".acceptance-out")));
const PDF = arg("--pdf");
const MEM = arg("--mem", "512m");
const FLAG = arg("--flag", "f2llm-v2-80m"); // "" runs the same acceptance on the e5 default path (comparison only)
const APP_PORT = Number(arg("--app-port", 3100));
const INDEX_TIMEOUT_MS = Number(arg("--index-timeout-min", 20)) * 60 * 1000;
const REST_PORT = 3001;
const PG_CONTAINER = "ysd-pg-rehearsal";
const NET = "ysd-accept-net";
const APP = "ysd-accept-app";
const REST = "ysd-accept-rest";
const PG_ADMIN_URL = process.env.YSD_PG_URL ?? "postgres://postgres:rehearsal@127.0.0.1:54329/ysd";
const MODEL_TAG = JSON.parse(readFileSync(join(root, "scripts/f2llm/manifest.json"), "utf8")).artifact.tag;
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", ...o });
const docker = (...args) => sh("docker", args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const results = { startedAt: new Date().toISOString(), image: IMAGE, memLimit: MEM, flag: FLAG || "(default e5)", checks: [], phases: {}, http: [], notes: [] };
function check(name, ok, detail = "") {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  log(ok ? "PASS" : "FAIL", name, detail ? `— ${detail}` : "");
}

const SECRET = loadSecret(arg("--secret-file"));
const jwt = (claims) => mintJwt(SECRET, claims, 86400);
const ANON = anonKey(SECRET);
const SERVICE = mintJwt(SECRET, { role: "service_role" }, 30 * 86400);
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function sessionCookie(uid) {
  const access = jwt({ sub: uid, role: "authenticated", email: `${uid}@acceptance.test` });
  const session = { access_token: access, refresh_token: "acceptance-refresh", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, token_type: "bearer", user: { id: uid, aud: "authenticated", role: "authenticated", email: `${uid}@acceptance.test` } };
  return `sb-host-auth-token=${encodeURIComponent(JSON.stringify(session))}`;
}
const COOKIE_A = sessionCookie(USER_A);
/**
 * The app lets a user have ONE live generation at a time (acquire_generation_slot; a second concurrent chat is answered 429 by
 * design — observed in the first run of this script). Concurrent chat/retrieval load therefore comes from several users, each with
 * a private document of their own (RLS): five extra users next to user A.
 */
const EXTRA_USERS = Array.from({ length: 5 }, (_, i) => `c000000${i + 1}-0000-4000-8000-00000000000${i + 1}`);
const SMALL_DOCS = ["docs/ADDING_A_PROVIDER.md", "docs/PRODUCTION_CHECKLIST.md", "docs/RAILWAY_DEPLOY.md", "docs/RELEASE-v0.8.1.md", "docs/LOCAL_IMAGE_ENGINE.md"];
const ORIGIN = `http://localhost:${APP_PORT}`;
const BASE = ORIGIN;

async function http(label, path, { method = "GET", body, headers = {}, cookie = COOKIE_A, timeoutMs = 300000, raw = false } = {}) {
  const t0 = Date.now();
  const h = { Cookie: cookie, Origin: ORIGIN, ...headers };
  let payload = body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  try {
    const res = await fetch(BASE + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* stream or html */
    }
    results.http.push({ label, status: res.status, ms: Date.now() - t0 });
    return { status: res.status, json, text: raw ? text : text.slice(0, 4000), ms: Date.now() - t0 };
  } catch (e) {
    results.http.push({ label, status: 0, ms: Date.now() - t0, error: String(e.message ?? e).slice(0, 80) });
    return { status: 0, json: null, text: String(e.message ?? e), ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------------------------- infrastructure
let gateway = null;
let admin = null;
function cleanup() {
  docker("rm", "-f", APP);
  docker("rm", "-f", REST);
  if (gateway) gateway.kill();
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function setupInfra() {
  if (docker("image", "inspect", IMAGE).status !== 0) throw new Error(`image ${IMAGE} not found — build it first`);
  docker("network", "create", NET);
  docker("network", "connect", "--alias", "pg", NET, PG_CONTAINER);
  log("database: fresh chain 0001..0048");
  const r = sh("bash", [join(root, "scripts/f2llm/rehearsal/apply-chain.sh")], { cwd: root });
  if (r.status !== 0 || !/applied through 0048/.test(r.stdout)) throw new Error("apply-chain failed: " + r.stdout + r.stderr);
  admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query("set session_replication_role = replica");
  for (const [id, email] of [[USER_A, "a"], [USER_B, "b"], ...EXTRA_USERS.map((u, i) => [u, `u${i + 1}`])]) {
    await admin.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [id, `${email}@acceptance.test`]);
    await admin.query("insert into profiles (id) values ($1) on conflict do nothing", [id]);
  }
  await admin.query("set session_replication_role = origin");

  docker("rm", "-f", REST);
  const rest = docker("run", "-d", "--name", REST, "--network", NET, "-p", `${REST_PORT}:3000`, "-e", "PGRST_DB_URI=postgres://postgres:rehearsal@pg:5432/ysd", "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${SECRET}`, "postgrest/postgrest:v12.2.3");
  if (rest.status !== 0) throw new Error("postgrest failed to start: " + rest.stderr);
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${REST_PORT}/`, { headers: { apikey: ANON } }).then((x) => x.ok).catch(() => false);
    if (ok) break;
    if (i === 59) throw new Error("postgrest not ready");
    await sleep(500);
  }
  gateway = spawn(process.execPath, [join(here, "gateway.mjs")], { env: { ...process.env, PORT: String(GW_PORT), POSTGREST: `http://127.0.0.1:${REST_PORT}`, JWT_SECRET: SECRET }, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${GW_PORT}/__ping`).then((x) => x.ok).catch(() => false)) break;
    if (i === 39) throw new Error("gateway not ready");
    await sleep(250);
  }
}

function startApp() {
  docker("rm", "-f", APP);
  const env = [
    `NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}`,
    `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`,
    "OPENROUTER_API_KEY=sk-or-acceptance-dummy-key-not-a-real-key",
    `APP_ORIGIN=${ORIGIN}`,
    `RATE_LIMIT_HMAC_SECRET=${randomBytes(32).toString("hex")}`,
    "YSD_ENABLE_TEST_PROVIDER=1",
    `YSD_TEST_PROVIDER_URL=http://host.docker.internal:${GW_PORT}/llm/v1/chat/completions`,
    "RAILWAY_ENVIRONMENT_NAME=staging",
    ...(FLAG ? [`YSD_RAG_EMBEDDING_MODEL=${FLAG}`] : []),
  ];
  const args = ["run", "-d", "--name", APP, `--memory=${MEM}`, `--memory-swap=${MEM}`, "--restart=on-failure:5", "-p", `${APP_PORT}:3000`, ...env.flatMap((e) => ["-e", e]), IMAGE];
  const r = docker(...args);
  if (r.status !== 0) throw new Error("app container failed to start: " + r.stderr);
}
async function waitLive(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await fetch(`${BASE}/api/live`).then((x) => x.ok).catch(() => false);
    if (ok) return Date.now() - t0;
    await sleep(500);
  }
  throw new Error("app did not become live");
}

// ---------------------------------------------------------------------------------------------- memory sampling
const samples = [];
let phase = "boot";
let sampler = null;
function startSampler() {
  const script =
    "while :; do c=$(cat /sys/fs/cgroup/memory.current 2>/dev/null); a=$(awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat); f=$(awk '/^file /{print $2}' /sys/fs/cgroup/memory.stat); " +
    "r=$(awk '/^VmRSS/{print $2}' /proc/1/status); h=$(awk '/^VmHWM/{print $2}' /proc/1/status); p=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null); k=$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events); " +
    'echo "S $(date +%s%3N) ${c:-0} ${a:-0} ${f:-0} ${r:-0} ${h:-0} ${p:-0} ${k:-0}"; sleep 0.5; done';
  sampler = spawn("docker", ["exec", APP, "sh", "-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  sampler.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = line.split(" ");
      if (m[0] === "S" && m.length >= 9) samples.push({ t: Number(m[1]), phase, cur: +m[2], anon: +m[3], file: +m[4], rssKb: +m[5], hwmKb: +m[6], peak: +m[7], oomKill: +m[8] });
    }
  });
}
const MB = (b) => Math.round((b / 1048576) * 10) / 10;
function phasePeak(p) {
  const s = samples.filter((x) => x.phase === p);
  if (!s.length) return null;
  return {
    samples: s.length,
    rssPeakMb: MB(Math.max(...s.map((x) => x.rssKb)) * 1024),
    rssHwmMb: MB(Math.max(...s.map((x) => x.hwmKb)) * 1024),
    anonPeakMb: MB(Math.max(...s.map((x) => x.anon))),
    cgroupCurrentPeakMb: MB(Math.max(...s.map((x) => x.cur))),
    cgroupMemoryPeakMb: MB(Math.max(...s.map((x) => x.peak))),
    oomKills: Math.max(...s.map((x) => x.oomKill)),
  };
}
const inspect = () => {
  const r = docker("inspect", "-f", "{{.RestartCount}} {{.State.OOMKilled}} {{.State.Status}} {{.State.ExitCode}}", APP);
  const [rc, oom, status, exit] = r.stdout.trim().split(" ");
  return { restartCount: Number(rc), oomKilled: oom === "true", status, exitCode: Number(exit) };
};

// ---------------------------------------------------------------------------------------------- scenarios
const DOC_NAMES = ["docs/OPERATIONS.md", "docs/DESIGN-v0.9-evidence-mode.md", "CHANGELOG.md", "docs/local-pairing.md", "README.md"];
const QUESTIONS = [
  "كم أعلى استهلاك للذاكرة عند معالجة خمسة ملفات متزامنة؟",
  "ما الحد الأقصى لطول الاقتباس في وضع الأدلة؟",
  "How do I add a new AI provider to the system?",
  "What is a SEV-3 incident?",
  "كيف أنشر التطبيق على Railway وما إعداد PORT؟",
  "ما هي عاصمة اليابان؟",
  "How do I configure Kubernetes horizontal pod autoscaling?",
  "كم مدة صلاحية رمز الجلسة في الاقتران بالمحرك المحلي؟",
];

async function upload(label, name, bytes, mime, conversationId, clientUploadId, cookie = COOKIE_A) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type: mime }));
  if (conversationId) fd.append("conversationId", conversationId);
  if (clientUploadId) fd.append("clientUploadId", clientUploadId);
  return http(label, "/api/files/upload", { method: "POST", body: fd, cookie });
}
const listFiles = async (conversationId) => (await http("list", `/api/files?conversationId=${conversationId}`)).json?.files ?? [];

async function pollReady(conversationId, ids, { timeoutMs = INDEX_TIMEOUT_MS, everyMs = 2500, onTick } = {}) {
  const t0 = Date.now();
  let backoff = everyMs;
  while (Date.now() - t0 < timeoutMs) {
    const files = await listFiles(conversationId);
    const st = Object.fromEntries(files.filter((f) => ids.includes(f.id)).map((f) => [f.id, f.status]));
    if (onTick) await onTick(st);
    if (ids.every((id) => st[id] === "ready_for_rag")) return { ok: true, ms: Date.now() - t0, st };
    if (ids.some((id) => ["failed", "rag_failed"].includes(st[id]))) return { ok: false, ms: Date.now() - t0, st };
    await sleep(backoff);
    backoff = Math.min(8000, Math.round(backoff * 1.15));
  }
  return { ok: false, ms: Date.now() - t0, st: {}, timeout: true };
}

/**
 * The composer's stall protocol (PR #9): a file that is not ready while its job is due-but-untouched (queued / retrying), missing, or
 * running with a heartbeat older than the 120 s lease is resumed with ONE more POST /rag — spaced per file, a few times at most.
 * (Each request drains at most 5 jobs and only one drain runs per process, so >5 documents legitimately need a second request.)
 */
const lastKick = new Map();
let kicks = 0;
async function kickStalled(ids, minGapMs = 20000) {
  const rows = (await admin.query(
    "select f.id, f.status::text as status, j.status as jstatus, j.heartbeat_at from files f left join lateral (select * from rag_jobs where file_id = f.id order by created_at desc limit 1) j on true where f.id = any($1)",
    [ids],
  )).rows;
  const now = Date.now();
  for (const r of rows) {
    if (r.status === "ready_for_rag") continue;
    const stale = r.jstatus === "running" && r.heartbeat_at && now - new Date(r.heartbeat_at).getTime() > 120000;
    const dueIdle = !r.jstatus || ["queued", "retrying"].includes(r.jstatus);
    if ((stale || dueIdle) && now - (lastKick.get(r.id) ?? now) > minGapMs) {
      lastKick.set(r.id, now);
      kicks++;
      http("rag-resume-kick", `/api/files/${r.id}/rag`, { method: "POST", timeoutMs: 280000 });
    } else if (!lastKick.has(r.id)) lastKick.set(r.id, now);
  }
}

/** one chat per actor, all at once (an actor = a user with a conversation) */
async function chatRound(label, actors, modelId, offset = 0) {
  return Promise.all(
    actors.map((a, i) =>
      http(label, "/api/chat", {
        method: "POST",
        cookie: a.cookie,
        body: { conversationId: a.conversationId, modelId, message: QUESTIONS[(offset + i) % QUESTIONS.length], clientRequestId: `acc${randomUUID().replace(/-/g, "").slice(0, 20)}` },
        raw: true,
        timeoutMs: 240000,
      }),
    ),
  );
}
const chatOk = (rs) => rs.filter((r) => r.status === 200).length;

async function dbSummary(fileIds) {
  const q = (s, p = []) => admin.query(s, p).then((r) => r.rows);
  const files = await q("select id, status::text as status, rag_total_chunks, rag_v2_model, rag_error from files where id = any($1)", [fileIds]);
  const bad = await q(
    `select
       count(*) filter (where embedding_v2 is null)                                                       as no_v2,
       count(*) filter (where embedding_v2 is not null and vector_dims(embedding_v2) <> 320)              as wrong_dims,
       count(*) filter (where embedding_v2_model is distinct from $2 and embedding_v2 is not null)        as wrong_tag,
       count(*) filter (where embedding is not null)                                                      as has_v1,
       count(*)                                                                                           as chunks
     from file_chunks where file_id = any($1)`,
    [fileIds, MODEL_TAG],
  );
  // finiteness/unit norm of every stored v2 vector
  const vecs = await q("select embedding_v2::text as v from file_chunks where file_id = any($1) and embedding_v2 is not null", [fileIds]);
  let nonFinite = 0;
  let badNorm = 0;
  for (const r of vecs) {
    const v = JSON.parse(r.v);
    let n = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) nonFinite++;
      n += x * x;
    }
    if (Math.abs(Math.sqrt(n) - 1) > 1e-3) badNorm++;
  }
  const jobs = await q("select job_type, status, count(*)::int as n, max(attempts) as max_attempts from rag_jobs where file_id = any($1) group by 1,2 order by 1,2", [fileIds]);
  const dup = await q("select count(*)::int as n from (select file_id, chunk_index from file_chunks where file_id = any($1) group by 1,2 having count(*) > 1) d", [fileIds]);
  return { files, chunks: bad[0], vectorsChecked: vecs.length, nonFinite, badNorm, jobs, duplicateChunkIndexes: dup[0].n };
}

async function main() {
  log("== infrastructure ==");
  await setupInfra();
  startApp();
  const bootMs = await waitLive();
  log(`app live after ${bootMs} ms`);
  startSampler();
  await sleep(1500);
  results.phases.boot = { liveMs: bootMs };

  // the entrypoint must have exported the glibc tunables into the node process (and only when the flag is on)
  const env1 = docker("exec", APP, "sh", "-c", "tr '\\0' '\\n' < /proc/1/environ | grep -E '^(MALLOC_|YSD_RAG_EMBEDDING_MODEL|YSD_LOW_MEMORY)' | sort").stdout.trim();
  results.notes.push("pid1 env: " + env1.replace(/\n/g, " "));
  if (FLAG) check("entrypoint exported MALLOC_MMAP_THRESHOLD_/MALLOC_TRIM_THRESHOLD_ =65536 into the server process", /MALLOC_MMAP_THRESHOLD_=65536/.test(env1) && /MALLOC_TRIM_THRESHOLD_=65536/.test(env1), env1.replace(/\n/g, " "));
  else check("flag off: entrypoint leaves the default path untouched (no MALLOC_* exported)", !/MALLOC_/.test(env1), env1.replace(/\n/g, " "));

  // ---- M0 health
  phase = "M0-health";
  const live = await http("live", "/api/live");
  const health = await http("health", "/api/health");
  check("/api/live 200", live.status === 200);
  // the readiness body is deliberately opaque; its env check needs an https *.supabase.co URL, which a local stack cannot have —
  // so this is informational. The v2 column probe itself is covered by tests/v139-f2llm-health-probe.test.ts.
  check("/api/health answers (200 or an opaque 503 from the local env check)", [200, 503].includes(health.status), `status ${health.status}`);

  // models
  const models = await http("models", "/api/models");
  const list = models.json?.models ?? models.json ?? [];
  const modelId = (Array.isArray(list) ? list : []).map((m) => m.id ?? m.modelId ?? m.model_id).find(Boolean);
  results.notes.push(`chat model: ${modelId}`);

  // conversation
  const conv = await http("conversation", "/api/conversations", { method: "POST", body: { title: "F2LLM acceptance" } });
  const conversationId = conv.json?.conversation?.id ?? conv.json?.id;
  check("conversation created", Boolean(conversationId), `status ${conv.status}`);
  if (!conversationId || !modelId) throw new Error("cannot continue without a conversation and a model id: " + conv.text + " / " + models.text);
  const actorA = { cookie: COOKIE_A, conversationId };
  const others = [];
  for (const u of EXTRA_USERS) {
    const cookie = sessionCookie(u);
    const c = await http("conversation-extra", "/api/conversations", { method: "POST", body: { title: "extra user" }, cookie });
    const cid = c.json?.conversation?.id ?? c.json?.id;
    if (!cid) throw new Error("extra user conversation failed: " + c.status + c.text);
    others.push({ cookie, conversationId: cid, user: u });
  }

  // ---- M1 uploads
  phase = "M1-uploads";
  const files = DOC_NAMES.map((n) => ({ name: n.split("/").pop(), bytes: readFileSync(join(root, n)), mime: n.endsWith(".md") ? "text/markdown" : "text/plain", clientId: randomUUID() }));
  if (PDF) files.push({ name: "annual-report.pdf", bytes: readFileSync(PDF), mime: "application/pdf", clientId: randomUUID() });
  const ids = [];
  // 3 at a time (the composer's own concurrency)
  for (let i = 0; i < files.length; i += 3) {
    const batch = files.slice(i, i + 3);
    const res = await Promise.all(batch.map((f) => upload(`upload:${f.name}`, f.name, f.bytes, f.mime, conversationId, f.clientId)));
    res.forEach((r, k) => {
      const f = r.json?.file;
      if (f?.id) {
        ids.push(f.id);
        batch[k].id = f.id;
      }
    });
    check(`upload batch ${i / 3 + 1} accepted (${batch.map((b) => b.name).join(", ")})`, res.every((r) => [200, 201].includes(r.status) && r.json?.file?.id), res.map((r) => r.status).join("/"));
  }
  // PR #9 reconciliation: the response was lost, the client retries with the SAME clientUploadId → the existing file, not a duplicate
  const dupe = await upload("upload:reconcile-retry", files[0].name, files[0].bytes, files[0].mime, conversationId, files[0].clientId);
  check("PR#9 reconcile: re-upload with the same clientUploadId returns the existing file (reused, 200)", dupe.status === 200 && dupe.json?.reused === true && dupe.json?.file?.id === files[0].id, `status ${dupe.status} reused=${dupe.json?.reused}`);
  const lookup = await http("reconcile-lookup", `/api/files?clientUploadId=${files[0].clientId}`);
  check("PR#9 reconcile: GET /api/files?clientUploadId finds exactly that one file", lookup.json?.files?.length === 1 && lookup.json.files[0].id === files[0].id, `n=${lookup.json?.files?.length}`);
  check("no duplicate file rows after the retry", (await listFiles(conversationId)).length === files.length, `${(await listFiles(conversationId)).length} files`);
  results.phases.files = files.map((f) => ({ name: f.name, bytes: f.bytes.length, id: f.id }));

  // five other users each upload and index one small private document (real /rag route; one drain at a time per process)
  const otherFiles = [];
  for (const [i, o] of others.entries()) {
    const name = SMALL_DOCS[i];
    const r = await upload(`upload-extra:${name}`, name.split("/").pop(), readFileSync(join(root, name)), "text/markdown", o.conversationId, randomUUID(), o.cookie);
    if (r.json?.file?.id) otherFiles.push({ id: r.json.file.id, actor: o });
  }
  check("five extra users uploaded a small document each", otherFiles.length === others.length);
  phase = "M1b-extra-users-index";
  const t1 = Date.now();
  await Promise.all(otherFiles.map((f) => http("rag-extra", `/api/files/${f.id}/rag`, { method: "POST", cookie: f.actor.cookie, timeoutMs: 280000 })));
  for (const f of otherFiles) {
    for (let k = 0; k < 40; k++) {
      f.status = (await http("list-extra", `/api/files?conversationId=${f.actor.conversationId}`, { cookie: f.actor.cookie })).json?.files?.[0]?.status;
      if (f.status === "ready_for_rag") break;
      await http("rag-extra-resume", `/api/files/${f.id}/rag`, { method: "POST", cookie: f.actor.cookie, timeoutMs: 280000 });
      await sleep(1500);
    }
  }
  check(`the five extra users' documents are ready_for_rag (${Math.round((Date.now() - t1) / 1000)} s; concurrent /rag from 5 users)`, otherFiles.every((f) => f.status === "ready_for_rag"), otherFiles.map((f) => f.status).join(","));

  // ---- M2 indexing: everything at once (the composer fires one POST /rag per upload)
  phase = "M2-indexing";
  const ragStatuses = [];
  const t0 = Date.now();
  const rag = ids.map((id) => http("rag", `/api/files/${id}/rag`, { method: "POST", timeoutMs: 280000 }).then((r) => {
    ragStatuses.push(r.status);
    return r;
  }));
  // concurrent chat/retrieval while indexing runs: waves start once the first document is ready
  let wave = 0;
  const chatResults = [];
  let firstReadyAt = null;
  const ready = await pollReady(conversationId, ids, {
    onTick: async (st) => {
      await kickStalled(ids);
      const nReady = Object.values(st).filter((s) => s === "ready_for_rag").length;
      if (nReady >= 1 && !firstReadyAt) firstReadyAt = Date.now() - t0;
      if (nReady >= 1 && wave < 3 && nReady < ids.length) {
        wave++;
        chatResults.push(...(await chatRound(`chat-during-indexing-${wave}`, [actorA, ...others], modelId, wave * 2)));
      }
    },
  });
  await Promise.allSettled(rag);
  results.phases.indexing = { allReady: ready.ok, totalMs: Date.now() - t0, firstReadyMs: firstReadyAt, resumeKicks: kicks, ragStatuses: ragStatuses.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}) };
  check("all documents (incl. PDF) reached ready_for_rag with F2LLM", ready.ok, `${Math.round((Date.now() - t0) / 1000)} s, states ${JSON.stringify(Object.values(ready.st))}`);
  const ok200 = chatResults.filter((r) => r.status === 200).length;
  check(`chat/retrieval requests during indexing all answered 200 (${ok200}/${chatResults.length})`, chatResults.length > 0 && ok200 === chatResults.length, chatResults.filter((r) => r.status !== 200).map((r) => r.status).join(","));

  // ---- M3 retrieval on ready files + repeat /rag on ready files + health, all at once
  phase = "M3-retrieval";
  const m3 = await Promise.all([
    (async () => {
      const rounds = [];
      for (let k = 0; k < 3; k++) rounds.push(...(await chatRound("chat-after-indexing", [actorA, ...others], modelId, k)));
      return rounds;
    })(),
    ...ids.map((id) => http("rag-again", `/api/files/${id}/rag`, { method: "POST" })),
    http("health-under-load", "/api/health"),
  ]);
  const chats3 = m3[0];
  const rag3 = m3.slice(1, 1 + ids.length);
  check(`3 rounds x 6 users (${chats3.length} chat/retrieval requests, 6 at a time) on ready files all answered 200 (${chatOk(chats3)}/${chats3.length})`, chats3.every((r) => r.status === 200), chats3.filter((r) => r.status !== 200).map((r) => r.status).join(","));
  check("repeat POST /rag on ready files is skipped (idempotent, no re-embedding)", rag3.every((r) => r.status === 200 && r.json?.skipped === true), rag3.map((r) => `${r.status}${r.json?.skipped ? "s" : ""}`).join(","));
  const gw = await fetch(`http://127.0.0.1:${GW_PORT}/__stats`).then((r) => r.json());
  results.phases.gateway = gw;
  check("retrieval used the v2 RPC and never the 384-d RPC (no space mixing)", FLAG ? (gw.rpc?.match_file_chunks_v2 ?? 0) > 0 && (gw.rpc?.match_file_chunks ?? 0) === 0 : (gw.rpc?.match_file_chunks ?? 0) > 0 && (gw.rpc?.match_file_chunks_v2 ?? 0) === 0, JSON.stringify(gw.rpc));
  check("the scripted provider served every accepted chat request", gw.llm >= chatOk(chatResults) + chatOk(chats3), `llm calls ${gw.llm}, max concurrent ${gw.llmMaxActive}`);
  results.phases.chat = { duringIndexing: { sent: chatResults.length, ok: chatOk(chatResults) }, afterIndexing: { sent: chats3.length, ok: chatOk(chats3) } };

  // ---- M4 settle + verdict inputs
  phase = "M4-settle";
  await sleep(8000);
  const main = inspect();
  results.phases.mainContainer = main;
  const db = await dbSummary(ids);
  results.phases.db = db;
  if (FLAG) {
    check("every chunk has a finite unit-norm 320-d v2 vector tagged with the pinned model", db.chunks.no_v2 == 0 && db.chunks.wrong_dims == 0 && db.chunks.wrong_tag == 0 && db.nonFinite === 0 && db.badNorm === 0 && db.vectorsChecked === Number(db.chunks.chunks), `chunks=${db.chunks.chunks} checked=${db.vectorsChecked} nonFinite=${db.nonFinite} badNorm=${db.badNorm}`);
    check("no 384-d vector was written while the F2LLM space was active (spaces not mixed)", Number(db.chunks.has_v1) === 0, `has_v1=${db.chunks.has_v1}`);
    check("every file carries rag_v2_model = the pinned tag", db.files.every((f) => f.rag_v2_model === MODEL_TAG && f.status === "ready_for_rag"));
  } else {
    check("e5 default path: 384-d vectors only", Number(db.chunks.has_v1) === Number(db.chunks.chunks));
  }
  check("no duplicate chunk indexes", db.duplicateChunkIndexes === 0);
  check("all jobs completed, none failed", db.jobs.every((j) => j.status === "completed"), JSON.stringify(db.jobs));
  const mainOom = samples.length ? Math.max(...samples.map((s) => s.oomKill)) : 0;
  check("no OOM kill and no restart during the main scenario", main.restartCount === 0 && !main.oomKilled && mainOom === 0 && main.status === "running", JSON.stringify(main) + ` cgroup oom_kill=${mainOom}`);

  // ---- R1 crash recovery: SIGKILL mid-indexing, restart, expired lease, resume
  phase = "R1-recovery";
  docker("update", "--restart=no", APP);
  const big = files[0]; // a 30-chunk document, indexed again as a NEW file so the kill lands mid-embedding
  const recName = "recovery-" + big.name;
  const up = await upload("upload:recovery", recName, Buffer.concat([big.bytes, Buffer.from("\n\n## ملحق\n"), files[2].bytes.subarray(0, 12000)]), big.mime, conversationId, randomUUID());
  const rid = up.json?.file?.id;
  check("recovery document uploaded", Boolean(rid), `status ${up.status}`);
  if (rid) {
    const ragP = http("rag-recovery", `/api/files/${rid}/rag`, { method: "POST", timeoutMs: 15000 }); // will die with the server
    let partial = 0;
    let total = 0;
    for (let i = 0; i < 240; i++) {
      const r = (await admin.query("select count(*) filter (where embedding_v2 is not null)::int as done, count(*)::int as total from file_chunks where file_id = $1", [rid])).rows[0];
      partial = r.done;
      total = r.total;
      if (total > 0 && partial >= 6 && partial < total) break;
      await sleep(250);
    }
    check("server killed while the document is partially embedded", partial >= 6 && partial < total, `${partial}/${total} chunks had v2 vectors`);
    docker("kill", "-s", "KILL", APP);
    await ragP;
    const beforeJobs = (await admin.query("select status, attempts, locked_by from rag_jobs where file_id = $1", [rid])).rows;
    check("the killed job is left running with a dead lock (needs recovery)", beforeJobs.some((j) => j.status === "running"), JSON.stringify(beforeJobs));
    const afterKill = (await admin.query("select count(*) filter (where embedding_v2 is not null)::int as done from file_chunks where file_id = $1", [rid])).rows[0].done;
    docker("start", APP);
    await waitLive();
    // the lease (120 s) is what the composer waits out; back-date it instead of sleeping (the SQL claim logic is the real one)
    await admin.query("update rag_jobs set heartbeat_at = now() - interval '10 minutes', locked_at = now() - interval '10 minutes' where file_id = $1 and status = 'running'", [rid]);
    const rs = await http("rag-resume", `/api/files/${rid}/rag`, { method: "POST", timeoutMs: 280000 });
    let rdy = rs.json?.file?.status === "ready_for_rag" ? { ok: true } : await pollReady(conversationId, [rid], { timeoutMs: 8 * 60 * 1000, onTick: () => kickStalled([rid]) });
    check("stalled job recovered after restart: the resume request completes the document", rdy.ok, `resume http ${rs.status}`);
    const rdb = await dbSummary([rid]);
    results.phases.recovery = { chunksBeforeKill: partial, chunksAfterKill: afterKill, total, db: rdb };
    check("recovered document: all chunks have finite 320-d vectors, no duplicates, tag set", rdb.chunks.no_v2 == 0 && rdb.chunks.wrong_dims == 0 && rdb.nonFinite === 0 && rdb.duplicateChunkIndexes === 0 && rdb.files[0]?.rag_v2_model === MODEL_TAG, JSON.stringify(rdb.chunks));
    const att = (await admin.query("select max(attempts)::int as a from rag_jobs where file_id = $1", [rid])).rows[0].a;
    check("the job was retried (attempts ≥ 2) and completed", att >= 2 && rdb.jobs.every((j) => j.status === "completed"), `attempts=${att}`);
    // after the restart the model still answers retrieval for the recovered file
    const ans = await chatRound("chat-after-recovery", [actorA, ...others], modelId, 0);
    check("retrieval works after the restart (6 users at once)", ans.every((r) => r.status === 200), ans.map((r) => r.status).join(","));
  }

  // ---- summary
  for (const p of ["boot", "M0-health", "M1-uploads", "M1b-extra-users-index", "M2-indexing", "M3-retrieval", "M4-settle", "R1-recovery"]) results.phases[`mem:${p}`] = phasePeak(p);
  const mainPhases = ["boot", "M0-health", "M1-uploads", "M1b-extra-users-index", "M2-indexing", "M3-retrieval", "M4-settle"];
  const mainSamples = samples.filter((s) => mainPhases.includes(s.phase));
  results.memory = {
    scenario: "boot → health → uploads (6 docs + 5 users) → indexing → 6-user chat waves during and after indexing → settle (deliberate-kill recovery excluded)",
    rssPeakMb: MB(Math.max(...mainSamples.map((s) => s.rssKb)) * 1024),
    rssHwmMb: MB(Math.max(...mainSamples.map((s) => s.hwmKb)) * 1024),
    anonPeakMb: MB(Math.max(...mainSamples.map((s) => s.anon))),
    cgroupCurrentPeakMb: MB(Math.max(...mainSamples.map((s) => s.cur))),
    cgroupMemoryPeakMb: MB(Math.max(...mainSamples.map((s) => s.peak))),
    idleAfterSettleRssMb: MB((mainSamples.filter((s) => s.phase === "M4-settle").at(-1)?.rssKb ?? 0) * 1024),
    samples: mainSamples.length,
    oomKills: mainOom,
    restarts: main.restartCount,
    limitMb: MEM,
  };
  const peakForGate = results.memory.rssHwmMb;
  check(`peak process RSS ≤ 430 MB (preferred target): ${peakForGate} MB (hard limit ${MEM})`, peakForGate <= 430, `cgroup memory.peak ${results.memory.cgroupMemoryPeakMb} MB, anon peak ${results.memory.anonPeakMb} MB`);
  check(`cgroup memory.peak below the hard limit (${MEM})`, results.memory.cgroupMemoryPeakMb < 512, `${results.memory.cgroupMemoryPeakMb} MB`);

  const latencies = (label) => results.http.filter((h) => h.label === label && h.status === 200).map((h) => h.ms).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))] : null);
  results.latency = { chatAfterIndexing: { p50: q(latencies("chat-after-indexing"), 0.5), p95: q(latencies("chat-after-indexing"), 0.95) }, chatDuringIndexing: { p50: q([1, 2, 3].flatMap((i) => latencies(`chat-during-indexing-${i}`)).sort((a, b) => a - b), 0.5) } };
  results.finishedAt = new Date().toISOString();
  results.pass = results.checks.every((c) => c.ok);
  writeFileSync(join(OUT, `acceptance-${FLAG || "e5"}.json`), JSON.stringify({ ...results, samplesCsv: undefined }, null, 1));
  writeFileSync(join(OUT, `samples-${FLAG || "e5"}.csv`), "t,phase,cgroup_current,anon,file,rss_kb,hwm_kb,cgroup_peak,oom_kill\n" + samples.map((s) => [s.t, s.phase, s.cur, s.anon, s.file, s.rssKb, s.hwmKb, s.peak, s.oomKill].join(",")).join("\n"));
  log(results.pass ? "ACCEPTANCE: ALL CHECKS PASSED" : "ACCEPTANCE: FAILURES: " + results.checks.filter((c) => !c.ok).map((c) => c.name).join(" | "));
  console.log(JSON.stringify(results.memory, null, 1));
}

try {
  await main();
} catch (e) {
  console.error("ACCEPTANCE ERROR:", e);
  results.error = String(e?.stack ?? e);
  results.finishedAt = new Date().toISOString();
  results.pass = false;
  writeFileSync(join(OUT, `acceptance-${FLAG || "e5"}.error.json`), JSON.stringify({ ...results, sampleCount: samples.length }, null, 1));
  process.exitCode = 1;
} finally {
  if (sampler) sampler.kill();
  if (admin) await admin.end().catch(() => undefined);
  if (!argv.includes("--keep")) cleanup();
}
