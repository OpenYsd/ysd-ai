/**
 * Answer-grounding acceptance — ACTUAL streamed answers, through the app's own HTTP routes, for a chosen model.
 *
 *   npx vite-node scripts/reliability/answer-grounding.ts \
 *     --base https://<host> --supabase-url <url> --service-key <key> --anon-key <key> \
 *     --model ysd/model-alpha --state <state.json> --out <report.json> [--retries 1] [--limit N] \
 *     [--acceptance --allow-production-acceptance]
 *
 * ★ What it proves, per question (lib: answer-grounding-lib.ts):
 *   - the answer contains the fact that exists only in the attached file (PASS), or states plainly that the
 *     file does not contain it (PASS_ABSENT) — anything else is FAIL / CHECK_ABSENT (human review);
 *   - a fresh conversation with no files never answers with another conversation's facts (LEAK = failure);
 *   - how the server read the files (metadata.files_scope: mode, failed, rerank) matches the document size.
 * ★ A provider outage is INCONCLUSIVE_PROVIDER, never a pass. Re-asks are bounded (--retries).
 * ★ Production: only with --acceptance --allow-production-acceptance. The only service-role writes are the
 *   synthetic account's invite + claim (as scripts/reliability/file-pipeline-stress.mjs); everything else goes
 *   through the app as that account. Nothing is deleted.
 *
 * Exit: 0 = every case PASS/PASS_ABSENT with the expected retrieval; 1 = any FAIL, LEAK or retrieval failure;
 *       2 = no failure but something needs review (INCONCLUSIVE_PROVIDER / CHECK_ABSENT).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CASES,
  EXPECTED_MODE,
  conversationFiles,
  parseSse,
  refuseReason,
  serviceWriteAllowed,
  verdictFor,
  type ConversationKey,
} from "./answer-grounding-lib";

const argv = process.argv.slice(2);
const arg = (n: string, d: string | null = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const BASE = (arg("--base") ?? "").replace(/\/+$/, "");
const SUPABASE_URL = (arg("--supabase-url") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = arg("--service-key") ?? "";
const ANON_KEY = arg("--anon-key") ?? "";
const MODEL = arg("--model", "ysd/free")!;
const STATE_FILE = arg("--state", ".reliability-out/answer-grounding-state.json")!;
const OUT = arg("--out", ".reliability-out/answer-grounding.json")!;
const RETRIES = Number(arg("--retries", "1"));
const LIMIT = Number(arg("--limit", String(CASES.length)));
const ACCEPTANCE = argv.includes("--acceptance");

const refusal = refuseReason({ base: BASE, supabaseUrl: SUPABASE_URL, acceptance: ACCEPTANCE, allowProductionAcceptance: argv.includes("--allow-production-acceptance") });
if (refusal || !SERVICE_KEY || !ANON_KEY) {
  console.error(`REFUSING: ${refusal ?? "required: --service-key --anon-key"}`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface State {
  user: { userId: string; email: string; password: string } | null;
  conversations: Partial<Record<ConversationKey, { id: string; fileIds: string[] }>>;
}
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { user: null, conversations: {} };
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ------------------------------------------------------------------ service role (reads; invite writes only)
async function rest(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const method = init.method ?? "GET";
  if (!serviceWriteAllowed(ACCEPTANCE, method, path)) throw new Error(`acceptance mode forbids service-role ${method} on ${path.split("?")[0]}`);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      if (!res.ok) throw new Error(`rest ${method} ${path.split("?")[0]} ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function provisionUser(): Promise<NonNullable<State["user"]>> {
  const code = `AGA-${randomUUID().slice(0, 8).toUpperCase()}`;
  await rest("beta_invites", {
    method: "POST",
    body: { code_hash: createHash("sha256").update(code, "utf8").digest("hex"), code_hint: code.slice(-4), label: "answer grounding acceptance", max_uses: 1 },
  });
  const ticket = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const claimed = await rest("rpc/beta_claim_invite", {
    method: "POST",
    body: { p_code: code, p_ticket_hash: createHash("sha256").update(ticket).digest("hex"), p_ttl_seconds: 3600 },
  });
  if (claimed !== true) throw new Error(`claim failed: ${JSON.stringify(claimed)}`);
  const email = `answer.grounding.${Date.now()}@qa-ysd.com`;
  const password = `Agr!${randomUUID().slice(0, 12)}Zx9`;
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { invite_ticket: ticket, terms_accepted: true, display_name: "Answer Grounding" } }),
  });
  if (!created.ok) throw new Error(`admin createUser failed: ${created.status}`);
  const user = (await created.json()) as { id: string };
  return { userId: user.id, email, password };
}

// ------------------------------------------------------------------ app calls as the synthetic account
let COOKIE = "";
let COOKIE_AT = 0;
async function cookie(): Promise<string> {
  if (Date.now() - COOKIE_AT > 20 * 60_000) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: state.user!.email, password: state.user!.password }),
    });
    if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
    const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
    COOKIE = `sb-${ref}-auth-token=${encodeURIComponent(JSON.stringify(await res.json()))}`;
    COOKIE_AT = Date.now();
  }
  return COOKIE;
}
async function api(path: string, init: { method?: string; json?: unknown; form?: FormData; timeoutMs?: number } = {}): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const headers: Record<string, string> = { Cookie: await cookie(), Origin: BASE };
      if (init.json !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        signal: AbortSignal.timeout(init.timeoutMs ?? 180_000),
      });
      const text = await res.text();
      if (res.status === 429 && attempt < 6) {
        const wait = Math.min(Number(res.headers.get("retry-after") ?? 15) || 15, 65);
        log(`  429 on ${path.split("?")[0]} — waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      return { status: res.status, text };
    } catch (err) {
      // uploads are retried with the SAME clientUploadId by the caller's FormData, so the server returns the same row
      if (attempt >= 4) throw err;
      log(`  network error on ${path.split("?")[0]} — retry ${attempt + 1}`);
      await sleep(3000 * (attempt + 1));
    }
  }
}

async function ensureConversation(key: ConversationKey): Promise<{ id: string; fileIds: string[] }> {
  const known = state.conversations[key];
  if (known) return known;
  const conv = JSON.parse((await api("/api/conversations", { method: "POST", json: { title: `answer-grounding ${key}` } })).text) as { conversation?: { id: string }; id?: string };
  const id = conv.conversation?.id ?? conv.id!;
  const fileIds: string[] = [];
  for (const f of conversationFiles(key)) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(f.bytes)], { type: f.mime }), f.name);
    form.append("conversationId", id);
    form.append("clientUploadId", randomUUID());
    const up = await api("/api/files/upload", { method: "POST", form, timeoutMs: 90_000 });
    const row = (JSON.parse(up.text) as { file?: { id: string } }).file;
    if (!row) throw new Error(`upload ${f.name} failed: ${up.status}`);
    fileIds.push(row.id);
  }
  for (const fid of fileIds) {
    for (let t = 0; ; t++) {
      const [row] = (await rest(`files?id=eq.${fid}&select=status`)) as Array<{ status: string }>;
      if (row?.status === "ready_for_rag") break;
      if (row?.status === "failed" || row?.status === "rag_failed" || t > 80) throw new Error(`file ${fid.slice(0, 8)} not ready: ${row?.status}`);
      await sleep(3000);
    }
  }
  state.conversations[key] = { id, fileIds };
  saveState();
  log(`conversation ${key} ${id.slice(0, 8)} ready with ${fileIds.length} file(s)`);
  return state.conversations[key]!;
}

interface Meta {
  files_scope?: { mode?: string; failed?: boolean; retrieved?: number; top_similarity?: number | null; rerank?: Record<string, unknown> };
  completion?: { status?: string };
  actual_model?: string;
  sources?: unknown[];
}
async function ask(conversationId: string, q: string) {
  const latest = async () =>
    ((await rest(`messages?conversation_id=eq.${conversationId}&role=eq.assistant&deleted_at=is.null&order=created_at.desc&limit=1&select=id,metadata`)) as Array<{ id: string; metadata: Meta }>)[0] ?? null;
  const prior = await latest();
  const t0 = Date.now();
  const res = await api("/api/chat", { method: "POST", json: { conversationId, message: q, modelId: MODEL } });
  const { text } = parseSse(res.text);
  const row = await latest();
  const meta = row && row.id !== prior?.id ? row.metadata : null;
  return { status: res.status, ms: Date.now() - t0, text: text.trim(), meta };
}

// ------------------------------------------------------------------ run
if (!state.user) {
  state.user = await provisionUser();
  saveState();
  log(`synthetic account ${state.user.userId.slice(0, 8)} created`);
}
const results = [];
for (const c of CASES.slice(0, LIMIT)) {
  const conv = await ensureConversation(c.conversation);
  let r = await ask(conv.id, c.q);
  const attempts = [r.meta?.completion?.status ?? `http_${r.status}`];
  for (let k = 0; k < RETRIES && verdictFor(c, { status: r.status, text: r.text, completion: r.meta?.completion?.status ?? null }) === "INCONCLUSIVE_PROVIDER"; k++) {
    await sleep(15_000);
    r = await ask(conv.id, c.q);
    attempts.push(r.meta?.completion?.status ?? `http_${r.status}`);
  }
  const verdict = verdictFor(c, { status: r.status, text: r.text, completion: r.meta?.completion?.status ?? null });
  const scope = r.meta?.files_scope ?? null;
  const retrievalOk =
    verdict === "INCONCLUSIVE_PROVIDER" && !scope
      ? null
      : Boolean(scope && scope.failed === false && scope.mode === EXPECTED_MODE[c.conversation] && (EXPECTED_MODE[c.conversation] !== "search" || scope.rerank));
  results.push({ conversation: c.conversation, question: c.q, verdict, retrievalOk, attempts, ms: r.ms, model: r.meta?.actual_model ?? null, scope, answer: r.text });
  log(`${verdict.padEnd(21)} retrieval=${retrievalOk} ${c.conversation.padEnd(5)} ${r.ms}ms ${JSON.stringify(scope)} | ${c.q}`);
  log(`    A: ${r.text.slice(0, 300).replace(/\n/g, " ⏎ ")}`);
}
const tally = results.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
const retrievalFailures = results.filter((r) => r.retrievalOk === false).length;
writeFileSync(OUT, JSON.stringify({ model: MODEL, base: BASE, at: new Date().toISOString(), tally, retrievalFailures, results }, null, 2));
log(`TALLY ${JSON.stringify(tally)} retrieval_failures=${retrievalFailures} → ${OUT}`);
const failed = (tally.FAIL ?? 0) + (tally.LEAK ?? 0) + retrievalFailures > 0;
const review = (tally.INCONCLUSIVE_PROVIDER ?? 0) + (tally.CHECK_ABSENT ?? 0) > 0;
process.exit(failed ? 1 : review ? 2 : 0);
