/**
 * اختبارات صلاحيات لوحة الإدارة (بعد تطبيق migration 0009).
 * يتطلب: الخادم على 3000 + owner واحد على الأقل (بريده في YSD_OWNER_EMAIL أو أول owner).
 * ينشئ مستخدمين اختبار عاديين ويرقّي أحدهم إلى admin عبر owner… لكن الترقية تحتاج owner.
 * لذا: يجب أن يكون هناك owner مُمهّد يدويًا. نستخدم جلسة owner إن توفّرت كلمته،
 * وإلا نختبر ما يمكن اختباره بمستخدم عادي (المنع) + IDOR + عدم كشف الأسرار.
 *
 * التشغيل:
 *   node scripts/admin-check.mjs
 *   (لاختبار عمليات admin/owner الكاملة: YSD_OWNER_EMAIL=..  YSD_OWNER_PASSWORD=..)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = process.env.YSD_APP_URL ?? "http://localhost:3000";
const projectRef = new URL(URL_).host.split(".")[0];

let pass = 0, fail = 0; const failures = [];
function check(n, ok, d = "") { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } }
function cookieOf(session) {
  const v = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
async function newUser(label) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const ts = Date.now() + Math.floor(Math.random() * 1e4);
  const su = await c.auth.signUp({ email: `ysd.qa.admin.${label}.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
  if (su.error) throw new Error(su.error.message);
  await c.auth.setSession(su.data.session);
  return { client: c, cookie: cookieOf(su.data.session), userId: su.data.user.id };
}
const H = (cookie) => ({ Cookie: cookie, "Content-Type": "application/json" });

const U = await newUser("user");          // مستخدم عادي
const V = await newUser("victim");         // هدف IDOR

console.log("\n=== أ) منع المستخدم العادي (الأساس) ===");
const endpoints = [
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/models"],
  ["GET", "/api/admin/rag"],
  ["GET", "/api/admin/usage-limits"],
  ["GET", "/api/admin/settings"],
  ["GET", "/api/admin/audit"],
];
let allForbidden = true;
for (const [m, p] of endpoints) {
  const res = await fetch(`${APP}${p}`, { method: m, headers: H(U.cookie) });
  if (res.status !== 403) { allForbidden = false; console.log(`     ${p} → ${res.status}`); }
}
check("كل Admin GET APIs ترجع 403 للمستخدم العادي", allForbidden);

const patchUser = await fetch(`${APP}/api/admin/users/${V.userId}`, { method: "PATCH", headers: H(U.cookie), body: JSON.stringify({ op: "role", role: "admin" }) });
check("مستخدم عادي لا يعدّل دور غيره (403)", patchUser.status === 403, `HTTP ${patchUser.status}`);
const patchModel = await fetch(`${APP}/api/admin/models`, { method: "PATCH", headers: H(U.cookie), body: JSON.stringify({ target: "provider", id: "openrouter", enabled: false }) });
check("مستخدم عادي لا يعطّل موفرًا (403)", patchModel.status === 403, `HTTP ${patchModel.status}`);
const patchLimit = await fetch(`${APP}/api/admin/usage-limits`, { method: "PATCH", headers: H(U.cookie), body: JSON.stringify({ tier: "free", monthly_messages: 999999, monthly_tokens: 1, daily_messages: 1, max_file_mb: 1, max_files: 1, max_storage_mb: 1, max_chunks_per_file: 1, max_total_chunks: 1 }) });
check("مستخدم عادي لا يعدّل الحدود (403)", patchLimit.status === 403, `HTTP ${patchLimit.status}`);

console.log("\n=== ب) طبقة قاعدة البيانات (RPC) تمنع المستخدم العادي مباشرة ===");
const directRole = await U.client.rpc("admin_set_user_role", { p_target: V.userId, p_role: "admin" });
check("RPC admin_set_user_role تُرجع forbidden للعادي", directRole.data === "forbidden" || directRole.error != null, JSON.stringify(directRole.data ?? directRole.error?.message));
const directRag = await U.client.from("rag_jobs").select("id").neq("user_id", U.userId).limit(1);
check("RLS: مستخدم عادي لا يقرأ وظائف غيره", (directRag.data?.length ?? 0) === 0);
const directAudit = await U.client.from("admin_audit_logs").select("id").limit(1);
check("RLS: مستخدم عادي لا يقرأ سجل التدقيق", (directAudit.data?.length ?? 0) === 0);
const selfPromote = await U.client.from("profiles").update({ role: "admin" }).eq("id", U.userId).select("role");
check("مستخدم عادي لا يرقّي نفسه عبر profiles (RLS/سياسة)", (selfPromote.data?.[0]?.role ?? "user") !== "admin", JSON.stringify(selfPromote.error?.message ?? selfPromote.data));

console.log("\n=== ج) عدم كشف الأسرار في أي استجابة إدارية (للعادي) ===");
const bodies = [];
for (const [m, p] of endpoints) bodies.push(await (await fetch(`${APP}${p}`, { method: m, headers: H(U.cookie) })).text());
const joined = bodies.join(" ");
check("لا تسريب مفاتيح", !/sk-or-[A-Za-z0-9]{10}|sk-ant|eyJ[A-Za-z0-9]{10}/.test(joined));

// ===== اختبارات owner/admin الكاملة (إن توفّر owner مُمهّد) =====
const ownerEmail = process.env.YSD_OWNER_EMAIL;
const ownerPass = process.env.YSD_OWNER_PASSWORD;
if (ownerEmail && ownerPass) {
  console.log("\n=== د) عمليات owner/admin الكاملة ===");
  const oc = createClient(URL_, ANON, { auth: { persistSession: false } });
  const login = await oc.auth.signInWithPassword({ email: ownerEmail, password: ownerPass });
  if (login.error) { console.log("  تعذّر دخول owner:", login.error.message); }
  else {
    const oCookie = cookieOf(login.data.session);
    const ownerId = login.data.user.id;
    check("owner يدخل Admin API (200)", (await fetch(`${APP}/api/admin/users`, { headers: H(oCookie) })).status === 200);

    // owner يرقّي مستخدمًا إلى admin
    const promote = await fetch(`${APP}/api/admin/users/${U.userId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "role", role: "admin" }) });
    check("owner يرقّي مستخدمًا إلى admin (200)", promote.status === 200, `HTTP ${promote.status}`);

    // admin (U الآن) يحاول ترقية نفسه إلى owner → يُرفض
    const uPromoteSelf = await U.client.rpc("admin_set_user_role", { p_target: U.userId, p_role: "owner" });
    check("admin لا يرقّي نفسه إلى owner", uPromoteSelf.data === "cannot_self" || uPromoteSelf.data === "owner_only", String(uPromoteSelf.data));

    // admin يحاول تعديل owner → owner_only
    const uEditOwner = await U.client.rpc("admin_set_user_role", { p_target: ownerId, p_role: "user" });
    check("admin لا يعدّل owner (owner_only)", uEditOwner.data === "owner_only" || uEditOwner.data === "cannot_self", String(uEditOwner.data));

    // admin يحظر مستخدمًا عاديًا (مسموح)
    const ban = await fetch(`${APP}/api/admin/users/${V.userId}`, { method: "PATCH", headers: H(U.cookie), body: JSON.stringify({ op: "status", status: "ai_suspended" }) });
    check("admin يعلّق AI لمستخدم عادي (200)", ban.status === 200, `HTTP ${ban.status}`);
    // المستخدم المعلّق لا يستطيع المحادثة
    const vConv = (await (await fetch(`${APP}/api/conversations`, { method: "POST", headers: H(V.cookie), body: "{}" })).json())?.conversation?.id;
    const vChat = await fetch(`${APP}/api/chat`, { method: "POST", headers: H(V.cookie), body: JSON.stringify({ conversationId: vConv, modelId: "ysd/free", message: "مرحبا" }) });
    check("المستخدم المعلّق يُمنع من AI (403)", vChat.status === 403, `HTTP ${vChat.status}`);

    // سجل التدقيق يحوي العمليات
    const audit = await (await fetch(`${APP}/api/admin/audit`, { headers: H(oCookie) })).json();
    check("سجل التدقيق يحوي عمليات", (audit.logs?.length ?? 0) > 0, `logs=${audit.logs?.length}`);
    check("سجل التدقيق يحوي user.role و user.status", audit.logs.some((l) => l.action === "user.role") && audit.logs.some((l) => l.action === "user.status"));
    check("سجل التدقيق لا يحوي أسرارًا", !/sk-or|password|token/i.test(JSON.stringify(audit.logs)));

    // تنظيف: أعِد U إلى user وV إلى active
    await fetch(`${APP}/api/admin/users/${U.userId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "role", role: "user" }) });
    await fetch(`${APP}/api/admin/users/${V.userId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "status", status: "active" }) });
  }
} else {
  console.log("\n=== د) عمليات owner/admin الكاملة — متخطاة (لا YSD_OWNER_EMAIL/PASSWORD) ===");
}

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
