/**
 * اختبارات Private Beta الحية الكاملة (بعد 0011 + 0012 + 0013).
 * يتطلب: الخادم على 3000 + حساب QA owner في scripts/.qa-owner.json
 *         + Confirm email = OFF مؤقتًا (وإلا لا جلسة لمستخدم عادي).
 * البند «بريد التأكيد الحقيقي» يُختبر يدويًا من المتصفح.
 *
 * لا يطبع أي كود دعوة ولا تذكرة ولا مفتاح ولا كلمة مرور ولا access token.
 * يُنشئ دعواته بنفسه (بجلسة owner) — دعوة مستقلة لكل سيناريو، حتى لا تتراكم
 * التذاكر النشطة على دعوة واحدة فتصطدم بحد الـ3.
 * يُعيد كل الحالات المُعدَّلة (الصيانة، حالة المستخدم) إلى أصلها في finally.
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = "http://localhost:3000";
const projectRef = new URL(URL_).host.split(".")[0];
let creds;
try { creds = JSON.parse(readFileSync(new URL("./.qa-owner.json", import.meta.url), "utf8")); }
catch { creds = { email: process.env.YSD_OWNER_EMAIL, password: process.env.YSD_OWNER_PASSWORD }; }

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } });
function cookieOf(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
const H = (c) => ({ Cookie: c, "Content-Type": "application/json" });

const oc = anonClient();
const login = await oc.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (login.error) { console.error("owner login failed"); process.exit(1); }
const oCookie = cookieOf(login.data.session);
const me = await oc.from("profiles").select("role").eq("id", login.data.user.id).single();
if (!["owner", "admin"].includes(me.data?.role)) { console.error(`الحساب ليس owner (role=${me.data?.role}) — رقّه أولًا`); process.exit(1); }
console.log(`جلسة owner جاهزة (role=${me.data.role})`);

const madeInvites = [];
async function newInvite({ maxUses = 1, expiresInDays = 30, label = "qa" } = {}) {
  const r = await fetch(`${APP}/api/admin/invites`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ maxUses, expiresInDays, label }) });
  const j = await r.json(); madeInvites.push(j.id); return { status: r.status, ...j };
}
const genCode = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(16); let o = ""; for (let i = 0; i < 16; i++) o += a[b[i] % a.length]; return `${o.slice(0,4)}-${o.slice(4,8)}-${o.slice(8,12)}-${o.slice(12,16)}`; };

/**
 * إدراج دعوة مباشرة بجلسة owner — سياسة invites_admin_all تسمح به للمشرف.
 * نستخدمه للتجهيزات التي تحتاج تاريخ انتهاء دقيقًا (ثوانٍ أو ماضٍ)، وهو ما لم
 * يعد ممكنًا عبر admin_create_invite بعد 0015 (تستقبل أيامًا بين 1 و365 فقط،
 * وتحسب التاريخ بـ now() في القاعدة).
 */
async function insertInvite({ maxUses = 1, expiresAtIso = null, label = "qa-fixture" } = {}) {
  const code = genCode();
  const r = await oc.from("beta_invites")
    .insert({ code_hash: sha256(code), code_hint: code.slice(-4), label, max_uses: maxUses, expires_at: expiresAtIso })
    .select("id, created_at").single();
  if (r.data?.id) madeInvites.push(r.data.id);
  return { id: r.data?.id, code, createdAt: r.data?.created_at, error: r.error };
}

/**
 * انحراف ساعة القاعدة عن ساعة الجهاز. حاسم لتجهيزات الانتهاء: الإنفاذ يقارن
 * expires_at بـ now() في القاعدة، فلو حسبنا التاريخ بساعتنا المنحرفة لأنشأنا
 * دعوة «منتهية سلفًا» بحساب القاعدة، فيفشل claim ويمرّ فحص الانتهاء زائفًا.
 * (قيس هنا 194 ثانية — ولهذا السبب نفسه وُجدت 0015.)
 */
async function measureDbSkewMs() {
  const t0 = Date.now();
  const r = await insertInvite({ label: "qa-skew", expiresAtIso: new Date(Date.now() + 3600_000).toISOString() });
  const t1 = Date.now();
  return new Date(r.createdAt).getTime() - (t0 + t1) / 2;
}

/** دعوة تنتهي بعد ثوانٍ **بساعة القاعدة** (ثوانٍ سالبة = منتهية سلفًا) */
async function newInviteExpiringIn(seconds, maxUses = 1) {
  return insertInvite({
    maxUses, label: "qa-expiring",
    expiresAtIso: new Date(Date.now() + dbSkewMs + seconds * 1000).toISOString(),
  });
}
/** الكود → تذكرة (عبر RPC مباشرة: مسار الـAPI مُختبَر في scrub-check، ونتجنّب حدّه) */
async function claim(code) {
  const ticket = randomBytes(32).toString("base64url");
  const r = await anonClient().rpc("beta_claim_invite", { p_code: code, p_ticket_hash: sha256(ticket), p_ttl_seconds: 600 });
  return r.data === true ? ticket : null;
}
async function signupTicket(tag, ticket, extra = {}) {
  const c = anonClient();
  const r = await c.auth.signUp({
    email: `ysd.qa.${tag}.${Date.now()}${Math.floor(Math.random() * 999)}@qa-ysd.com`,
    password: `Qa!${Date.now()}xYz`,
    options: { data: { display_name: `QA ${tag}`, terms_accepted: "true", ...(ticket ? { invite_ticket: ticket } : {}), ...extra } },
  });
  return { error: r.error, userId: r.data?.user?.id ?? null, session: r.data?.session ?? null };
}
const inviteRow = async (id) => (await (await fetch(`${APP}/api/admin/invites`, { headers: H(oCookie) })).json()).invites.find((i) => i.id === id);

const dbSkewMs = await measureDbSkewMs();
console.log(`انحراف ساعة القاعدة عن الجهاز: ${(dbSkewMs / 1000).toFixed(1)} ثانية (يُعوَّض في فحص الانتهاء)\n`);

console.log("=== 1) الدعوة: كود مرة واحدة، hash فقط ===");
const inv = await newInvite({ maxUses: 2, label: "qa-main" });
check("إنشاء دعوة → 201 مع كود", inv.status === 201 && typeof inv.code === "string" && inv.code.length === 19);
const rawCode = inv.code;
const row = await oc.from("beta_invites").select("code_hash, code_hint").eq("id", inv.id).single();
check("الكود الخام غير مخزّن (hash فقط)", row.data?.code_hash === sha256(rawCode) && !JSON.stringify(row.data).includes(rawCode));
check("hint = آخر 4 أحرف فقط", row.data?.code_hint === rawCode.slice(-4));
check("beta_invite_valid لدعوة صالحة → true", (await anonClient().rpc("beta_invite_valid", { p_code: rawCode })).data === true);

console.log("\n=== 2) الرفض: بلا تذكرة / تذكرة مزوّرة / الكود الخام ===");
check("signUp بلا تذكرة يفشل", Boolean((await signupTicket("noticket", null)).error));
check("signUp بتذكرة مزوّرة يفشل", Boolean((await signupTicket("faketicket", "x".repeat(43))).error));
check("signUp بالكود الخام يفشل (المسار القديم ملغى)", Boolean((await signupTicket("rawcode", null, { invite_code: rawCode })).error));
check("signUp بلا موافقة يفشل", Boolean((await signupTicket("noconsent", await claim(rawCode), { terms_accepted: "false" })).error));
check("فشل الموافقة لا يستهلك الدعوة (rollback)", (await inviteRow(inv.id))?.used_count === 0, String((await inviteRow(inv.id))?.used_count));

console.log("\n=== 3) الموافقة: النسخة من الخادم لا من العميل ===");
const tv = await oc.from("platform_settings").select("value").eq("key", "terms_version").single();
const serverVersion = String(tv.data?.value).replace(/^"|"$/g, "");
const u1 = await signupTicket("ok", await claim(rawCode), { terms_version: "9999-FORGED" });
check("signUp بتذكرة صالحة ينجح", !u1.error, u1.error?.message?.slice(0, 60));
check("used_count زاد إلى 1", (await inviteRow(inv.id))?.used_count === 1);
const consent = await oc.from("user_consents").select("document, version").eq("user_id", u1.userId);
check("الموافقة محفوظة للوثيقتين", (consent.data?.length ?? 0) === 2);
check("★ النسخة من platform_settings (تجاهل التزوير)", (consent.data ?? []).every((c) => c.version === serverVersion && c.version !== "9999-FORGED"));
check("الدعوة مربوطة بالمستخدم مرة واحدة", ((await oc.from("beta_invite_uses").select("user_id").eq("invite_id", inv.id)).data ?? []).filter((l) => l.user_id === u1.userId).length === 1);
check("الكود/التذكرة ممحوّان من user_metadata", !("invite_code" in (u1.session?.user.user_metadata ?? {})));

console.log("\n=== 4) ملغاة / منتهية / مستنفدة ===");
const invRev = await newInvite({ maxUses: 1, label: "qa-rev" });
const tRev = await claim(invRev.code);                 // تذكرة قبل الإلغاء
await fetch(`${APP}/api/admin/invites/${invRev.id}`, { method: "POST", headers: H(oCookie) });
check("★ دعوة ملغاة بعد إصدار التذكرة → signUp يفشل", Boolean((await signupTicket("rev", tRev)).error));
check("beta_invite_valid للملغاة → false", (await anonClient().rpc("beta_invite_valid", { p_code: invRev.code })).data === false);

const invExp = await newInviteExpiringIn(8);
const tExp = await claim(invExp.code);                 // تذكرة قبل الانتهاء
check("claim نجح قبل الانتهاء (شرط صحة فحص الانتهاء)", Boolean(tExp), "بلا تذكرة يصبح الفحص التالي باطلًا");
await sleep(9000);
// حاسم: لو كانت tExp فارغة لفشل signUp لانعدام التذكرة لا للانتهاء — نجاح زائف.
const expRes = tExp ? await signupTicket("exp", tExp) : null;
check("★ دعوة منتهية بعد إصدار التذكرة → signUp يفشل",
  Boolean(tExp) && Boolean(expRes?.error),
  tExp ? "" : "الفحص باطل: لم تُصدَر تذكرة قبل الانتهاء");
const invLongExp = await newInviteExpiringIn(-3600);
check("حالة دعوة منتهية منذ ساعة = expired", (await inviteRow(invLongExp.id))?.status === "expired", (await inviteRow(invLongExp.id))?.status);
check("beta_invite_valid للمنتهية → false", (await anonClient().rpc("beta_invite_valid", { p_code: invLongExp.code })).data === false);
check("claim لدعوة منتهية مرفوض", (await claim(invLongExp.code)) === null);

// ★ 0014: الشارة تُحسب بساعة القاعدة. هذه الدعوة منتهية بساعة القاعدة لكنها
// ما زالت «مستقبلية» بساعة جهازي (انحراف ~194ث) — قبل 0014 كانت تظهر active.
const invSkew = await newInviteExpiringIn(-30);
const skewRow = await inviteRow(invSkew.id);
check("★ منتهية بساعة القاعدة لا بساعة التطبيق → expired",
  skewRow?.status === "expired",
  `الحالة=${skewRow?.status} | expires_at أمام ساعة الجهاز بـ${((new Date(skewRow?.expires_at).getTime() - Date.now()) / 1000).toFixed(0)}ث`);
check("الإنفاذ يوافق الشارة (claim مرفوض)", (await claim(invSkew.code)) === null);

// ترتيب 0014: revoked → exhausted → expired → active
// دعوة واحدة تمرّ بالحالات تباعًا: active → exhausted → (منتهية أيضًا) → revoked
console.log("   … دعوة ترتيب: تنتهي بعد 25ث بساعة القاعدة");
const invOrd = await newInviteExpiringIn(25, 1);
const tOrd = await claim(invOrd.code);
check("claim قبل الانتهاء نجح (شرط صحة فحوص الترتيب)", Boolean(tOrd));
const sOrd = tOrd ? await signupTicket("ord", tOrd) : null;
check("التسجيل استنفد الدعوة", Boolean(tOrd) && !sOrd?.error, sOrd?.error?.message?.slice(0, 50));
check("مستنفدة وغير منتهية → exhausted", (await inviteRow(invOrd.id))?.status === "exhausted", (await inviteRow(invOrd.id))?.status);
await sleep(30_000);   // تجاوز نافذة الـ25ث فتصبح منتهية أيضًا
const bothRow = await inviteRow(invOrd.id);
check("★ مستنفدة ومنتهية معًا → exhausted (exhausted يسبق expired)",
  bothRow?.status === "exhausted",
  `الحالة=${bothRow?.status} | used=${bothRow?.used_count}/${bothRow?.max_uses} | انتهت قبل ${((Date.now() - new Date(bothRow?.expires_at).getTime()) / 1000).toFixed(0)}ث بساعة الجهاز`);
await fetch(`${APP}/api/admin/invites/${invOrd.id}`, { method: "POST", headers: H(oCookie) });
check("★ ملغاة + مستنفدة + منتهية → revoked (revoked يتغلب على الجميع)",
  (await inviteRow(invOrd.id))?.status === "revoked", (await inviteRow(invOrd.id))?.status);

const invEx = await newInvite({ maxUses: 1, label: "qa-exh" });
const [tEx1, tEx2] = [await claim(invEx.code), await claim(invEx.code)];
check("أول استخدام ينجح", !(await signupTicket("ex1", tEx1)).error);
check("★ الثاني (تجاوز الحد) يفشل", Boolean((await signupTicket("ex2", tEx2)).error));
check("حالة المستنفدة = exhausted", (await inviteRow(invEx.id))?.status === "exhausted");

console.log("\n=== 5) التزامن على آخر استخدام ===");
const invC = await newInvite({ maxUses: 1, label: "qa-conc" });
const [tc1, tc2] = [await claim(invC.code), await claim(invC.code)];
const [rc1, rc2] = await Promise.all([signupTicket("c1", tc1), signupTicket("c2", tc2)]);
const wins = [rc1, rc2].filter((r) => !r.error).length;
check("★ طلبان متزامنان → ناجح واحد فقط", wins === 1, `ناجح=${wins}`);
check("★ used_count = 1 بالضبط (لا تجاوز)", (await inviteRow(invC.id))?.used_count === 1, String((await inviteRow(invC.id))?.used_count));

console.log("\n=== 6) مستخدم عادي: العزل وRLS وIDOR ===");
const invU = await newInvite({ maxUses: 1, label: "qa-user" });
const victim = await signupTicket("rls", await claim(invU.code));
if (!victim.session) { console.error("❌ لا جلسة لمستخدم عادي — اضبط Confirm email = OFF"); process.exit(2); }
const vCookie = cookieOf(victim.session);
const vc = anonClient(); await vc.auth.setSession(victim.session);
check("لا يقرأ beta_invites", ((await vc.from("beta_invites").select("id").limit(1)).data?.length ?? 0) === 0);
check("لا يقرأ invite_tickets", ((await vc.from("invite_tickets").select("ticket_hash").limit(1)).data?.length ?? 0) === 0);
check("لا يقرأ موافقات غيره", ((await vc.from("user_consents").select("user_id").neq("user_id", victim.userId)).data?.length ?? 0) === 0);
check("لا يقرأ استهلاك غيره (usage_events)", ((await vc.from("usage_events").select("user_id").neq("user_id", victim.userId)).data?.length ?? 0) === 0);
check("لا يقرأ محادثات غيره", ((await vc.from("conversations").select("id").neq("user_id", victim.userId)).data?.length ?? 0) === 0);
check("لا يرفع دوره إلى admin (منع تصعيد الامتيازات)", Boolean((await vc.from("profiles").update({ role: "admin" }).eq("id", victim.userId).select()).error));
check("لا يصل /api/admin/invites (403)", (await fetch(`${APP}/api/admin/invites`, { headers: H(vCookie) })).status === 403);
check("لا يلغي دعوة (403)", (await fetch(`${APP}/api/admin/invites/${inv.id}`, { method: "POST", headers: H(vCookie) })).status === 403);
check("لا يصل /api/admin/users (403)", (await fetch(`${APP}/api/admin/users`, { headers: H(vCookie) })).status === 403);
check("/admin يُحوَّل بعيدًا", [302, 307].includes((await fetch(`${APP}/admin`, { headers: { Cookie: vCookie }, redirect: "manual" })).status));

console.log("\n=== 7) usage ===");
check("المستخدم يفتح /usage", (await fetch(`${APP}/usage`, { headers: { Cookie: vCookie }, redirect: "manual" })).status === 200);
check("يقرأ استهلاكه هو", ((await vc.from("usage_events").select("user_id").eq("user_id", victim.userId)).error) === null);
check("owner يقرأ حدود الباقات", (await fetch(`${APP}/api/admin/usage-limits`, { headers: H(oCookie) })).status === 200);

const setMaint = (v) => fetch(`${APP}/api/admin/settings`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ key: "maintenance_mode", value: v }) });
const setStatus = (s) => fetch(`${APP}/api/admin/users/${victim.userId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "status", status: s }) });

try {
  console.log("\n=== 8) وضع الصيانة: الصفحات + الـAPIs ===");
  check("تفعيل الصيانة (owner) → 200", (await setMaint(true)).status === 200);
  const mp = await fetch(`${APP}/chat`, { headers: { Cookie: vCookie }, redirect: "manual" });
  check("العادي: صفحة خاصة → /maintenance", [302, 307].includes(mp.status) && (mp.headers.get("location") ?? "").includes("/maintenance"), `HTTP ${mp.status}`);
  check("★ العادي: API خاصة → 503", (await fetch(`${APP}/api/conversations`, { headers: H(vCookie) })).status === 503);
  check("★ العادي: /api/chat → 503", (await fetch(`${APP}/api/chat`, { method: "POST", headers: H(vCookie), body: "{}" })).status === 503);
  check("owner: الصفحات مسموحة", (await fetch(`${APP}/admin`, { headers: { Cookie: oCookie }, redirect: "manual" })).status === 200);
  check("owner: APIs مسموحة", (await fetch(`${APP}/api/admin/invites`, { headers: H(oCookie) })).status === 200);
  check("/api/health يبقى عامًا", (await fetch(`${APP}/api/health`)).status === 200);
  check("الصفحات العامة تبقى متاحة", (await fetch(`${APP}/terms`, { headers: { Cookie: vCookie }, redirect: "manual" })).status === 200);

  console.log("\n=== 9) banned + ai_suspended ===");
  check("إيقاف الصيانة قبل فحص banned", (await setMaint(false)).status === 200);
  check("حظر المستخدم (owner) → 200", (await setStatus("banned")).status === 200);
  const bp = await fetch(`${APP}/chat`, { headers: { Cookie: vCookie }, redirect: "manual" });
  check("banned: صفحة خاصة → /suspended", [302, 307].includes(bp.status) && (bp.headers.get("location") ?? "").includes("/suspended"), `HTTP ${bp.status}`);
  for (const p of ["/api/conversations", "/api/files", "/api/projects", "/api/preferences", "/api/profile"]) {
    check(`banned: ${p} → 403`, (await fetch(`${APP}${p}`, { headers: H(vCookie) })).status === 403);
  }
  check("banned: /api/chat → 403", (await fetch(`${APP}/api/chat`, { method: "POST", headers: H(vCookie), body: "{}" })).status === 403);
  check("banned: الصفحات العامة تبقى متاحة", (await fetch(`${APP}/terms`, { headers: { Cookie: vCookie }, redirect: "manual" })).status === 200);

  check("تعليق AI (owner) → 200", (await setStatus("ai_suspended")).status === 200);
  check("★ ai_suspended: /api/chat → 403", (await fetch(`${APP}/api/chat`, { method: "POST", headers: H(vCookie), body: "{}" })).status === 403);
  check("★ ai_suspended: بقية المسارات تعمل", (await fetch(`${APP}/api/conversations`, { headers: H(vCookie) })).status === 200);
  check("ai_suspended: الصفحات الخاصة تعمل", (await fetch(`${APP}/chat`, { headers: { Cookie: vCookie }, redirect: "manual" })).status === 200);
} finally {
  console.log("\n=== استرجاع الحالات ===");
  check("الصيانة أُعيدت إلى false", (await setMaint(false)).status === 200);
  check("حالة المستخدم أُعيدت إلى active", (await setStatus("active")).status === 200);
  const s = await oc.from("platform_settings").select("value").eq("key", "maintenance_mode").single();
  check("تأكيد: maintenance_mode = false", s.data?.value === false, JSON.stringify(s.data?.value));
  const p = await oc.from("profiles").select("status").eq("id", victim.userId).single();
  check("تأكيد: status = active", p.data?.status === "active", p.data?.status);
}

console.log("\n=== 10) التدقيق: لا كود ولا تذكرة ===");
const audit = await (await fetch(`${APP}/api/admin/audit`, { headers: H(oCookie) })).json();
const auditText = JSON.stringify(audit.logs ?? []);
check("★ لا كود خام في التدقيق", !auditText.includes(rawCode) && !auditText.includes(invRev.code) && !auditText.includes(invEx.code));
check("لا تذكرة في التدقيق", !auditText.includes(tEx1 ?? "@@") && !auditText.includes(tc1 ?? "@@"));
check("التدقيق يسجّل invite.create و invite.revoke", ["invite.create", "invite.revoke"].every((a) => (audit.logs ?? []).some((l) => l.action === a)));
check("التدقيق يسجّل user.status و setting.update", ["user.status", "setting.update"].every((a) => (audit.logs ?? []).some((l) => l.action === a)));

console.log("\n=== تنظيف الدعوات التجريبية ===");
for (const id of madeInvites.filter(Boolean)) await fetch(`${APP}/api/admin/invites/${id}`, { method: "POST", headers: H(oCookie) }).catch(() => {});
console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
