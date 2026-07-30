#!/usr/bin/env node
/**
 * بوابة Smoke للحاوية (v0.7.0 RC8) — عقود المحادثة داخل الصورة المبنيّة.
 *
 *   node scripts/rc8-container-smoke.mjs <appBaseUrl> <mockBaseUrl>
 *   مثال: node scripts/rc8-container-smoke.mjs http://localhost:4820 http://localhost:8095
 *
 * تشغّل السيناريوهات عبر /api/chat الحقيقي مع مزوّد وهمي حتمي
 * (scripts/mock-provider-scenarios.mjs) — بلا أي نداء لمزوّد حقيقي.
 *
 * **العزل الكامل قبل كل سيناريو** هو جوهر هذه البوابة. الصيغة السابقة كانت
 * تصفّر عدّادات المزوّد وحدها وتترك حالة القاعدة، فسقط سيناريوهان بسبب تداخل
 * تسلسلي بينما كانا ينجحان منفردين — تشخيصٌ مضلّل أهدر جولة كاملة. الآن يُنظَّف
 * كل شيء بـuser_id، وتُولَّد المفاتيح بـcrypto.randomUUID، ويُنتظر إغلاق
 * المقابس قبل البدء.
 *
 * الأسرار تُقرأ من البيئة وقت التشغيل ولا تُطبع: لا كوكيز ولا ترويسات
 * تفويض ولا نص محادثة. المخرجات حالات وأرقام وأسماء سيناريوهات فقط.
 *
 * ملف تشخيصي بحت — لا يُستورد من أي مسار تطبيق ولا يدخل الصورة (مرحلة
 * runner تنسخ .next/standalone وحدها).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const APP = (process.argv[2] ?? "http://localhost:4820").replace(/\/$/, "");
const MOCK = (process.argv[3] ?? "http://localhost:8095").replace(/\/$/, "");
const STORAGE = process.env.YSD_E2E_STORAGE_STATE ?? ".playwright/.auth/ysd-e2e.json";
const ENV_FILE = process.env.YSD_ENV_FILE ?? ".env.local";

const NOTICE = "لم يكتمل هذا الرد. يمكنك إعادة التوليد.";
const E2E_TABLES = ["chat_request_ids", "distributed_rate_limits", "usage_events"];

/* ---------- بيئة وهوية (لا طباعة) ---------- */
const env = {};
for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SERVICE) {
  console.error("مفاتيح Supabase غير متاحة في البيئة — لا يمكن تشغيل البوابة.");
  process.exit(2);
}
const db = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });

const state = JSON.parse(fs.readFileSync(STORAGE, "utf8"));
const cookieHeader = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
// نبحث عن كوكي الجلسة بمحتواها لا بترتيبها: الترتيب يتغيّر بين توليدات
// storageState، وقراءة cookies[0] عمياء تنكسر بصمت وتنسب الخطأ لمكان آخر.
const authCookie = state.cookies.find((c) => c.value.startsWith("base64-"));
if (!authCookie) {
  console.error("لا توجد كوكي جلسة في storageState — شغّل npm run e2e:prepare أولًا.");
  process.exit(2);
}
const uid = JSON.parse(
  Buffer.from(authCookie.value.slice("base64-".length), "base64").toString(),
).user.id;

/* ---------- أدوات المزوّد الوهمي ---------- */
const counters = async () => (await fetch(`${MOCK}/${encodeURIComponent("عدادات")}`)).json();
const resetMock = () => fetch(`${MOCK}/${encodeURIComponent("تصفير")}`);
const releaseHeld = () => fetch(`${MOCK}/${encodeURIComponent("إطلاق")}`);
async function untilCounters(pred, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(await counters())) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

/* ---------- تنظيف بيانات حساب E2E وحده ---------- */
async function purgeE2E() {
  const ids = ((await db.from("conversations").select("id").eq("user_id", uid)).data ?? [])
    .map((c) => c.id);
  if (ids.length) {
    await db.from("messages").delete().in("conversation_id", ids);
    await db.from("conversations").delete().in("id", ids);
  }
  for (const t of E2E_TABLES) await db.from(t).delete().eq("user_id", uid);
}
async function e2eResidue() {
  const one = async (t) =>
    (await db.from(t).select("*", { count: "exact", head: true }).eq("user_id", uid)).count;
  return {
    conversations: await one("conversations"),
    chat_request_ids: await one("chat_request_ids"),
    distributed_rate_limits: await one("distributed_rate_limits"),
    usage_events: await one("usage_events"),
  };
}
const totals = async () => {
  const n = async (t) => (await db.from(t).select("*", { count: "exact", head: true })).count;
  return { conversations: await n("conversations"), messages: await n("messages"), files: await n("files") };
};

/* ---------- طلب واحد إلى /api/chat ---------- */
async function chat({ conversationId, message, regenerate, clientRequestId, abortWhen }) {
  const ac = new AbortController();
  const body = { conversationId, modelId: "ysd/free", clientRequestId };
  if (regenerate) body.regenerate = true;
  else body.message = message;

  const pending = fetch(`${APP}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).catch(() => null);

  if (abortWhen) {
    await untilCounters(abortWhen);
    ac.abort();
  }
  const res = await pending;
  if (!res) {
    // إجهاض العميل — ننتظر نافذة حتمية لالتقاط أي حفظ متأخر
    await new Promise((r) => setTimeout(r, 2500));
    return { aborted: true, status: null, contentType: null, events: [], text: "" };
  }
  const contentType = res.headers.get("content-type");
  const raw = await res.text().catch(() => "");
  const events = [];
  let text = "";
  let completion = null;
  let errorCode = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const e = JSON.parse(line.slice(6));
      events.push(e.type ?? "?");
      if (e.type === "text") text += e.text;
      if (e.type === "error") errorCode = e.code ?? null;
      if (e.type === "done") completion = e.completion ?? null;
    } catch {
      /* سطر غير JSON (نبضة أو تعليق) */
    }
  }
  return { status: res.status, contentType, events, text, completion, errorCode,
    sawDone: events.includes("done"), nonSse: contentType && !contentType.includes("event-stream") ? raw.slice(0, 200) : null };
}

/* ---------- قراءات القاعدة ---------- */
const rowsOf = async (cid) =>
  (await db.from("messages").select("id,role,content,metadata,deleted_at")
    .eq("conversation_id", cid).order("created_at")).data ?? [];
const activeOf = (rows, role) => rows.filter((r) => r.role === role && !r.deleted_at);
const claimOf = async (crid) =>
  (await db.from("chat_request_ids").select("status").eq("user_id", uid)
    .eq("client_request_id", crid)).data ?? [];

/* ---------- إطار التأكيدات ---------- */
let failures = 0;
const results = [];
function expect(name, cond, detail = "") {
  const ok = Boolean(cond);
  if (!ok) failures++;
  results.push({ name, ok });
  console.log(`    ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
const fences = (s) => (s.match(/```/g) ?? []).length;

/**
 * عزل كامل: تنظيف القاعدة، تصفير المزوّد، انتظار إغلاق المقابس، محادثة جديدة.
 */
async function isolate(label) {
  await purgeE2E();
  const residue = await e2eResidue();
  const clean = Object.values(residue).every((v) => v === 0);
  await resetMock();
  await releaseHeld().catch(() => undefined); // أطلق أي إمساك متبقٍّ
  await resetMock();
  const settled = await untilCounters((c) => c.active_sockets === 0, 15_000);
  const { data: conv } = await db.from("conversations")
    .insert({ user_id: uid, title: `smoke-${label}` }).select("id").single();
  console.log(`\n── ${label} ──`);
  expect("العزل: بقايا E2E صفر", clean, JSON.stringify(residue));
  expect("العزل: active_sockets=0 قبل البدء", settled);
  return conv.id;
}

/** يطبع عقد المحاولة بأمان */
async function logContract(scenario, crid, res, cid) {
  const c = await counters();
  const rows = await rowsOf(cid);
  const asst = activeOf(rows, "assistant");
  const comp = asst[0]?.metadata?.completion;
  console.log(
    `    ↳ ${scenario} · crid=${crid.slice(0, 8)} · HTTP ${res.status ?? "aborted"}` +
      ` · ct=${res.contentType ?? "—"} · sse=${JSON.stringify(res.events)}`,
  );
  console.log(
    `      provider_calls=${c.provider_calls} sockets=${c.active_sockets}` +
      ` closed_early=${c.connection_closed_early} completed=${c.completed_normally}` +
      ` heartbeat=${c.heartbeat_sent} chunks=${c.chunks_sent}`,
  );
  console.log(
    `      rows: user=${activeOf(rows, "user").length} assistant=${asst.length}` +
      ` · completion=${comp ? `${comp.status}/${comp.reason}` : "—"}` +
      ` · claim=${JSON.stringify(await claimOf(crid))}`,
  );
  if (res.nonSse) console.log(`      ⚠️ جسم غير SSE: ${res.nonSse}`);
  // «لا صف عالق»: صف حجز واحد بحالة نهائية. حالة in_progress دائمة تعني حجزًا
  // لم يُنهَ — وقد كشف هذا الفحصُ بالفعل أن فرع regenerate كان لا يُنهي حجزه.
  const claim = await claimOf(crid);
  expect(`${scenario}: صف حجز واحد`, claim.length === 1, `= ${claim.length}`);
  expect(`${scenario}: الحجز غير عالق`, claim[0]?.status !== "in_progress",
    `status=${claim[0]?.status}`);
  return { c, rows, asst, comp };
}

/** يتحقق من نظافة ما بعد السيناريو */
async function postChecks(label) {
  const c = await counters();
  expect(`${label}: active_sockets=0`, c.active_sockets === 0, `= ${c.active_sockets}`);
  await releaseHeld().catch(() => undefined);
  const after = await counters();
  expect(`${label}: لا نبضات معلّقة`, after.active_sockets === 0, `sockets=${after.active_sockets}`);
}

/**
 * دور تمهيدي لسيناريوهات إعادة التوليد — مع تأكيد شرطه المسبق.
 *
 * السيناريوهات التالية تفترض وجود ردّ مساعد واحد لتعيد توليده. لو فشل هذا
 * الدور بصمت لصار المعرّف undefined، فتسقط تأكيدات لاحقة برسالة لا علاقة لها
 * بالسبب — عطل يبدو في مكان وسببه في مكان آخر. نثبّت الشرط هنا.
 */
async function seedTurn(cid, label, message = P.normal) {
  const res = await chat({ conversationId: cid, message, clientRequestId: crypto.randomUUID() });
  const rows = await rowsOf(cid);
  const asst = activeOf(rows, "assistant");
  const ok = expect(`${label}: تمهيد — ردّ مساعد واحد`, asst.length === 1,
    `= ${asst.length} · HTTP ${res.status ?? "aborted"} · sse=${JSON.stringify(res.events)}`);
  if (!ok) throw new Error(`تعذّر تمهيد ${label}: الشرط المسبق غير متحقق`);
  await resetMock();
  return { rows, asst: asst[0], user: activeOf(rows, "user")[0] };
}

const P = {
  normal: "سيناريو-عادي اشرح لي",
  split: "سيناريو-سياج-مشطور اكتب دالة",
  timeoutMid: "سيناريو-مهلة-أثناء-البث اكتب دالة",
  disconnect: "سيناريو-انقطاع-المزود اكتب دالة",
};

/* ══════════════════ السيناريوهات ══════════════════ */
async function run() {
  /**
   * تنظيف قبل قياس الأساس — لا بعده.
   *
   * كان الأساس يُقاس أولًا: فإن قُتل تشغيل سابق قبل بلوغ finally (SIGPIPE من
   * أنبوب مقطوع مثلًا) بقيت صفوف E2E، فدخلت في «قبل» ثم نُظّفت في «بعد»، فأعلن
   * الفارقُ أن بيانات المستخدمين الحقيقيين تغيّرت — وهي لم تتغيّر. القياس نفسه
   * كان الخلل. الآن الأساس يُقاس على حالة نظيفة، فالفارق لا يعني إلا مسًّا
   * فعليًّا ببيانات خارج حساب E2E.
   */
  await purgeE2E();
  const before = await totals();
  console.log(`إجماليات قبل البوابة: ${JSON.stringify(before)}`);
  console.log(`الهدف: ${APP} · المزوّد: ${MOCK}`);

  // ١) رد مكتمل
  {
    const cid = await isolate("complete");
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, message: P.normal, clientRequestId: crid });
    const { asst } = await logContract("complete", crid, res, cid);
    expect("HTTP 200 وSSE", res.status === 200 && res.contentType?.includes("event-stream"));
    expect("assistant active=1", asst.length === 1, `= ${asst.length}`);
    expect("لا completion ناقصة", !asst[0]?.metadata?.completion);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("complete");
  }

  // ٢) انقسام السياج
  {
    const cid = await isolate("split_fence");
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, message: P.split, clientRequestId: crid });
    const { c, asst } = await logContract("split_fence", crid, res, cid);
    expect("provider_calls=1", c.provider_calls === 1, `= ${c.provider_calls}`);
    expect("chunks_sent=4", c.chunks_sent === 4, `= ${c.chunks_sent}`);
    expect("أسيجة زوجية", fences(res.text) % 2 === 0, `= ${fences(res.text)}`);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("split_fence");
  }

  // ٣) incomplete_timeout
  {
    const cid = await isolate("incomplete_timeout");
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, message: P.timeoutMid, clientRequestId: crid });
    const { comp, asst } = await logContract("incomplete_timeout", crid, res, cid);
    expect("status=incomplete_timeout", comp?.status === "incomplete_timeout");
    expect("reason=hard_limit", comp?.reason === "hard_limit");
    expect("السياج مغلق", fences(res.text) % 2 === 0, `= ${fences(res.text)}`);
    expect("تنبيه واحد", res.text.split(NOTICE).length - 1 === 1);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("incomplete_timeout");
  }

  // ٤) incomplete_provider
  {
    const cid = await isolate("incomplete_provider");
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, message: P.disconnect, clientRequestId: crid });
    const { c, comp, asst } = await logContract("incomplete_provider", crid, res, cid);
    expect("provider_calls=1", c.provider_calls === 1, `= ${c.provider_calls}`);
    expect("status=incomplete_provider", comp?.status === "incomplete_provider");
    expect("reason=stream_interrupted", comp?.reason === "stream_interrupted");
    expect("assistant active=1", asst.length === 1, `= ${asst.length}`);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("incomplete_provider");
  }

  // ٥) إجهاض العميل
  {
    const cid = await isolate("client_abort");
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, message: P.split, clientRequestId: crid,
      abortWhen: (c) => c.chunks_sent >= 1 && c.active_sockets >= 1 });
    const { rows } = await logContract("client_abort", crid, res, cid);
    expect("user active=1", activeOf(rows, "user").length === 1);
    expect("assistant active=0", activeOf(rows, "assistant").length === 0,
      `= ${activeOf(rows, "assistant").length}`);
    expect("لا done", !res.sawDone);
    const late = activeOf(await rowsOf(cid), "assistant");
    expect("لا حفظ متأخر بعد 2.5ث", late.length === 0, `= ${late.length}`);
    await postChecks("client_abort");
  }

  // ٦) regenerate مكتملة — تحديث في مكانه
  {
    const cid = await isolate("regenerate_complete");
    const oldId = (await seedTurn(cid, "regenerate_complete")).asst.id;
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, regenerate: true, clientRequestId: crid });
    const { rows, asst } = await logContract("regenerate_complete", crid, res, cid);
    expect("نفس message_id", asst[0]?.id === oldId, `${asst[0]?.id?.slice(0, 8)} vs ${oldId?.slice(0, 8)}`);
    expect("assistant active=1", asst.length === 1, `= ${asst.length}`);
    expect("لا soft-delete", rows.filter((r) => r.deleted_at).length === 0);
    expect("لا completion قديمة", !asst[0]?.metadata?.completion);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("regenerate_complete");
  }

  // ٧) regenerate ⇒ ناقصة
  {
    const cid = await isolate("regenerate_incomplete");
    const seed = await seedTurn(cid, "regenerate_incomplete");
    const oldId = seed.asst.id;
    await db.from("messages").update({ content: P.timeoutMid }).eq("id", seed.user.id);
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, regenerate: true, clientRequestId: crid });
    const { rows, asst, comp } = await logContract("regenerate_incomplete", crid, res, cid);
    expect("نفس message_id", asst[0]?.id === oldId);
    expect("status=incomplete_timeout", comp?.status === "incomplete_timeout");
    expect("assistant active=1", asst.length === 1, `= ${asst.length}`);
    expect("لا صف جديد", rows.filter((r) => r.role === "assistant").length === 1);
    expect("المحفوظ=المبثوث", asst[0]?.content === res.text);
    await postChecks("regenerate_incomplete");
  }

  // ٨) regenerate + إجهاض ⇒ الرد القديم يبقى
  {
    const cid = await isolate("regenerate_stop");
    const seed = await seedTurn(cid, "regenerate_stop");
    const old = seed.asst;
    const oldMeta = JSON.stringify(old.metadata ?? {});
    await db.from("messages").update({ content: P.split }).eq("id", seed.user.id);
    const crid = crypto.randomUUID();
    const res = await chat({ conversationId: cid, regenerate: true, clientRequestId: crid,
      abortWhen: (c) => c.chunks_sent >= 1 && c.active_sockets >= 1 });
    const { rows, asst } = await logContract("regenerate_stop", crid, res, cid);
    expect("assistant active=1", asst.length === 1, `= ${asst.length}`);
    expect("نفس message_id", asst[0]?.id === old.id);
    expect("المحتوى لم يتغيّر", asst[0]?.content === old.content);
    expect("metadata لم تتغيّر", JSON.stringify(asst[0]?.metadata ?? {}) === oldMeta);
    expect("deleted_at=null", asst[0]?.deleted_at === null);
    expect("لا assistant جديدة", rows.filter((r) => r.role === "assistant").length === 1);
    await postChecks("regenerate_stop");
  }

  // ٩) duplicate بنفس المفتاح
  {
    const cid = await isolate("duplicate");
    const oldId = (await seedTurn(cid, "duplicate")).asst.id;
    const usageBefore = (await db.from("usage_events")
      .select("*", { count: "exact", head: true }).eq("user_id", uid)).count;
    const crid = crypto.randomUUID();
    const body = { conversationId: cid, modelId: "ysd/free", regenerate: true, clientRequestId: crid };
    const send = () => fetch(`${APP}/api/chat`, { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader }, body: JSON.stringify(body) });
    const [r1, r2] = await Promise.all([send(), send()]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    await Promise.all([r1.text(), r2.text()]);
    await new Promise((r) => setTimeout(r, 1500));
    const c = await counters();
    const allRows = await rowsOf(cid);
    const asst = activeOf(allRows, "assistant");
    const usageAfter = (await db.from("usage_events")
      .select("*", { count: "exact", head: true }).eq("user_id", uid)).count;
    const claim = await claimOf(crid);
    console.log(`    ↳ duplicate · crid=${crid.slice(0, 8)} · statuses=${JSON.stringify(statuses)}` +
      ` · provider_calls=${c.provider_calls} · claim=${JSON.stringify(claim)}`);
    console.log(`      old_id=${oldId?.slice(0, 8)} · صفوف المساعد=${JSON.stringify(
      allRows.filter((r) => r.role === "assistant")
        .map((r) => `${r.id.slice(0, 8)}${r.deleted_at ? "(محذوف)" : ""}`))}`);
    expect("statuses=[200,409]", statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));
    expect("صف حجز واحد لا صفّان", claim.length === 1, `= ${claim.length}`);
    expect("الحجز غير عالق", claim[0]?.status !== "in_progress", `status=${claim[0]?.status}`);
    expect("provider_calls=1", c.provider_calls === 1, `= ${c.provider_calls}`);
    // تأكيدان منفصلان لا واحد مركّب: التأكيد المركّب يسقط بلا أن يقول أيّ شقّيه
    // سقط، فيدفع إلى تخمين السبب — وهو بالضبط ما يجب أن تمنعه بوابة تشخيصية.
    expect("صف مساعد فعّال واحد", asst.length === 1, `= ${asst.length}`);
    expect("تحديث في مكانه لا صف جديد", asst[0]?.id === oldId,
      `${asst[0]?.id?.slice(0, 8)} مقابل ${oldId?.slice(0, 8)}`);
    expect("usage ≤ 1", usageAfter - usageBefore <= 1, `= ${usageAfter - usageBefore}`);
    await postChecks("duplicate");
  }

  return before;
}

let beforeTotals = null;
try {
  beforeTotals = await run();
} catch (err) {
  failures++;
  console.error(`\n❌ استثناء غير متوقّع: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await purgeE2E();
  const residue = await e2eResidue();
  const after = await totals();
  console.log(`\nبقايا E2E بعد التنظيف: ${JSON.stringify(residue)}`);
  console.log(`إجماليات بعد البوابة: ${JSON.stringify(after)}`);
  if (beforeTotals) {
    const same = JSON.stringify(beforeTotals) === JSON.stringify(after);
    console.log(`إجماليات المستخدمين الحقيقيين ثابتة: ${same ? "✅" : "❌"}`);
    if (!same) failures++;
  }
  if (!Object.values(residue).every((v) => v === 0)) failures++;
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ Smoke: ${passed}/${results.length} · إخفاقات=${failures} ═══`);
  if (failures > 0) {
    console.log("الساقط: " + results.filter((r) => !r.ok).map((r) => r.name).join(" · "));
  }
  process.exit(failures > 0 ? 1 : 0);
}
