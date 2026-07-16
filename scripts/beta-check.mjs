/**
 * اختبارات Private Beta الحية (بعد migration 0011).
 * يتطلب: الخادم على 3000 + حساب QA owner في scripts/.qa-owner.json.
 * ملاحظة: أقسام التسجيل تتطلب Confirm email = OFF مؤقتًا (وإلا لا تُنشأ جلسة
 * للمستخدم العادي فيتعذّر اختبار banned/الصيانة). البند 7 (بريد التأكيد الحقيقي)
 * يُختبر يدويًا من المتصفح.
 * لا يطبع الكود الخام ولا كلمات المرور ولا access tokens.
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
function cookieOf(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const H = (c) => ({ Cookie: c, "Content-Type": "application/json" });
const genCode = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(16);
  let o = ""; for (let i = 0; i < 16; i++) o += a[b[i] % a.length];
  return `${o.slice(0, 4)}-${o.slice(4, 8)}-${o.slice(8, 12)}-${o.slice(12, 16)}`;
};

const oc = anonClient();
const login = await oc.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (login.error) { console.error("owner login failed"); process.exit(1); }
const oCookie = cookieOf(login.data.session);

const created = [];
async function newInvite(body) {
  const r = await fetch(`${APP}/api/admin/invites`, { method: "POST", headers: H(oCookie), body: JSON.stringify(body) });
  const j = await r.json(); created.push(j.id); return { status: r.status, ...j };
}
async function signup(tag, meta) {
  const c = anonClient();
  const r = await c.auth.signUp({ email: `ysd.qa.${tag}.${Date.now()}${Math.floor(Math.random() * 999)}@qa-ysd.com`, password: `Qa!${Date.now()}xYz`, options: { data: meta } });
  return { error: r.error, userId: r.data?.user?.id ?? null, session: r.data?.session ?? null };
}
const inviteRow = async (id) => (await (await fetch(`${APP}/api/admin/invites`, { headers: H(oCookie) })).json()).invites.find((i) => i.id === id);

console.log("=== 1) إنشاء دعوة: الكود مرة واحدة، hash فقط في DB ===");
const inv = await newInvite({ label: "beta-test", maxUses: 2, expiresInDays: 30 });
check("إنشاء دعوة → 201 مع كود", inv.status === 201 && typeof inv.code === "string" && inv.code.length === 19);
const rawCode = inv.code; // لا يُطبع أبدًا
const row = await oc.from("beta_invites").select("code_hash, code_hint").eq("id", inv.id).single();
check("الكود الخام غير مخزّن (hash فقط)", row.data?.code_hash === sha256(rawCode) && !JSON.stringify(row.data).includes(rawCode));
check("hint = آخر 4 أحرف فقط", row.data?.code_hint === rawCode.slice(-4));

console.log("\n=== 2) beta_invite_valid + مسار التحقق ===");
const ac = anonClient();
check("دعوة صالحة → true", (await ac.rpc("beta_invite_valid", { p_code: rawCode })).data === true);
check("كود خاطئ → false", (await ac.rpc("beta_invite_valid", { p_code: "WRONG-CODE-1234" })).data === false);
const vr = await fetch(`${APP}/api/invite/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: rawCode }) });
const vb = await vr.json();
check("المسار يُرجع {valid:true} فقط بلا تفاصيل", vb.valid === true && Object.keys(vb).join() === "valid");

console.log("\n=== 3) التسجيل دون دعوة/دون موافقة مرفوض ===");
check("signUp بلا كود دعوة يفشل", Boolean((await signup("noinv", { display_name: "بلا دعوة", terms_accepted: "true" })).error));
check("signUp بكود غير موجود يفشل", Boolean((await signup("badinv", { display_name: "خاطئ", terms_accepted: "true", invite_code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" })).error));
const noConsent = await signup("nocon", { display_name: "بلا موافقة", invite_code: rawCode });
check("signUp بلا terms_accepted يفشل", Boolean(noConsent.error));
check("فشل الموافقة يُرجِع استهلاك الدعوة (rollback)", (await inviteRow(inv.id))?.used_count === 0, String((await inviteRow(inv.id))?.used_count));

console.log("\n=== 4) دعوة صالحة: الاستهلاك + الموافقة بنسخة الخادم + محو الكود ===");
const tv = await oc.from("platform_settings").select("value").eq("key", "terms_version").single();
const serverVersion = String(tv.data?.value).replace(/^"|"$/g, "");
const u1 = await signup("ok", { display_name: "بدعوة", invite_code: rawCode, terms_accepted: "true", terms_version: "9999-FORGED" });
check("signUp بدعوة صالحة ينجح", !u1.error, u1.error?.message);
check("used_count زاد إلى 1", (await inviteRow(inv.id))?.used_count === 1);
if (u1.userId) {
  const consent = await oc.from("user_consents").select("document, version").eq("user_id", u1.userId);
  check("الموافقة محفوظة للوثيقتين", (consent.data?.length ?? 0) === 2);
  check("النسخة من platform_settings لا من metadata (تجاهل التزوير)",
    (consent.data ?? []).every((c) => c.version === serverVersion && c.version !== "9999-FORGED"),
    JSON.stringify(consent.data?.map((c) => c.version)));
  check("الدعوة مربوطة بالمستخدم", (await oc.from("beta_invite_uses").select("user_id").eq("invite_id", inv.id)).data?.some((l) => l.user_id === u1.userId));
  if (u1.session) check("الكود الخام مُحي من raw_user_meta_data", !("invite_code" in (u1.session.user.user_metadata ?? {})), JSON.stringify(Object.keys(u1.session.user.user_metadata ?? {})));
}

console.log("\n=== 5) ملغاة / منتهية / مستنفدة مرفوضة ===");
const inv2 = await newInvite({ maxUses: 1 });
await fetch(`${APP}/api/admin/invites/${inv2.id}`, { method: "POST", headers: H(oCookie) });
check("دعوة ملغاة → signUp يفشل", Boolean((await signup("rev", { display_name: "ملغاة", invite_code: inv2.code, terms_accepted: "true" })).error));
check("beta_invite_valid للملغاة → false", (await ac.rpc("beta_invite_valid", { p_code: inv2.code })).data === false);

// منتهية: عبر RPC مباشرة (المسار يفرض ≥ يوم واحد، والـRPC يقبل أي تاريخ)
const expCode = genCode();
const expId = await oc.rpc("admin_create_invite", { p_code_hash: sha256(expCode), p_code_hint: expCode.slice(-4), p_label: "qa-expired", p_max_uses: 1, p_expires_at: new Date(Date.now() - 3600_000).toISOString() });
created.push(expId.data);
check("beta_invite_valid للمنتهية → false", (await ac.rpc("beta_invite_valid", { p_code: expCode })).data === false);
check("دعوة منتهية → signUp يفشل", Boolean((await signup("exp", { display_name: "منتهية", invite_code: expCode, terms_accepted: "true" })).error));
check("حالة المنتهية في الواجهة = expired", (await inviteRow(expId.data))?.status === "expired");

const inv3 = await newInvite({ maxUses: 1 });
check("أول استخدام ينجح", !(await signup("ex1", { display_name: "أول", invite_code: inv3.code, terms_accepted: "true" })).error);
check("الثاني (تجاوز الحد) يفشل", Boolean((await signup("ex2", { display_name: "ثانٍ", invite_code: inv3.code, terms_accepted: "true" })).error));
check("حالة المستنفدة = exhausted", (await inviteRow(inv3.id))?.status === "exhausted");

console.log("\n=== 6) التزامن على آخر استخدام: حساب واحد فقط ينجح ===");
const invC = await newInvite({ maxUses: 1 });
const [r1, r2] = await Promise.all([
  signup("c1", { display_name: "متزامن1", invite_code: invC.code, terms_accepted: "true" }),
  signup("c2", { display_name: "متزامن2", invite_code: invC.code, terms_accepted: "true" }),
]);
const wins = [r1, r2].filter((r) => !r.error).length;
check("طلبان متزامنان → ناجح واحد فقط", wins === 1, `ناجح=${wins}`);
check("used_count = 1 بالضبط (لا تجاوز)", (await inviteRow(invC.id))?.used_count === 1, String((await inviteRow(invC.id))?.used_count));

console.log("\n=== 7) عزل الدعوات (RLS) + IDOR ===");
const invU = await newInvite({ maxUses: 1 });
const victim = await signup("rls", { display_name: "عادي", invite_code: invU.code, terms_accepted: "true" });
const vCookie = victim.session ? cookieOf(victim.session) : null;
if (!vCookie) {
  console.log("  ℹ لا جلسة للمستخدم العادي (تأكيد البريد مفعّل) — تُتخطّى فحوص banned/الصيانة");
} else {
  const vc = createClient(URL_, ANON, { auth: { persistSession: false } });
  await vc.auth.setSession(victim.session);
  check("مستخدم عادي لا يقرأ beta_invites", ((await vc.from("beta_invites").select("id").limit(1)).data?.length ?? 0) === 0);
  check("مستخدم عادي لا يقرأ موافقات غيره", ((await vc.from("user_consents").select("user_id").neq("user_id", victim.userId)).data?.length ?? 0) === 0);
  check("مستخدم عادي لا يصل /api/admin/invites (403)", (await fetch(`${APP}/api/admin/invites`, { headers: H(vCookie) })).status === 403);
  check("مستخدم عادي لا يلغي دعوة (403)", (await fetch(`${APP}/api/admin/invites/${inv.id}`, { method: "POST", headers: H(vCookie) })).status === 403);

  console.log("\n=== 8) وضع الصيانة: يمنع العادي (صفحات + APIs) ويسمح للطاقم ===");
  const setMaint = (v) => fetch(`${APP}/api/admin/settings`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ key: "maintenance_mode", value: v }) });
  try {
    check("تفعيل الصيانة (owner) → 200", (await setMaint(true)).status === 200);
    const page = await fetch(`${APP}/chat`, { headers: { Cookie: vCookie }, redirect: "manual" });
    check("العادي: صفحة خاصة → تحويل إلى /maintenance", [302, 307].includes(page.status) && (page.headers.get("location") ?? "").includes("/maintenance"), `HTTP ${page.status}`);
    const apiRes = await fetch(`${APP}/api/conversations`, { headers: H(vCookie) });
    check("العادي: API خاصة → 503", apiRes.status === 503, `HTTP ${apiRes.status}`);
    const ownerPage = await fetch(`${APP}/admin`, { headers: { Cookie: oCookie }, redirect: "manual" });
    check("owner: الصفحات مسموحة أثناء الصيانة", ownerPage.status === 200, `HTTP ${ownerPage.status}`);
    check("owner: APIs مسموحة أثناء الصيانة", (await fetch(`${APP}/api/admin/invites`, { headers: H(oCookie) })).status === 200);
    check("/api/health يبقى عامًا أثناء الصيانة", (await fetch(`${APP}/api/health`)).status === 200);
  } finally {
    const off = await setMaint(false);
    check("إيقاف الصيانة (استرجاع) → 200", off.status === 200);
  }

  console.log("\n=== 9) banned: ممنوع من كل الصفحات والـAPIs الخاصة ===");
  const ban = (s) => fetch(`${APP}/api/admin/users/${victim.userId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "status", status: s }) });
  check("حظر المستخدم (owner) → 200", (await ban("banned")).status === 200);
  const banPage = await fetch(`${APP}/chat`, { headers: { Cookie: vCookie }, redirect: "manual" });
  check("banned: صفحة خاصة → تحويل إلى /suspended", [302, 307].includes(banPage.status) && (banPage.headers.get("location") ?? "").includes("/suspended"), `HTTP ${banPage.status}`);
  for (const p of ["/api/conversations", "/api/files", "/api/projects", "/api/preferences", "/api/profile"]) {
    check(`banned: ${p} → 403`, (await fetch(`${APP}${p}`, { headers: H(vCookie) })).status === 403);
  }
  const banChat = await fetch(`${APP}/api/chat`, { method: "POST", headers: H(vCookie), body: JSON.stringify({ conversationId: null, content: "مرحبا" }) });
  check("banned: /api/chat → 403", banChat.status === 403, `HTTP ${banChat.status}`);
  check("banned: الصفحات العامة تبقى متاحة", (await fetch(`${APP}/terms`, { headers: { Cookie: vCookie }, redirect: "manual" })).status === 200);
  await ban("active");
}

console.log("\n=== 10) لا كود خام في التدقيق ===");
const audit = await (await fetch(`${APP}/api/admin/audit`, { headers: H(oCookie) })).json();
const auditText = JSON.stringify(audit.logs ?? []);
check("سجل التدقيق لا يحوي الكود الخام", !auditText.includes(rawCode) && !auditText.includes(inv2.code) && !auditText.includes(expCode));
check("سجل التدقيق يحوي invite.create", (audit.logs ?? []).some((l) => l.action === "invite.create"));

console.log("\n=== تنظيف الدعوات ===");
for (const id of created.filter(Boolean)) await fetch(`${APP}/api/admin/invites/${id}`, { method: "POST", headers: H(oCookie) }).catch(() => {});
console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
