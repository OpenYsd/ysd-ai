#!/usr/bin/env node
/**
 * Targeted rollback check (Scenario C): reuses the SAME rehearsal Postgres data left by a prior
 * run-acceptance.mjs run (real v2 vectors already written), starts a fresh PostgREST + app container
 * with YSD_F2LLM_PRODUCTION_OPT_IN removed (everything else unchanged: still production-named, still
 * requesting YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m), and proves:
 *   - the entrypoint did not export MALLOC_* (guard fails closed without the opt-in)
 *   - a NEW upload+index request lands in the e5 (384-d) space, not v2
 *   - the pre-existing v2 rows from the prior run are byte-for-byte untouched (no migration reversal)
 *   - health is fine, no crash
 *
 *   node scripts/f2llm/acceptance/rollback-check.mjs --secret-file <file> --image <tag>
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { anonKey, GW_PORT, loadSecret, mintJwt, SUPABASE_URL } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const IMAGE = arg("--image", "ysd-f2llm-accept:optin");
const APP_PORT = Number(arg("--app-port", 3102));
const PG_CONTAINER = "ysd-pg-rehearsal";
const NET = "ysd-accept-net";
const APP = "ysd-rollback-app";
const REST = "ysd-rollback-rest";
const REST_PORT = 3002;
const PG_ADMIN_URL = process.env.YSD_PG_URL ?? "postgres://postgres:rehearsal@127.0.0.1:54329/ysd";

const SECRET = loadSecret(arg("--secret-file"));
const ANON = anonKey(SECRET);
const SERVICE = mintJwt(SECRET, { role: "service_role" }, 30 * 86400);
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function sessionCookie(uid) {
  const access = mintJwt(SECRET, { sub: uid, role: "authenticated", email: `${uid}@acceptance.test` }, 86400);
  const session = { access_token: access, refresh_token: "acceptance-refresh", expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, token_type: "bearer", user: { id: uid, aud: "authenticated", role: "authenticated", email: `${uid}@acceptance.test` } };
  return `sb-host-auth-token=${encodeURIComponent(JSON.stringify(session))}`;
}
const COOKIE_A = sessionCookie(USER_A);
const ORIGIN = `http://localhost:${APP_PORT}`;

const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", ...o });
const docker = (...args) => sh("docker", args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `— ${detail}` : "");
}

async function main() {
  // pre-existing v2 row snapshot (checksum), BEFORE touching anything
  const before = docker("exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "ysd", "-t", "-c",
    "select count(*), md5(coalesce(string_agg(id::text || embedding_v2::text, ',' order by id), '')) from file_chunks where embedding_v2 is not null;");
  console.log("pre-existing v2 snapshot:", before.stdout.trim());

  docker("rm", "-f", REST);
  const rest = docker("run", "-d", "--name", REST, "--network", NET, "-p", `${REST_PORT}:3000`,
    "-e", "PGRST_DB_URI=postgres://postgres:rehearsal@pg:5432/ysd", "-e", "PGRST_DB_SCHEMAS=public",
    "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${SECRET}`, "postgrest/postgrest:v12.2.3");
  if (rest.status !== 0) throw new Error("postgrest failed: " + rest.stderr);

  const gateway = spawn(process.execPath, [`${here}/gateway.mjs`], {
    env: { ...process.env, PORT: String(GW_PORT), POSTGREST: `http://127.0.0.1:${REST_PORT}`, JWT_SECRET: SECRET },
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${GW_PORT}/__ping`).then((x) => x.ok).catch(() => false)) break;
    if (i === 39) throw new Error("gateway not ready");
    await sleep(250);
  }

  docker("rm", "-f", APP);
  const env = [
    `NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON}`,
    `SUPABASE_SERVICE_ROLE_KEY=${SERVICE}`,
    "OPENROUTER_API_KEY=sk-or-acceptance-dummy-key-not-a-real-key",
    `APP_ORIGIN=${ORIGIN}`,
    "RATE_LIMIT_HMAC_SECRET=" + "a".repeat(64),
    "RAILWAY_ENVIRONMENT_NAME=production",
    "YSD_RAG_EMBEDDING_MODEL=f2llm-v2-80m",
    // deliberately NOT set: YSD_F2LLM_PRODUCTION_OPT_IN — this is the rollback under test
  ];
  const runArgs = ["run", "-d", "--name", APP, "--memory=524m", "--memory-swap=524m", "-p", `${APP_PORT}:3000`, ...env.flatMap((e) => ["-e", e]), IMAGE];
  const r = docker(...runArgs);
  if (r.status !== 0) throw new Error("app failed to start: " + r.stderr);

  const t0 = Date.now();
  let live = false;
  while (Date.now() - t0 < 60000) {
    live = await fetch(`${ORIGIN}/api/live`).then((x) => x.ok).catch(() => false);
    if (live) break;
    await sleep(500);
  }
  check("app became live after opt-in removed", live, `${Date.now() - t0}ms`);

  const env1 = docker("exec", APP, "sh", "-c",
    "tr '\\0' '\\n' < /proc/1/environ | grep -E '^(MALLOC_|YSD_RAG_EMBEDDING_MODEL|YSD_F2LLM_PRODUCTION_OPT_IN|RAILWAY_ENVIRONMENT_NAME)' | sort").stdout.trim();
  check("no MALLOC_* exported — allocator tuning absent from e5 after rollback", !/MALLOC_/.test(env1), env1.replace(/\n/g, " "));

  const health = await fetch(`${ORIGIN}/api/health`).then((x) => x.status).catch(() => 0);
  check("/api/health reachable after rollback", health === 200 || health === 503, `status ${health}`);

  // a NEW upload + index request must land in e5, not v2
  const fd = new FormData();
  fd.append("file", new Blob([new Array(50).fill("rollback verification paragraph. ").join("")], { type: "text/plain" }), "rollback-check.txt");
  const conv = await fetch(`${ORIGIN}/api/conversations`, { method: "POST", headers: { Cookie: COOKIE_A, Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ title: "rollback" }) }).then((r) => r.json()).catch(() => null);
  const conversationId = conv?.conversation?.id ?? conv?.id;
  check("conversation created for rollback upload", Boolean(conversationId), JSON.stringify(conv));
  fd.append("conversationId", conversationId ?? "");
  const up = await fetch(`${ORIGIN}/api/files/upload`, { method: "POST", headers: { Cookie: COOKIE_A, Origin: ORIGIN }, body: fd }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const fileId = up?.file?.id;
  check("rollback-check.txt uploaded", Boolean(fileId), JSON.stringify(up).slice(0, 200));
  if (fileId) {
    const rag = await fetch(`${ORIGIN}/api/files/${fileId}/rag`, { method: "POST", headers: { Cookie: COOKIE_A, Origin: ORIGIN } }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    check("indexed without error", !rag?.error, JSON.stringify(rag).slice(0, 200));
    await sleep(1000);
    const row = docker("exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "ysd", "-t", "-c",
      `select (embedding is not null) as has_e5, (embedding_v2 is not null) as has_v2 from file_chunks where file_id = '${fileId}' limit 1;`);
    const [hasE5, hasV2] = row.stdout.trim().split("|").map((s) => s.trim());
    check("new chunk landed in e5 (384-d), not v2 — rollback routing correct", hasE5 === "t" && hasV2 === "f", row.stdout.trim());
  }

  const after = docker("exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "ysd", "-t", "-c",
    "select count(*), md5(coalesce(string_agg(id::text || embedding_v2::text, ',' order by id), '')) from file_chunks where embedding_v2 is not null;");
  console.log("post-rollback v2 snapshot:  ", after.stdout.trim());
  check("pre-existing v2 rows byte-identical after rollback (no migration reversal needed)", before.stdout.trim() === after.stdout.trim(), `before=[${before.stdout.trim()}] after=[${after.stdout.trim()}]`);

  const insp = docker("inspect", APP, "--format", "{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}");
  check("no crash/restart/OOM while proving rollback", /^running restarts=0 oom=false/.test(insp.stdout.trim()), insp.stdout.trim());

  docker("rm", "-f", APP, REST);
  gateway.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ROLLBACK CHECK ERROR:", e); docker("rm", "-f", APP, REST); process.exit(1); });
