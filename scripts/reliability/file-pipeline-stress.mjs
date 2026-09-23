#!/usr/bin/env node
/**
 * ضغطٌ متكرّر على مسار الملفات — 30 دورة على بيئةٍ منشورة (staging).
 *
 *   node scripts/reliability/file-pipeline-stress.mjs \
 *     --base https://<staging-host> --supabase-url <url> --service-key <key> \
 *     [--cycles 30] [--out <dir>]
 *
 * ★ لماذا لا نقيس نصَّ الردّ.
 *
 *   «قال المساعدُ إنه لا يرى ملفًا» عرَضٌ لا سبب، ونصُّ النموذج غير حتميّ
 *   (ومزوّد staging المجاني يسقط أحيانًا). فالمقيس هنا هو الثابتُ الخادميّ
 *   الذي يُنتج ذلك العرَض:
 *
 *     ملفٌّ موجودٌ ومربوطٌ بالمحادثة يجب أن يقع في **إحدى** القائمتين:
 *     جاهزٍ أو معلَّق. وسقوطُه من كلتيهما هو بعينه ما يجعل المسار يتخطّى
 *     الاسترجاع ويجيب النموذجُ بالنفي.
 *
 * ★ والحقيقةُ من الخادم لا من العميل: كلُّ تأكيدٍ يُقرأ من قاعدة البيانات
 *   أو من واجهةٍ يُصدرها الخادم — لا من حالةٍ يحتفظ بها هذا السكربت.
 */
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const BASE = (arg("--base") ?? "").replace(/\/+$/, "");
const SUPABASE_URL = (arg("--supabase-url") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = arg("--service-key");
const ANON_KEY = arg("--anon-key");
const CYCLES = Number(arg("--cycles", "30"));
const OUT = resolve(arg("--out", ".reliability-out"));
const READY_TIMEOUT_MS = Number(arg("--ready-timeout-ms", "180000"));
if (!BASE || !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error("required: --base --supabase-url --service-key --anon-key");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** كلُّ خرقٍ لثابتٍ يُسجَّل هنا — الحكم في النهاية من هذه القائمة وحدها */
const violations = [];
const violate = (kind, detail) => {
  violations.push({ kind, detail, at: new Date().toISOString() });
  log("VIOLATION", kind, JSON.stringify(detail).slice(0, 300));
};
const counters = {
  cycles: 0,
  uploads: 0,
  filesCreated: 0,
  reachedReady: 0,
  immediateQuestions: 0,
  questionsAfterReady: 0,
  reloadChecks: 0,
  retryCycles: 0,
};

// ------------------------------------------------------------------ supabase
async function sql(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_reliability_sql`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query }),
  });
  if (!res.ok) throw new Error(`sql rpc failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
/** قراءةٌ مباشرة عبر PostgREST (بلا RPC مخصّص) */
async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`rest failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ------------------------------------------------------------------ auth
async function provisionUser() {
  const code = `REL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  const inv = await fetch(`${SUPABASE_URL}/rest/v1/beta_invites`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ code_hash: hash, code_hint: code.slice(-4), label: "file pipeline stress", max_uses: 1 }),
  });
  if (!inv.ok) throw new Error(`invite insert failed: ${await inv.text()}`);

  const ticket = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const ticketHash = createHash("sha256").update(ticket).digest("hex");
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/beta_claim_invite`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: code, p_ticket_hash: ticketHash, p_ttl_seconds: 3600 }),
  });
  const claimed = await rpc.text();
  if (!rpc.ok || claimed.trim() !== "true") throw new Error(`claim failed: ${claimed}`);

  const email = `rel.stress.${Date.now()}@qa-ysd.com`;
  const password = `Rel!${randomUUID().slice(0, 12)}Zx9`;
  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { invite_ticket: ticket, terms_accepted: true, display_name: "Reliability Stress" },
    }),
  });
  if (!created.ok) throw new Error(`admin createUser failed: ${await created.text()}`);
  const user = await created.json();

  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${await signIn.text()}`);
  const session = await signIn.json();
  /**
   * ★ اسمُ الكعكة يُشتقّ من مرجع المشروع لا يُكتب يدويًّا.
   *
   * `@supabase/ssr` يقرأ `sb-<ref>-auth-token`؛ وكتابةُ اسمٍ ثابت (مأخوذٍ من
   * مكدّسٍ محلّيّ كان مضيفُه `host`) تجعل الخادم لا يرى جلسةً أصلًا فيردّ
   * `auth_expired` — وهو عطبُ أداةٍ لا عطبُ منتَج.
   */
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const cookie = `sb-${ref}-auth-token=${encodeURIComponent(JSON.stringify(session))}`;
  return { userId: user.id, cookie };
}

// ------------------------------------------------------------------ app calls
function makeApi(cookie) {
  return async function api(path, { method = "GET", body, headers = {} } = {}) {
    const h = { Cookie: cookie, Origin: BASE, ...headers };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      payload = JSON.stringify(body);
      h["Content-Type"] = "application/json";
    }
    const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* stream */
    }
    return { status: res.status, json, text };
  };
}

// ------------------------------------------------------------------ fixtures
/** PDF صغير صالح — يُبنى يدويًّا فلا اعتماد على مكتبة */
function tinyPdf(phrase) {
  const content = `BT /F1 12 Tf 60 700 Td (${phrase}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => (out += `${String(o).padStart(10, "0")} 00000 n \n`));
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const LOREM_EN =
  "The quarterly reliability review covers upload durability, indexing latency and retrieval scope. " +
  "Every attachment must be reconciled against server state before the assistant is allowed to answer about it. ";
const LOREM_AR =
  "تغطي مراجعة الموثوقية الفصلية متانة الرفع وزمن الفهرسة ونطاق الاسترجاع. " +
  "يجب التحقق من كل مرفق مقابل حالة الخادم قبل السماح للمساعد بالإجابة عنه. ";

function fixture(kind, secret) {
  switch (kind) {
    case "pdf":
      return { name: "reliability-report.pdf", mime: "application/pdf", bytes: tinyPdf(`RELIABILITY SECRET ${secret}`) };
    case "pdf-ar":
      return { name: "تقرير-الموثوقية.pdf", mime: "application/pdf", bytes: tinyPdf(`RELIABILITY SECRET ${secret}`) };
    case "txt":
      return {
        name: "reliability-notes.txt",
        mime: "text/plain",
        bytes: Buffer.from(`${LOREM_EN.repeat(4)}\nThe verification secret is ${secret}.\n`, "utf8"),
      };
    case "txt-ar":
      return {
        name: "ملاحظات-الموثوقية.txt",
        mime: "text/plain",
        bytes: Buffer.from(`${LOREM_AR.repeat(4)}\nالعبارة السرية للتحقق هي ${secret}.\n`, "utf8"),
      };
    case "md":
      return {
        name: "reliability-spec.md",
        mime: "text/markdown",
        bytes: Buffer.from(`# Reliability\n\n${LOREM_EN.repeat(3)}\n\n## Secret\n\nThe verification secret is ${secret}.\n`, "utf8"),
      };
    default:
      throw new Error(`unknown fixture ${kind}`);
  }
}

/** مصفوفة الدورات: كلُّ ما طُلب إثباتُه، موزَّعًا دوريًّا */
const SCENARIOS = [
  { kind: "txt", ask: "after-ready", files: 1 },
  { kind: "pdf", ask: "immediate", files: 1 },
  { kind: "md", ask: "after-ready", files: 1 },
  { kind: "txt-ar", ask: "immediate", files: 1, reloadDuringProcessing: true },
  { kind: "pdf-ar", ask: "after-ready", files: 1 },
  { kind: "txt", ask: "after-ready", files: 2 },
  { kind: "md", ask: "immediate", files: 1, retry: true },
  { kind: "txt-ar", ask: "after-ready", files: 1 },
  { kind: "pdf", ask: "after-ready", files: 1, reloadDuringProcessing: true },
  { kind: "txt", ask: "immediate", files: 2, retry: true },
];

// ------------------------------------------------------------------ invariants
/**
 * الثابت الأهمّ: ملفٌّ مربوطٌ بالمحادثة لا يسقط من نطاقها.
 *
 * يُقرأ نطاقُ المحادثة كما يراه الخادمُ نفسه عبر `GET /api/files?conversationId=`
 * (مصدرُ الحقيقة الذي تعيد الواجهةُ بناءَ حالتها منه بعد أي إعادة تحميل).
 */
async function assertFileInConversationScope(api, { fileId, conversationId, phase }) {
  const list = await api(`/api/files?conversationId=${conversationId}`);
  if (list.status !== 200) {
    violate("scope_query_failed", { fileId, conversationId, status: list.status, phase });
    return null;
  }
  const rows = list.json?.files ?? list.json ?? [];
  const found = Array.isArray(rows) ? rows.find((f) => f.id === fileId) : null;
  if (!found) {
    violate("file_missing_from_conversation_scope", { fileId, conversationId, phase, returned: Array.isArray(rows) ? rows.length : -1 });
    return null;
  }
  if (found.conversation_id && found.conversation_id !== conversationId) {
    violate("conversation_link_mismatch", { fileId, expected: conversationId, actual: found.conversation_id, phase });
  }
  return found;
}

/** لا ملفَّ يُعلن جاهزًا بينما مقاطعُه غير قابلةٍ للاسترجاع في الفضاء الفعّال */
async function assertNoFalseReady(fileId) {
  const rows = await rest(`files?id=eq.${fileId}&select=id,status,rag_v2_model`);
  const f = rows[0];
  if (!f) {
    violate("file_row_vanished", { fileId });
    return;
  }
  if (f.status !== "ready_for_rag") return;
  const chunks = await rest(`file_chunks?file_id=eq.${fileId}&select=id,embedding_v2,embedding&limit=1`);
  if (chunks.length === 0) {
    violate("false_ready_no_chunks", { fileId, status: f.status });
    return;
  }
  // الفضاء الفعّال في staging هو F2LLM: الجاهز يجب أن يحمل وسمَ النموذج ومتجهَ v2
  if (f.rag_v2_model) {
    const hasV2 = chunks.some((c) => c.embedding_v2 !== null);
    if (!hasV2) violate("false_ready_tagged_without_vectors", { fileId, rag_v2_model: f.rag_v2_model });
  }
}

/** لا صفوفَ مكرّرة لنفس الرفع المنطقيّ */
async function assertNoDuplicates(userId, clientUploadId) {
  const rows = await rest(
    `files?user_id=eq.${userId}&deleted_at=is.null&metadata->>client_upload_id=eq.${clientUploadId}&select=id`,
  );
  if (rows.length > 1) violate("duplicate_file_rows", { clientUploadId, count: rows.length, ids: rows.map((r) => r.id) });
  return rows.length;
}

async function waitForReady(fileId, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const rows = await rest(`files?id=eq.${fileId}&select=status,rag_v2_model`);
    last = rows[0]?.status ?? null;
    if (last === "ready_for_rag") return { ready: true, status: last, ms: Date.now() - t0 };
    if (last === "failed" || last === "rag_failed") return { ready: false, status: last, ms: Date.now() - t0 };
    await sleep(2000);
  }
  return { ready: false, status: last, ms: Date.now() - t0, timedOut: true };
}

// ------------------------------------------------------------------ cycle
async function runCycle(api, userId, n) {
  const scenario = SCENARIOS[n % SCENARIOS.length];
  const secret = `RS-${n}-${randomUUID().slice(0, 6).toUpperCase()}`;
  log(`cycle ${n + 1}/${CYCLES}`, JSON.stringify(scenario), secret);
  counters.cycles++;

  const conv = await api("/api/conversations", { method: "POST", body: { title: `stress ${n + 1}` } });
  const conversationId = conv.json?.conversation?.id ?? conv.json?.id;
  if (!conversationId) {
    violate("conversation_create_failed", { cycle: n, status: conv.status, body: conv.text?.slice(0, 200) });
    return;
  }

  const uploaded = [];
  for (let i = 0; i < scenario.files; i++) {
    const fx = fixture(scenario.kind, `${secret}-${i}`);
    const clientUploadId = randomUUID();
    const fd = new FormData();
    fd.append("file", new Blob([fx.bytes], { type: fx.mime }), fx.name);
    fd.append("conversationId", conversationId);
    fd.append("clientUploadId", clientUploadId);
    counters.uploads++;
    const up = await api("/api/files/upload", { method: "POST", body: fd });
    if (up.status !== 201 && up.status !== 200) {
      violate("upload_failed", { cycle: n, name: fx.name, status: up.status, body: up.text?.slice(0, 200) });
      continue;
    }
    const fileId = up.json?.file?.id;
    if (!fileId) {
      violate("upload_returned_no_file", { cycle: n, status: up.status });
      continue;
    }
    counters.filesCreated++;
    uploaded.push({ fileId, clientUploadId, name: fx.name, secret: `${secret}-${i}` });

    // إعادةُ الرفع بالمعرّف نفسه: يجب أن يُعاد الملفُّ القائم لا صفٌّ ثانٍ
    if (scenario.retry) {
      counters.retryCycles++;
      const fd2 = new FormData();
      fd2.append("file", new Blob([fx.bytes], { type: fx.mime }), fx.name);
      fd2.append("conversationId", conversationId);
      fd2.append("clientUploadId", clientUploadId);
      const again = await api("/api/files/upload", { method: "POST", body: fd2 });
      if (again.json?.file?.id !== fileId) {
        violate("retry_created_new_row", { cycle: n, first: fileId, second: again.json?.file?.id, status: again.status });
      }
      await assertNoDuplicates(userId, clientUploadId);
    }

    // الملفُّ مربوطٌ بالمحادثة فورَ الرفع — قبل أي فهرسة
    await assertFileInConversationScope(api, { fileId, conversationId, phase: "after-upload" });
  }
  if (uploaded.length === 0) return;

  // إعادةُ تحميلٍ أثناء التجهيز: الحالة تُستعاد من الخادم لا من ذاكرة العميل
  if (scenario.reloadDuringProcessing) {
    counters.reloadChecks++;
    await sleep(1200);
    for (const u of uploaded) {
      await assertFileInConversationScope(api, { fileId: u.fileId, conversationId, phase: "reload-during-processing" });
    }
  }

  // سؤالٌ فوريّ قبل الجاهزية: يجب ألّا يسقط الملفُّ من النطاق
  if (scenario.ask === "immediate") {
    counters.immediateQuestions++;
    for (const u of uploaded) {
      await assertFileInConversationScope(api, { fileId: u.fileId, conversationId, phase: "immediate-question" });
    }
    const chat = await api("/api/chat", {
      method: "POST",
      body: { conversationId, message: `ما العبارة السرية في الملف؟ / what is the secret phrase?`, modelId: "ysd/free" },
    });
    if (chat.status !== 200) {
      // فشلُ المزوّد ليس خرقًا لثابتِ الملفات — يُسجَّل ولا يُحتسب
      log(`  chat(immediate) provider status=${chat.status}`);
    }
  }

  // الانتظار حتى الجاهزية، ثم إثباتُ الاسترجاع فعلًا
  for (const u of uploaded) {
    const res = await waitForReady(u.fileId, READY_TIMEOUT_MS);
    if (!res.ready) {
      violate("never_reached_ready", { cycle: n, fileId: u.fileId, name: u.name, lastStatus: res.status, ms: res.ms, timedOut: Boolean(res.timedOut) });
      continue;
    }
    counters.reachedReady++;
    await assertNoFalseReady(u.fileId);
    await assertFileInConversationScope(api, { fileId: u.fileId, conversationId, phase: "after-ready" });
  }

  if (scenario.ask === "after-ready") {
    counters.questionsAfterReady++;
    for (const u of uploaded) {
      const rows = await rest(`file_chunks?file_id=eq.${u.fileId}&select=id&limit=1`);
      if (rows.length === 0) violate("ready_without_retrievable_chunks", { fileId: u.fileId, name: u.name });
    }
    const chat = await api("/api/chat", {
      method: "POST",
      body: { conversationId, message: `ما العبارة السرية في الملف؟ / what is the secret phrase?`, modelId: "ysd/free" },
    });
    if (chat.status !== 200) log(`  chat(after-ready) provider status=${chat.status}`);
  }
}

// ------------------------------------------------------------------ main
async function main() {
  log("provisioning user...");
  const { userId, cookie } = await provisionUser();
  const api = makeApi(cookie);
  log("user", userId);

  const live = await api("/api/live");
  if (live.status !== 200) throw new Error(`target not live: ${live.status}`);

  for (let n = 0; n < CYCLES; n++) {
    try {
      await runCycle(api, userId, n);
    } catch (err) {
      violate("cycle_threw", { cycle: n, error: String(err?.message ?? err).slice(0, 300) });
    }
  }

  // فحصٌ ختاميّ شامل على كل ما أنشأه هذا التشغيل
  const all = await rest(`files?user_id=eq.${userId}&deleted_at=is.null&select=id,status,conversation_id,rag_v2_model`);
  const lost = all.filter((f) => f.conversation_id === null);
  if (lost.length > 0) violate("files_lost_conversation_link", { count: lost.length, ids: lost.map((f) => f.id).slice(0, 10) });
  const notReady = all.filter((f) => f.status !== "ready_for_rag");
  if (notReady.length > 0) {
    violate("files_never_became_ready", {
      count: notReady.length,
      sample: notReady.slice(0, 10).map((f) => ({ id: f.id, status: f.status })),
    });
  }

  const summary = {
    target: BASE,
    startedAt: new Date().toISOString(),
    cycles: CYCLES,
    counters,
    filesCreatedTotal: all.length,
    violations,
    verdict: violations.length === 0 ? "RELIABLE" : "BROKEN",
  };
  writeFileSync(resolve(OUT, "file-pipeline-stress.json"), JSON.stringify(summary, null, 2));
  log("=== SUMMARY ===");
  log(JSON.stringify({ ...summary, violations: violations.length }, null, 1));
  if (violations.length > 0) {
    log(`${violations.length} violation(s):`);
    for (const v of violations.slice(0, 40)) log(" -", v.kind, JSON.stringify(v.detail).slice(0, 200));
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("STRESS HARNESS ERROR:", e);
  process.exit(2);
});
