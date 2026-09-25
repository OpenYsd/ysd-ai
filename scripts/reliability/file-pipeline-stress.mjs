#!/usr/bin/env node
/**
 * ضغطٌ على مسار الملفات — ≥50 دورة على staging، على ثلاث مراحل عبر انتقالَي الفضاء.
 *
 *   node scripts/reliability/file-pipeline-stress.mjs --phase 1 \
 *     --base https://<staging-host> --supabase-url <url> --service-key <key> --anon-key <key> \
 *     --space f2llm|e5 --state <file.json> [--cycles N] [--out <dir>]
 *
 *   المرحلة 1: الفضاءُ الأوّل — دوراتٌ عاديّة تغطّي كلَّ السيناريوهات.
 *   (يُقلب فضاءُ staging خارج هذا السكربت)
 *   المرحلة 2: الفضاءُ الثاني — إثباتُ الانتقال على ملفّات المرحلة 1، ثمّ دوراتٌ عاديّة.
 *   (يُقلب مرّةً أخرى)
 *   المرحلة 3: الفضاءُ الأوّل من جديد — الانتقالُ المعاكس على ملفّات المرحلة 2،
 *     وملفّاتُ المرحلة 1 جاهزةٌ فورًا (متجهاتُها القديمة لم تُمسّ)، ثمّ الفحصُ الختاميّ.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا أُعيدت كتابةُ هذه الأداة.
 *
 *  نسختُها السابقة قاست نطاقَ `/api/files?conversationId=` — لا نطاقَ مسار
 *  المحادثة. فحين صار استعلامُ نطاق المحادثة يسقط في كلّ نداء (قيمةُ حالةٍ
 *  خارج النوع ⇒ 400 ⇒ «لا ملفات») أعلنت الأداةُ 30 دورةً بلا خرق. أداةٌ لا
 *  تقيس المسارَ الذي يعطب لا تثبت شيئًا عنه.
 *
 *  الآن: كلُّ سؤالٍ يُقرأ أثرُه من رسالة المساعد المحفوظة نفسِها —
 *  `metadata.files_scope` (ما رآه الخادمُ جاهزًا/معلَّقًا لحظةَ الردّ) و
 *  `metadata.sources` (ما استُرجع فعلًا). بلا قراءةِ نصّ النموذج: المزوّدُ
 *  المجانيّ قد يسقط، والاسترجاعُ يسبقه ويُحفظ على كلّ حال.
 * ══════════════════════════════════════════════════════════════════
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const PHASE = Number(arg("--phase", "1"));
const SPACE = arg("--space"); // "f2llm" | "e5" — الفضاءُ الذي يُفترض أن staging يعمل به الآن
const STATE_FILE = resolve(arg("--state", ".reliability-out/state.json"));
const CYCLES = Number(arg("--cycles", "24"));
const OUT = resolve(arg("--out", ".reliability-out"));
const READY_TIMEOUT_MS = Number(arg("--ready-timeout-ms", "240000"));
/** عددُ ملفّاتٍ تُعاد إلى حال «e5 وحده» قبل الانتقال (كملفّات الإنتاج القديمة) */
const MAKE_E5_ONLY = Number(arg("--make-e5-only", "0"));
/** ملفّاتٌ تُترك كما هي لأنها حالٌ حيٌّ يُختبر بذاته (مثل: عالقٌ على embedding) */
const KEEP = new Set((arg("--keep", "") ?? "").split(",").filter(Boolean));
/**
 * ★ وضعُ القبول (الإنتاج): واجهاتُ التطبيق وحدها.
 *   لا إرجاعَ صفوفٍ مباشر، ولا ترقيةَ باقة، ولا كتابةَ بمفتاح الخدمة إلا إنشاءُ
 *   الحساب الاصطناعيّ (دعوة + مطالبة). الباقةُ المجانيّة تكفيه (≈14 ملفًّا، ≈15 سؤالًا).
 */
const ACCEPTANCE = argv.includes("--acceptance");
const ALLOW_PRODUCTION_ACCEPTANCE = argv.includes("--allow-production-acceptance");
const F2LLM_TAG = "f2llm-v2-80m@ad88d7a1.onnx-fcd9084eb3f4";
const PRODUCTION_REF = "mnewsldyrrlpmouetyve";

if (!BASE || !SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !["e5", "f2llm"].includes(SPACE)) {
  console.error("required: --base --supabase-url --service-key --anon-key --space e5|f2llm");
  process.exit(2);
}
/**
 * ★ الإنتاجُ ممنوعٌ إلّا بوضع القبول وبإذنٍ صريحٍ في سطر الأوامر معًا.
 *   ووضعُ الضغط الكامل (يُرجع صفوفًا ويرقّي الباقة) لـstaging وحده.
 */
const TARGETS_PRODUCTION = SUPABASE_URL.includes(PRODUCTION_REF);
if (TARGETS_PRODUCTION && !(ACCEPTANCE && ALLOW_PRODUCTION_ACCEPTANCE)) {
  console.error("REFUSING: production requires --acceptance --allow-production-acceptance");
  process.exit(2);
}
if (!TARGETS_PRODUCTION && !ACCEPTANCE && !/staging/i.test(BASE)) {
  console.error("REFUSING: the full stress mode runs against staging only");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------ state
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { user: null, conversations: [], files: [], phases: {} };
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

/** كلُّ خرقٍ لثابتٍ يُسجَّل هنا — الحكمُ من هذه القائمة وحدها */
const violations = [];
const violate = (kind, detail) => {
  violations.push({ kind, detail, phase: PHASE, at: new Date().toISOString() });
  log("VIOLATION", kind, JSON.stringify(detail).slice(0, 300));
};
const counters = {
  cycles: 0,
  uploads: 0,
  filesCreated: 0,
  reachedReady: 0,
  immediateQuestions: 0,
  questionsAfterReady: 0,
  retrievalHits: 0,
  reloadChecks: 0,
  retryReplays: 0,
  freshRepicks: 0,
  sameNameDifferentBytes: 0,
  conversationSwitches: 0,
  orphanRelinks: 0,
  abandonedClients: 0,
  staleJobRecoveries: 0,
  staleExtractionRecoveries: 0,
  strandedReadyRecoveries: 0,
  transitionChecks: 0,
  nonDestructiveChecks: 0,
  leakageProbes: 0,
  chatUnmeasured: 0,
  providerFailures: 0,
  /** طلباتٌ ضاع ردُّها في الشبكة فصالحها العميلُ كما يصالحها المتصفّح */
  networkReconciles: 0,
  networkRetries: 0,
};

/** خطأُ نقلٍ بلا ردّ HTTP (انقطاع، مهلةُ اتصال) — غيرُ خطأ الخادم */
const isNetworkError = (err) => err?.name === "TypeError" && /fetch failed/i.test(String(err?.message));

// ------------------------------------------------------------------ supabase (service, staging only)
const ACCEPTANCE_WRITES = [/^beta_invites$/, /^rpc\/beta_claim_invite$/];
async function rest(path, { method = "GET", body, prefer } = {}) {
  if (ACCEPTANCE && method !== "GET" && !ACCEPTANCE_WRITES.some((re) => re.test(path.split("?")[0]))) {
    throw new Error(`acceptance mode forbids service-role ${method} on ${path.split("?")[0]}`);
  }
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  if (body) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      break;
    } catch (err) {
      if (!isNetworkError(err) || attempt >= 4) throw err;
      counters.networkRetries++;
      await sleep(2000 * (attempt + 1));
    }
  }
  if (!res.ok) throw new Error(`rest ${method} ${path.split("?")[0]} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------ auth
async function provisionUser() {
  const code = `REL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  await rest("beta_invites", {
    method: "POST",
    body: { code_hash: hash, code_hint: code.slice(-4), label: "file pipeline stress", max_uses: 1 },
    prefer: "return=representation",
  });
  const ticket = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const ticketHash = createHash("sha256").update(ticket).digest("hex");
  const claimed = await rest("rpc/beta_claim_invite", {
    method: "POST",
    body: { p_code: code, p_ticket_hash: ticketHash, p_ttl_seconds: 3600 },
  });
  if (claimed !== true) throw new Error(`claim failed: ${JSON.stringify(claimed)}`);

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
  /**
   * ★ باقةُ pro لمستخدم الأداة وحده (staging): الباقةُ المجانيّة تسمح بخمسين ملفًّا
   *   وخمسين رسالةً في اليوم، والتشغيلُ يحتاج قرابةَ ضعفَيهما. رفضُ الحصّة ليس
   *   عطلًا في مسار الملفات، فلا يُترك يتنكّر في صورته.
   */
  if (!ACCEPTANCE) await rest(`subscriptions?user_id=eq.${user.id}`, { method: "PATCH", body: { tier: "pro" } });
  return { userId: user.id, email, password };
}

async function signIn({ email, password }) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${await res.text()}`);
  const session = await res.json();
  // `@supabase/ssr` يقرأ `sb-<ref>-auth-token` — الاسمُ يُشتقّ من المرجع لا يُكتب
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  return `sb-${ref}-auth-token=${encodeURIComponent(JSON.stringify(session))}`;
}

// ------------------------------------------------------------------ app calls
let COOKIE = "";
let COOKIE_AT = 0;
/** رمزُ الوصول يعيش ساعة، والمرحلةُ قد تطول: يُجدَّد كلَّ عشرين دقيقة */
async function freshCookie() {
  if (Date.now() - COOKIE_AT > 20 * 60_000) {
    COOKIE = await signIn(state.user);
    COOKIE_AT = Date.now();
  }
}
/**
 * ★ 429 يُحترم كما يحترمه العميلُ الحقيقيّ: انتظارُ Retry-After ثمّ إعادة.
 *   حدُّ الرفع عشرٌ في الدقيقة، والمحادثةُ عشرون — والأداةُ أسرعُ من إنسان.
 */
async function api(path, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await apiOnce(path, opts);
    } catch (err) {
      const isUpload = path.startsWith("/api/files/upload");
      if (!isNetworkError(err) || isUpload || attempt >= 4) throw err;
      counters.networkRetries++;
      log(`  network error on ${path.split("?")[0]} — retry ${attempt + 1}`);
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status !== 429 || attempt >= 6) return res;
    const wait = Math.min(Number(res.retryAfter ?? 15) || 15, 65);
    log(`  429 on ${path.split("?")[0]} — waiting ${wait}s`);
    await sleep(wait * 1000);
  }
}

async function apiOnce(path, { method = "GET", body } = {}) {
  await freshCookie();
  const h = { Cookie: COOKIE, Origin: BASE };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    payload = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(180000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* stream */
  }
  return { status: res.status, json, text, retryAfter: res.headers.get("retry-after") };
}

async function createConversation(title) {
  const conv = await api("/api/conversations", { method: "POST", body: { title } });
  const id = conv.json?.conversation?.id ?? conv.json?.id;
  if (!id) throw new Error(`conversation create failed ${conv.status}: ${conv.text?.slice(0, 160)}`);
  state.conversations.push({ id, phase: PHASE, title });
  return id;
}

async function upload({ conversationId, fx, clientUploadId }) {
  const send = () => {
    const fd = new FormData();
    fd.append("file", new Blob([fx.bytes], { type: fx.mime }), fx.name);
    if (conversationId) fd.append("conversationId", conversationId);
    if (clientUploadId) fd.append("clientUploadId", clientUploadId);
    return api("/api/files/upload", { method: "POST", body: fd });
  };
  counters.uploads++;
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isNetworkError(err) || !clientUploadId || attempt >= 3) throw err;
      /**
       * ★ ردٌّ ضاع في الشبكة: يُسأل الخادمُ عمّا حفظه بالمعرّف نفسه — كما يفعل المتصفّح.
       *   وجده ⇒ هو الملف؛ لم يجده ⇒ يُعاد الرفعُ بالمعرّف نفسه (والخادمُ لا يكرّر).
       */
      counters.networkReconciles++;
      log(`  upload response lost (${fx.name}) — reconciling by clientUploadId`);
      for (let probe = 0; probe < 5; probe++) {
        await sleep(2000 * (probe + 1));
        const r = await api(`/api/files?clientUploadId=${encodeURIComponent(clientUploadId)}`);
        const row = (r.json?.files ?? [])[0];
        if (r.status === 200 && row) return { status: 200, json: { file: row, reused: true, reconciled: true }, text: "" };
      }
    }
  }
}

/**
 * سؤالٌ في محادثة، ثمّ قراءةُ أثره من رسالة المساعد المحفوظة.
 * `files_scope` يُكتب على كلّ ردّ — ولو كان إشعارَ فشل مزوّد.
 */
async function ask(conversationId, question) {
  const latest = async () =>
    (await rest(
      `messages?conversation_id=eq.${conversationId}&role=eq.assistant&deleted_at=is.null&order=created_at.desc&limit=1&select=id,metadata`,
    ))?.[0] ?? null;
  // المعرّفُ لا الساعة: فارقُ الساعات بين هذا الجهاز والقاعدة لا يُضيّع ردًّا
  const prior = await latest();
  const res = await api("/api/chat", {
    method: "POST",
    body: { conversationId, message: question, modelId: "ysd/free" },
  });
  const row = await latest();
  const meta = row && row.id !== prior?.id ? row.metadata : null;
  if (meta?.completion?.status === "incomplete_provider") counters.providerFailures++;
  return {
    status: res.status,
    scope: meta?.files_scope ?? null,
    sources: Array.isArray(meta?.sources) ? meta.sources.map((s) => s.fileId) : [],
  };
}

// ------------------------------------------------------------------ fixtures
/** PDF صغير صالح — يُبنى يدويًّا فلا اعتماد على مكتبة (نصٌّ لاتينيٌّ فقط: Helvetica) */
function tinyPdf(sentence) {
  const content = `BT /F1 12 Tf 60 700 Td (${sentence}) Tj ET`;
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

/**
 * ★ السؤالُ يكاد يطابق جملةً في الملف: هذا اختبارُ مسار، لا اختبارُ صلة.
 *   عتبةُ الثقة (0.80 في e5) تُسقط سؤالًا بعيدَ الصياغة — وذلك سلوكٌ صحيح
 *   لا عطل. فتُصاغ الجملةُ والسؤالُ متقاربين كي يقيس «لم يُسترجع» عطلًا حقًّا.
 */
function fixture(kind, secret, nameOverride) {
  const en = `The verification code of the reliability report is ${secret}.`;
  const ar = `رمز التحقق في تقرير الموثوقية هو ${secret}.`;
  const q = { en: "What is the verification code of the reliability report?", ar: "ما رمز التحقق في تقرير الموثوقية؟" };
  const pick = (name, mime, bytes, lang) => ({ name: nameOverride ?? name, mime, bytes, question: q[lang] });
  switch (kind) {
    case "pdf":
      return pick("reliability-report.pdf", "application/pdf", tinyPdf(en), "en");
    case "pdf-ar":
      return pick("تقرير-الموثوقية.pdf", "application/pdf", tinyPdf(en), "en");
    case "txt":
      return pick("reliability-notes.txt", "text/plain", Buffer.from(`${en}\n`, "utf8"), "en");
    case "txt-ar":
      return pick("ملاحظات-الموثوقية.txt", "text/plain", Buffer.from(`${ar}\n`, "utf8"), "ar");
    case "md":
      return pick("reliability-spec.md", "text/markdown", Buffer.from(`# Reliability\n\n${en}\n`, "utf8"), "en");
    case "md-ar":
      return pick("مواصفة-الموثوقية.md", "text/markdown", Buffer.from(`# الموثوقية\n\n${ar}\n`, "utf8"), "ar");
    default:
      throw new Error(`unknown fixture ${kind}`);
  }
}

// ------------------------------------------------------------------ server truth
async function fileRow(fileId) {
  const rows = await rest(`files?id=eq.${fileId}&select=id,status,conversation_id,deleted_at,metadata,rag_v2_model`);
  return rows?.[0] ?? null;
}

/** مقاطعُ الملف: الكلّ، والناقصُ متجهَ e5، والناقصُ متجهَ F2LLM بالوسم الحاليّ */
async function chunkCoverage(fileId) {
  const all = await rest(`file_chunks?file_id=eq.${fileId}&select=id`);
  const noE5 = await rest(`file_chunks?file_id=eq.${fileId}&embedding=is.null&select=id`);
  const v2 = await rest(`file_chunks?file_id=eq.${fileId}&embedding_v2_model=eq.${encodeURIComponent(F2LLM_TAG)}&select=id`);
  return { total: all.length, e5: all.length - noE5.length, v2: v2.length };
}

function completeIn(cov, space) {
  return cov.total > 0 && (space === "e5" ? cov.e5 === cov.total : cov.v2 === cov.total);
}

/** جاهزٌ في الفضاء الفعّال: الحالةُ والمقاطعُ معًا — لا الحالةُ وحدها */
async function waitForActiveReady(fileId, timeoutMs = READY_TIMEOUT_MS) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const f = await fileRow(fileId);
    last = f?.status ?? null;
    if (last === "failed" || last === "rag_failed") return { ready: false, status: last, ms: Date.now() - t0 };
    if (last === "ready_for_rag") {
      const cov = await chunkCoverage(fileId);
      if (completeIn(cov, SPACE)) return { ready: true, status: last, cov, ms: Date.now() - t0 };
    }
    await sleep(2500);
  }
  return { ready: false, status: last, ms: Date.now() - t0, timedOut: true };
}

/**
 * لا «جاهز» كاذب: ما تقول الواجهةُ إنه جاهز (ready_for_rag ولا needs_active_embedding)
 * يجب أن يكون كاملَ المقاطع في الفضاء الفعّال — الآن، لا بعد قليل.
 */
async function assertNoFalseReady(conversationId, phaseTag) {
  const list = await api(`/api/files?conversationId=${conversationId}`);
  if (list.status !== 200) {
    violate("files_list_failed", { conversationId, status: list.status, phaseTag });
    return [];
  }
  const rows = list.json?.files ?? [];
  for (const f of rows) {
    if (f.status !== "ready_for_rag" || f.needs_active_embedding) continue;
    const cov = await chunkCoverage(f.id);
    if (!completeIn(cov, SPACE)) violate("false_ready", { fileId: f.id, conversationId, cov, space: SPACE, phaseTag });
  }
  return rows;
}

/** الثابتُ الأهمّ على مسار المحادثة نفسِه: ملفٌّ مرفقٌ لا يسقط من نطاقها */
function checkChatScope(res, { conversationId, expectFiles, expectReady, phaseTag }) {
  if (!res.scope) {
    counters.chatUnmeasured++;
    violate("chat_scope_unmeasured", { conversationId, status: res.status, phaseTag });
    return;
  }
  const seen = (res.scope.ready ?? 0) + (res.scope.pending ?? 0);
  if (seen < expectFiles.length) {
    violate("file_absent_from_chat_scope", { conversationId, expected: expectFiles.length, scope: res.scope, phaseTag });
  }
  if (expectReady && (res.scope.ready ?? 0) < expectFiles.length) {
    violate("ready_file_not_ready_in_chat_scope", { conversationId, expected: expectFiles.length, scope: res.scope, phaseTag });
  }
  const own = new Set(state.files.filter((f) => f.conversationId === conversationId).map((f) => f.id));
  for (const s of res.sources) {
    if (!own.has(s)) violate("cross_conversation_leakage", { conversationId, leakedFileId: s, phaseTag });
  }
  if (expectReady) {
    counters.questionsAfterReady++;
    for (const id of expectFiles) {
      if (res.sources.includes(id)) counters.retrievalHits++;
      else violate("retrieval_failed_after_ready", { conversationId, fileId: id, scope: res.scope, phaseTag });
    }
  }
}

function track(fileId, conversationId, fx, extra = {}) {
  state.files.push({
    id: fileId,
    conversationId,
    name: fx.name,
    question: fx.question,
    phase: PHASE,
    space: SPACE,
    sha: createHash("sha256").update(fx.bytes).digest("hex"),
    ...extra,
  });
}

// ------------------------------------------------------------------ scenarios
const KINDS = ["pdf", "txt", "md", "pdf-ar", "txt-ar", "md-ar"];

/** دورةٌ أساسيّة: رفعٌ ⇒ (سؤالٌ فوريّ؟) ⇒ جاهز ⇒ سؤالٌ بعد الجاهزيّة يسترجع الملف */
async function basicCycle(n, { files = 1, immediate = false, reload = false, abandon = false, kinds = null }) {
  const conversationId = await createConversation(`stress p${PHASE} c${n}`);
  const ups = [];
  for (let i = 0; i < files; i++) {
    const kind = kinds ? kinds[i % kinds.length] : KINDS[(n + i) % KINDS.length];
    const fx = fixture(kind, `RC${PHASE}${n}X${i}${randomUUID().slice(0, 4).toUpperCase()}`);
    const up = await upload({ conversationId, fx, clientUploadId: randomUUID() });
    const id = up.json?.file?.id;
    if (!id || (up.status !== 201 && up.status !== 200)) {
      violate("upload_failed", { n, kind, status: up.status, body: up.text?.slice(0, 160) });
      continue;
    }
    counters.filesCreated++;
    track(id, conversationId, fx);
    ups.push({ id, fx });
  }
  if (ups.length === 0) return;

  if (reload) {
    // إعادةُ تحميلٍ أثناء التجهيز: الحالةُ تُستعاد من الخادم، ولا «جاهز» كاذب في منتصفها
    counters.reloadChecks++;
    await sleep(800);
    const rows = await assertNoFalseReady(conversationId, "reload-during-indexing");
    for (const u of ups) if (!rows.some((r) => r.id === u.id)) violate("file_missing_after_reload", { fileId: u.id, conversationId });
  }
  if (immediate) {
    counters.immediateQuestions++;
    const res = await ask(conversationId, ups[0].fx.question);
    checkChatScope(res, { conversationId, expectFiles: ups.map((u) => u.id), expectReady: false, phaseTag: "immediate" });
  }
  if (abandon) {
    // الصفحةُ أُغلقت فور الرفع: لا استطلاعَ ولا طلبَ تجهيز — الخادمُ وحده يكمل
    counters.abandonedClients++;
    await sleep(3000);
  }
  for (const u of ups) {
    const r = await waitForActiveReady(u.id);
    if (!r.ready) violate("never_reached_ready", { fileId: u.id, lastStatus: r.status, ms: r.ms, timedOut: Boolean(r.timedOut) });
    else counters.reachedReady++;
  }
  await assertNoFalseReady(conversationId, "after-ready");
  for (const u of ups) {
    const res = await ask(conversationId, u.fx.question);
    checkChatScope(res, { conversationId, expectFiles: [u.id], expectReady: true, phaseTag: "after-ready" });
  }
}

/** إعادةُ الطلب نفسه + إعادةُ اختيار الملفّ نفسه بمعرّفٍ جديد ⇒ صفٌّ واحد */
async function duplicateCycle(n) {
  const conversationId = await createConversation(`stress p${PHASE} dup c${n}`);
  const fx = fixture(KINDS[n % KINDS.length], `RD${PHASE}${n}${randomUUID().slice(0, 4).toUpperCase()}`);
  const cid = randomUUID();
  const a = await upload({ conversationId, fx, clientUploadId: cid });
  const id = a.json?.file?.id;
  if (!id) return violate("upload_failed", { n, status: a.status });
  counters.filesCreated++;
  track(id, conversationId, fx);

  counters.retryReplays++;
  const replay = await upload({ conversationId, fx, clientUploadId: cid });
  if (replay.json?.file?.id !== id) violate("retry_created_new_row", { first: id, second: replay.json?.file?.id, status: replay.status });

  counters.freshRepicks++;
  const repick = await upload({ conversationId, fx, clientUploadId: randomUUID() });
  if (repick.json?.file?.id !== id) violate("fresh_repick_created_new_row", { first: id, second: repick.json?.file?.id, status: repick.status });
  // وباسمٍ آخر للبايتات نفسها — الهويّةُ للمحتوى
  const renamed = await upload({ conversationId, fx: { ...fx, name: `copy-${fx.name}` }, clientUploadId: randomUUID() });
  if (renamed.json?.file?.id !== id) violate("same_bytes_renamed_created_new_row", { first: id, second: renamed.json?.file?.id });

  const r = await waitForActiveReady(id);
  if (!r.ready) violate("never_reached_ready", { fileId: id, lastStatus: r.status });
  else counters.reachedReady++;
  const res = await ask(conversationId, fx.question);
  checkChatScope(res, { conversationId, expectFiles: [id], expectReady: true, phaseTag: "duplicate" });
}

/** الاسمُ نفسه والبايتاتُ مختلفة ⇒ ملفّان، وكلٌّ يُسترجع بسؤاله */
async function sameNameCycle(n) {
  counters.sameNameDifferentBytes++;
  const conversationId = await createConversation(`stress p${PHASE} samename c${n}`);
  const name = n % 2 ? "اليوم الوطني.txt" : "national-day.txt";
  const fx1 = fixture("txt", `RN${PHASE}${n}A${randomUUID().slice(0, 4).toUpperCase()}`, name);
  const fx2 = fixture("txt", `RN${PHASE}${n}B${randomUUID().slice(0, 4).toUpperCase()}`, name);
  const a = await upload({ conversationId, fx: fx1, clientUploadId: randomUUID() });
  const b = await upload({ conversationId, fx: fx2, clientUploadId: randomUUID() });
  const ida = a.json?.file?.id;
  const idb = b.json?.file?.id;
  if (!ida || !idb) return violate("upload_failed", { n, a: a.status, b: b.status });
  if (ida === idb) return violate("different_bytes_collapsed", { fileId: ida, name });
  counters.filesCreated += 2;
  track(ida, conversationId, fx1);
  track(idb, conversationId, fx2);
  for (const id of [ida, idb]) {
    const r = await waitForActiveReady(id);
    if (!r.ready) violate("never_reached_ready", { fileId: id, lastStatus: r.status });
    else counters.reachedReady++;
  }
  const res = await ask(conversationId, fx1.question);
  checkChatScope(res, { conversationId, expectFiles: [ida, idb], expectReady: false, phaseTag: "same-name" });
  if (res.scope && res.scope.ready < 2) violate("same_name_file_missing_from_scope", { scope: res.scope });
  if (!res.sources.includes(ida) && !res.sources.includes(idb)) violate("retrieval_failed_after_ready", { conversationId, fileIds: [ida, idb], phaseTag: "same-name" });
  else counters.retrievalHits++;
}

/**
 * انتقالٌ أثناء الرفع: بدأ في (أ) وأُعيد بالمعرّف نفسه في (ب).
 * (ب) تنال صفًّا خاصًّا بها، و(أ) لا تُمسّ، ولا يعبر مرفقٌ من محادثةٍ إلى أخرى.
 */
async function switchCycle(n) {
  counters.conversationSwitches++;
  const convA = await createConversation(`stress p${PHASE} switch-A c${n}`);
  const convB = await createConversation(`stress p${PHASE} switch-B c${n}`);
  const fx = fixture(KINDS[n % KINDS.length], `RW${PHASE}${n}${randomUUID().slice(0, 4).toUpperCase()}`);
  const cid = randomUUID();
  const a = await upload({ conversationId: convA, fx, clientUploadId: cid });
  const ida = a.json?.file?.id;
  if (!ida) return violate("upload_failed", { n, status: a.status });
  const b = await upload({ conversationId: convB, fx, clientUploadId: cid });
  const idb = b.json?.file?.id;
  if (!idb) return violate("upload_failed", { n, status: b.status });
  counters.filesCreated += 2;
  if (ida === idb) violate("stale_linkage_reused_across_conversations", { fileId: ida, convA, convB });
  track(ida, convA, fx);
  track(idb, convB, fx);
  const rowA = await fileRow(ida);
  const rowB = await fileRow(idb);
  if (rowA?.conversation_id !== convA) violate("wrong_conversation_link", { fileId: ida, expected: convA, actual: rowA?.conversation_id });
  if (rowB?.conversation_id !== convB) violate("wrong_conversation_link", { fileId: idb, expected: convB, actual: rowB?.conversation_id });
  for (const id of [ida, idb]) {
    const r = await waitForActiveReady(id);
    if (!r.ready) violate("never_reached_ready", { fileId: id, lastStatus: r.status });
    else counters.reachedReady++;
  }
  counters.leakageProbes += 2;
  checkChatScope(await ask(convA, fx.question), { conversationId: convA, expectFiles: [ida], expectReady: true, phaseTag: "switch-A" });
  checkChatScope(await ask(convB, fx.question), { conversationId: convB, expectFiles: [idb], expectReady: true, phaseTag: "switch-B" });
}

/** رفعٌ قبل وجود المحادثة ثمّ مصالحتُه فيها ⇒ ربطٌ صريحٌ بالصفّ نفسه */
async function orphanCycle(n) {
  counters.orphanRelinks++;
  const fx = fixture(KINDS[(n + 2) % KINDS.length], `RO${PHASE}${n}${randomUUID().slice(0, 4).toUpperCase()}`);
  const cid = randomUUID();
  const a = await upload({ conversationId: null, fx, clientUploadId: cid });
  const id = a.json?.file?.id;
  if (!id) return violate("upload_failed", { n, status: a.status });
  const conversationId = await createConversation(`stress p${PHASE} orphan c${n}`);
  const b = await upload({ conversationId, fx, clientUploadId: cid });
  if (b.json?.file?.id !== id || !b.json?.relinked) violate("orphan_not_relinked", { first: id, second: b.json?.file?.id, relinked: b.json?.relinked });
  counters.filesCreated++;
  track(id, conversationId, fx);
  const row = await fileRow(id);
  if (row?.conversation_id !== conversationId) violate("wrong_conversation_link", { fileId: id, expected: conversationId, actual: row?.conversation_id });
  const r = await waitForActiveReady(id);
  if (!r.ready) violate("never_reached_ready", { fileId: id, lastStatus: r.status });
  else counters.reachedReady++;
  checkChatScope(await ask(conversationId, fx.question), { conversationId, expectFiles: [id], expectReady: true, phaseTag: "orphan" });
}

/**
 * التعافي من الحالات العالقة التي في الإنتاج — يُعاد الملفُّ إلى الحال نفسِه ثمّ
 * يُفعل ما تفعله الواجهة الجديدة (أو لا شيء، حين يكفي الخادم).
 *   stranded-ready  : نصٌّ مستخرَج، لا مقاطع، لا وظيفة ⇒ سؤالٌ واحد يكفي (الخادم يُدرج).
 *   stale-job       : `embedding` ووظيفةٌ «تعمل» بنبضٍ ميّت ⇒ طلبُ تجهيز (استئنافُ الواجهة).
 *   stale-extraction: `processing` بلا نصّ ⇒ إعادةُ استخراج (ما تفعله الواجهة بعد المهلة).
 */
async function recoveryCycle(n, mode) {
  const conversationId = await createConversation(`stress p${PHASE} recover-${mode} c${n}`);
  const fx = fixture(KINDS[n % KINDS.length], `RR${PHASE}${n}${randomUUID().slice(0, 4).toUpperCase()}`);
  const up = await upload({ conversationId, fx, clientUploadId: randomUUID() });
  const id = up.json?.file?.id;
  if (!id) return violate("upload_failed", { n, status: up.status });
  counters.filesCreated++;
  track(id, conversationId, fx);
  const first = await waitForActiveReady(id);
  if (!first.ready) return violate("never_reached_ready", { fileId: id, lastStatus: first.status, stage: "before-rewind" });

  // ★ إرجاعُ الملفّ إلى الحال العالقة — على صفوف مستخدم الأداة وحده، في staging وحدها
  await rest(`file_chunks?file_id=eq.${id}`, { method: "DELETE" });
  const jobs = await rest(`rag_jobs?file_id=eq.${id}&order=created_at.desc&select=id`);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  if (mode === "stranded-ready") {
    counters.strandedReadyRecoveries++;
    await rest(`rag_jobs?file_id=eq.${id}`, { method: "DELETE" });
    await rest(`files?id=eq.${id}`, {
      method: "PATCH",
      body: { status: "ready", rag_total_chunks: 0, rag_done_chunks: 0, rag_content_hash: null, rag_v2_model: null },
    });
    // لا طلبَ تجهيز: سؤالٌ في المحادثة يكفي كي يُدرج الخادمُ الوظيفةَ ويصرّفها
    const res = await ask(conversationId, fx.question);
    checkChatScope(res, { conversationId, expectFiles: [id], expectReady: false, phaseTag: "stranded-ready" });
  } else if (mode === "stale-job") {
    counters.staleJobRecoveries++;
    await rest(`files?id=eq.${id}`, {
      method: "PATCH",
      body: { status: "embedding", rag_done_chunks: 0, rag_v2_model: null },
    });
    if (jobs?.[0]) {
      await rest(`rag_jobs?id=eq.${jobs[0].id}`, {
        method: "PATCH",
        body: { status: "running", locked_by: "dead-worker", locked_at: oneHourAgo, heartbeat_at: oneHourAgo, completed_at: null },
      });
    }
    const nudge = await api(`/api/files/${id}/rag`, { method: "POST" });
    if (![200, 202, 409].includes(nudge.status)) violate("stale_job_nudge_rejected", { fileId: id, status: nudge.status, body: nudge.text?.slice(0, 160) });
  } else if (mode === "stale-extraction") {
    counters.staleExtractionRecoveries++;
    await rest(`rag_jobs?file_id=eq.${id}`, { method: "DELETE" });
    await rest(`files?id=eq.${id}`, {
      method: "PATCH",
      body: { status: "processing", extracted_text: null, rag_total_chunks: 0, rag_done_chunks: 0, rag_content_hash: null, rag_v2_model: null },
    });
    const re = await api(`/api/files/${id}/process`, { method: "POST" });
    if (re.status !== 200) violate("reextract_rejected", { fileId: id, status: re.status, body: re.text?.slice(0, 160) });
  }
  const r = await waitForActiveReady(id);
  if (!r.ready) violate("stuck_file_not_recovered", { fileId: id, mode, lastStatus: r.status, timedOut: Boolean(r.timedOut) });
  else counters.reachedReady++;
  checkChatScope(await ask(conversationId, fx.question), { conversationId, expectFiles: [id], expectReady: true, phaseTag: `recover-${mode}` });
}

/** محادثةٌ بلا ملفّات: لا نطاقَ ولا مصادر — ولو كان للمستخدم عشراتُ الملفّات الجاهزة */
async function leakageProbe(n) {
  counters.leakageProbes++;
  const conversationId = await createConversation(`stress p${PHASE} empty c${n}`);
  const res = await ask(conversationId, "What is the verification code of the reliability report?");
  if (!res.scope) {
    counters.chatUnmeasured++;
    return violate("chat_scope_unmeasured", { conversationId, status: res.status, phaseTag: "leakage-probe" });
  }
  if (res.scope.ready !== 0 || res.scope.pending !== 0 || res.sources.length > 0) {
    violate("cross_conversation_leakage", { conversationId, scope: res.scope, sources: res.sources, phaseTag: "empty-conversation" });
  }
}

/**
 * ★ انتقالُ الفضاء: ملفّاتُ مرحلةٍ سابقة فُهرست في الفضاء الآخر وحده.
 *   السؤالُ الأوّل يراها معلَّقةً (لا غائبةً ولا «جاهزةً» كاذبة)، والخادمُ يُدرج
 *   وظيفةَ الفضاء الفعّال بنفسه، ثمّ يسترجعها سؤالٌ لاحق. ومتجهاتُ الفضاء القديم
 *   تبقى كما هي عددًا.
 */
async function transitionCheck(conversationId, files) {
  counters.transitionChecks++;
  const before = {};
  for (const f of files) before[f.id] = await chunkCoverage(f.id);
  const needsWork = files.filter((f) => !completeIn(before[f.id], SPACE));
  if (needsWork.length === 0) {
    // ملفٌّ في الفضاءين: جاهزٌ فورًا بلا عمل — الرجوعُ غيرُ متلِف
    counters.nonDestructiveChecks++;
    const res = await ask(conversationId, files[0].question);
    checkChatScope(res, { conversationId, expectFiles: files.map((f) => f.id), expectReady: true, phaseTag: "transition-already-both" });
    return;
  }
  // لا «جاهز» كاذب في الواجهة
  const list = await api(`/api/files?conversationId=${conversationId}`);
  for (const f of needsWork) {
    const row = (list.json?.files ?? []).find((r) => r.id === f.id);
    if (!row) violate("file_missing_after_transition", { fileId: f.id, conversationId });
    else if (row.status === "ready_for_rag" && !row.needs_active_embedding) violate("false_ready_after_transition", { fileId: f.id, cov: before[f.id], space: SPACE });
  }
  const first = await ask(conversationId, files[0].question);
  checkChatScope(first, { conversationId, expectFiles: files.map((f) => f.id), expectReady: false, phaseTag: "transition-first-ask" });
  if (first.scope && first.scope.pending < needsWork.length) {
    violate("transition_file_not_pending", { conversationId, scope: first.scope, needsWork: needsWork.length });
  }
  for (const f of needsWork) {
    const r = await waitForActiveReady(f.id);
    if (!r.ready) {
      violate("transition_never_completed", { fileId: f.id, space: SPACE, lastStatus: r.status, timedOut: Boolean(r.timedOut) });
      continue;
    }
    counters.reachedReady++;
    const after = await chunkCoverage(f.id);
    const other = SPACE === "e5" ? "v2" : "e5";
    if (after[other] < before[f.id][other]) {
      violate("old_space_vectors_destroyed", { fileId: f.id, before: before[f.id], after });
    } else counters.nonDestructiveChecks++;
  }
  for (const f of files) {
    const res = await ask(conversationId, f.question);
    checkChatScope(res, { conversationId, expectFiles: [f.id], expectReady: true, phaseTag: "transition-after" });
  }
}

/**
 * ★ حالُ ملفّات الإنتاج القديمة: متجهاتُ e5، ولا متجهَ v2، ولا وظيفةَ F2LLM.
 *
 *   تُصنع من ملفّاتٍ كاملةٍ في الفضاءين: يُمسح v2 **ووظيفةُ F2LLM المكتملة** معًا.
 *   مسحُ المتجهات وحدها يترك مفتاحَ idempotency مكتملًا — حالٌ لا يُنتجه أيُّ
 *   مسارٍ في المنتَج (العاملُ لا يحذف متجهاتِ الفضاء الآخر)، فيُفسد القياس.
 */
async function makeE5Only(n) {
  const picked = [];
  for (const f of state.files) {
    if (picked.length >= n) break;
    if (KEEP.has(f.id)) continue;
    const row = await fileRow(f.id);
    if (row?.status !== "ready_for_rag") continue;
    const cov = await chunkCoverage(f.id);
    if (!(cov.total > 0 && cov.e5 === cov.total && cov.v2 === cov.total)) continue;
    await rest(`file_chunks?file_id=eq.${f.id}`, { method: "PATCH", body: { embedding_v2: null, embedding_v2_model: null } });
    await rest(`rag_jobs?file_id=eq.${f.id}&job_type=eq.rag_prepare_f2llm`, { method: "DELETE" });
    await rest(`files?id=eq.${f.id}`, { method: "PATCH", body: { rag_v2_model: null } });
    const after = await chunkCoverage(f.id);
    if (after.v2 !== 0 || after.e5 !== after.total) throw new Error(`makeE5Only failed for ${f.id}: ${JSON.stringify(after)}`);
    picked.push(f.id);
  }
  log(`prepared ${picked.length} e5-only files: ${picked.map((x) => x.slice(0, 8)).join(",")}`);
  state.e5Only = picked;
  saveState();
}

// ------------------------------------------------------------------ plan
/** مصفوفةُ الدورات العاديّة — كلُّ ما طُلب إثباتُه موزَّعًا دوريًّا */
const PLAN = [
  (n) => basicCycle(n, { files: 1 }),
  (n) => basicCycle(n, { files: 1, immediate: true }),
  (n) => duplicateCycle(n),
  (n) => basicCycle(n, { files: 3, immediate: true, reload: true }),
  (n) => switchCycle(n),
  (n) => sameNameCycle(n),
  (n) => basicCycle(n, { files: 1, abandon: true, reload: true }),
  (n) => orphanCycle(n),
  (n) => recoveryCycle(n, "stranded-ready"),
  (n) => basicCycle(n, { files: 2, immediate: true }),
  (n) => recoveryCycle(n, "stale-job"),
  (n) => leakageProbe(n),
  (n) => recoveryCycle(n, "stale-extraction"),
  (n) => basicCycle(n, { files: 1, immediate: true, abandon: true }),
];

/** قبولُ الإنتاج: كلُّ ما طُلب، مرّةً واحدة — عبر المسار الحقيقيّ وحده */
const ACCEPTANCE_PLAN = [
  (n) => basicCycle(n, { files: 1, kinds: ["pdf"] }), // PDF جديد + سؤالٌ بعد الجاهزيّة
  (n) => basicCycle(n, { files: 2, immediate: true, kinds: ["txt", "md"] }), // TXT/MD + سؤالٌ فوريّ
  (n) => duplicateCycle(n), // إعادةُ طلب + إعادةُ اختيار + اسمٌ آخر للبايتات نفسها
  (n) => basicCycle(n, { files: 1, immediate: true, reload: true, kinds: ["pdf-ar"] }), // إعادةُ تحميلٍ أثناء الفهرسة
  (n) => switchCycle(n), // انتقالٌ بين محادثتين أثناء الرفع
  (n) => sameNameCycle(n), // الاسمُ نفسه ببايتاتٍ مختلفة
  (n) => leakageProbe(n), // محادثةٌ فارغة لا ترى شيئًا
  (n) => basicCycle(n, { files: 1, kinds: ["txt-ar"] }),
  (n) => basicCycle(n, { files: 1, abandon: true, kinds: ["md-ar"] }), // صفحةٌ أُغلقت فور الرفع
];

async function runCycles(count, offset) {
  const plan = ACCEPTANCE ? ACCEPTANCE_PLAN : PLAN;
  for (let i = 0; i < count; i++) {
    const n = offset + i;
    const step = plan[n % plan.length];
    log(`phase ${PHASE} cycle ${i + 1}/${count} (plan#${n % plan.length}, space=${SPACE}${ACCEPTANCE ? ", acceptance" : ""})`);
    counters.cycles++;
    try {
      await step(n);
    } catch (err) {
      violate("cycle_threw", { n, error: String(err?.message ?? err).slice(0, 300) });
    }
    saveState();
  }
}

async function finalAudit() {
  const userId = state.user.userId;
  const all = await rest(`files?user_id=eq.${userId}&deleted_at=is.null&select=id,status,conversation_id,metadata`);
  // تكرارٌ: البصمةُ نفسُها في المحادثة نفسِها مرّتين
  const groups = new Map();
  for (const f of all) {
    const k = `${f.conversation_id}|${f.metadata?.content_sha256}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, c] of groups) if (c > 1) violate("duplicate_rows", { key: k, count: c });
  // ربطٌ خاطئ: كلُّ ملفٍّ في المحادثة التي قصدتها الأداة
  const intended = new Map(state.files.map((f) => [f.id, f.conversationId]));
  for (const f of all) {
    if (!intended.has(f.id)) violate("untracked_file_row", { fileId: f.id, conversationId: f.conversation_id });
    else if (intended.get(f.id) !== f.conversation_id) violate("wrong_conversation_link", { fileId: f.id, expected: intended.get(f.id), actual: f.conversation_id });
  }
  // فقدان: كلُّ ملفٍّ تتبّعته الأداة ما زال موجودًا
  const live = new Set(all.map((f) => f.id));
  for (const f of state.files) if (!live.has(f.id)) violate("lost_file", { fileId: f.id });
  // معلَّقٌ دائم: كلُّ ملفٍّ جاهزٌ في الفضاء الفعّال الآن
  let pendingForever = 0;
  for (const f of all) {
    const cov = await chunkCoverage(f.id);
    if (f.status !== "ready_for_rag" || !completeIn(cov, SPACE)) {
      pendingForever++;
      violate("permanent_pending", { fileId: f.id, status: f.status, cov, space: SPACE });
    }
  }
  return { liveFiles: all.length, trackedFiles: state.files.length, pendingForever };
}

// ------------------------------------------------------------------ main
async function main() {
  if (!state.user) {
    log("provisioning user...");
    state.user = await provisionUser();
    saveState();
  }
  await freshCookie();
  const live = await api("/api/live");
  if (live.status !== 200) throw new Error(`target not live: ${live.status}`);
  log(`phase ${PHASE} space=${SPACE} user=${state.user.userId} version=${live.json?.version}`);

  const offset = Object.values(state.phases).reduce((a, p) => a + (p.cycles ?? 0), 0);

  if (MAKE_E5_ONLY > 0 && !ACCEPTANCE) await makeE5Only(MAKE_E5_ONLY);

  if (PHASE >= 2 && !ACCEPTANCE) {
    /**
     * الانتقال: **كلُّ** محادثات المراحل السابقة — لا عيّنة. فالفحصُ الختاميّ
     * يحكم بـ«معلَّقٍ دائم» على كلّ ملفٍّ لم يكتمل، والملفُّ الذي لم تُفتح
     * محادثتُه لا يُطلب تجهيزُه أصلًا (الترحيلُ كسولٌ بالتصميم: عند الفتح).
     */
    const convs = [...new Set(state.files.filter((f) => f.phase < PHASE).map((f) => f.conversationId))];
    for (const c of convs) {
      log(`transition check conv=${c.slice(0, 8)} (space ${SPACE})`);
      try {
        await transitionCheck(c, state.files.filter((f) => f.conversationId === c));
      } catch (err) {
        violate("cycle_threw", { transition: c, error: String(err?.message ?? err).slice(0, 300) });
      }
    }
  }

  await runCycles(CYCLES, offset);

  const audit = PHASE >= 3 || ACCEPTANCE ? await finalAudit() : null;
  state.phases[PHASE] = { space: SPACE, cycles: counters.cycles, counters, violations: violations.length, at: new Date().toISOString() };
  saveState();

  const summary = { target: BASE, phase: PHASE, space: SPACE, counters, audit, violations, verdict: violations.length === 0 ? "RELIABLE" : "BROKEN" };
  writeFileSync(resolve(OUT, `file-pipeline-stress-phase${PHASE}.json`), JSON.stringify(summary, null, 2));
  log("=== SUMMARY ===");
  log(JSON.stringify({ ...summary, violations: violations.length }, null, 1));
  if (violations.length > 0) for (const v of violations.slice(0, 40)) log(" -", v.kind, JSON.stringify(v.detail).slice(0, 220));
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("STRESS HARNESS ERROR:", e);
  process.exit(2);
});
