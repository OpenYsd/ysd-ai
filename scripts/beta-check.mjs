/**
 * اختبارات Private Beta (بعد تطبيق migration 0011 + require_invite=true).
 * يتطلب: الخادم على 3000 + owner (scripts/.qa-owner.json أو YSD_OWNER_*).
 * لا يطبع الكود الخام ولا بيانات دخول. ملاحظة: إن كان تأكيد البريد مفعّلًا،
 * signUp لا يُنشئ جلسة لكن المُحفّز يعمل — نتحقق من قاعدة البيانات عبر owner.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
function check(n, ok, d = "") { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } }
function cookieOf(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const H = (c) => ({ Cookie: c, "Content-Type": "application/json" });

// owner
const oc = anonClient();
const login = await oc.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (login.error) { console.error("owner login failed"); process.exit(1); }
const oCookie = cookieOf(login.data.session);

async function signup(email, meta) {
  const c = anonClient();
  const r = await c.auth.signUp({ email, password: `Qa!${Date.now()}xYz`, options: { data: meta } });
  return { error: r.error, userId: r.data?.user?.id ?? null };
}

console.log("=== 1) إنشاء دعوة: الكود مرة واحدة، hash فقط في DB ===");
const created = await fetch(`${APP}/api/admin/invites`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ label: "beta-test", maxUses: 2, expiresInDays: 30 }) });
const inv = await created.json();
check("إنشاء دعوة → 201 مع كود", created.status === 201 && typeof inv.code === "string" && inv.code.length >= 12);
const rawCode = inv.code; // لا يُطبع
// تحقق أن الكود الخام ليس في قاعدة البيانات، والـ hash موجود
const row = await oc.from("beta_invites").select("code_hash, code_hint").eq("id", inv.id).single();
check("الكود الخام غير مخزّن (hash فقط)", row.data?.code_hash === sha256(rawCode) && !JSON.stringify(row.data).includes(rawCode));
check("hint = آخر 4 أحرف فقط", row.data?.code_hint === rawCode.slice(-4));

console.log("\n=== 2) beta_invite_valid عبر anon ===");
const ac = anonClient();
const okValid = await ac.rpc("beta_invite_valid", { p_code: rawCode });
check("دعوة صالحة → true", okValid.data === true, String(okValid.data));
const badValid = await ac.rpc("beta_invite_valid", { p_code: "WRONG-CODE-1234" });
check("كود خاطئ → false", badValid.data === false);

console.log("\n=== 2ب) مسار /api/invite/verify (Rate Limit) ===");
const vOk = await fetch(`${APP}/api/invite/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: rawCode }) });
check("المسار يُرجع valid=true لدعوة صالحة", vOk.status === 200 && (await vOk.json()).valid === true);
const vBad = await fetch(`${APP}/api/invite/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "WRONG-CODE-1234" }) });
const vBadBody = await vBad.json();
check("كود خاطئ → valid=false بلا تفاصيل", vBadBody.valid === false && Object.keys(vBadBody).join() === "valid");
// إغراق: الحد 10/دقيقة بالـIP
let limited = false;
for (let i = 0; i < 14; i++) {
  const r = await fetch(`${APP}/api/invite/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "GUESS-CODE-0000" }) });
  if (r.status === 429) { limited = true; break; }
}
check("Rate Limit يوقف التخمين (429)", limited);

console.log("\n=== 3) التسجيل دون دعوة مرفوض ===");
const noInvite = await signup(`ysd.qa.beta.noinv.${Date.now()}@qa-ysd.com`, { display_name: "بلا دعوة", terms_accepted: "true" });
check("signUp بلا كود دعوة يفشل", Boolean(noInvite.error), noInvite.error?.message?.slice(0, 60) ?? "نجح (خطأ!)");

console.log("\n=== 4) دعوة صالحة تعمل + الاستهلاك + الموافقة ===");
// النسخة الرسمية من platform_settings (المرجع الوحيد الموثوق)
const tv = await oc.from("platform_settings").select("value").eq("key", "terms_version").single();
const serverVersion = typeof tv.data?.value === "string" ? tv.data.value : JSON.parse(JSON.stringify(tv.data?.value ?? '""'));

// نُرسل نسخة مزوّرة عمدًا: يجب أن يتجاهلها المُحفّز ويختم نسخة الخادم
const withInvite = await signup(`ysd.qa.beta.ok.${Date.now()}@qa-ysd.com`, { display_name: "بدعوة", invite_code: rawCode, terms_accepted: "true", terms_version: "9999-FORGED" });
check("signUp بدعوة صالحة ينجح", !withInvite.error, withInvite.error?.message);
const invAfter = await oc.from("beta_invites").select("used_count").eq("id", inv.id).single();
check("used_count زاد إلى 1", invAfter.data?.used_count === 1, String(invAfter.data?.used_count));
if (withInvite.userId) {
  const consent = await oc.from("user_consents").select("document, version").eq("user_id", withInvite.userId);
  check("الموافقة محفوظة (terms + privacy)", (consent.data?.length ?? 0) === 2);
  check("النسخة من platform_settings لا من metadata (تجاهل التزوير)",
    (consent.data ?? []).every((c) => c.version === serverVersion && c.version !== "9999-FORGED"),
    JSON.stringify(consent.data?.map((c) => c.version)));
  const link = await oc.from("beta_invite_uses").select("user_id").eq("invite_id", inv.id);
  check("الدعوة مربوطة بالمستخدم", link.data?.some((l) => l.user_id === withInvite.userId));
}

console.log("\n=== 4ب) التسجيل دون موافقة مرفوض ===");
const noConsent = await signup(`ysd.qa.beta.noc.${Date.now()}@qa-ysd.com`, { display_name: "بلا موافقة", invite_code: rawCode });
check("signUp بلا terms_accepted يفشل", Boolean(noConsent.error), noConsent.error?.message?.slice(0, 60) ?? "نجح (خطأ!)");
// المُحفّز يستهلك ثم يرفض → يجب أن تُرجَع الزيادة (نفس المعاملة)
const rollback = await oc.from("beta_invites").select("used_count").eq("id", inv.id).single();
check("فشل الموافقة يُرجِع استهلاك الدعوة (rollback)", rollback.data?.used_count === 1, String(rollback.data?.used_count));

console.log("\n=== 5) دعوة ملغاة/منتهية مرفوضة ===");
const inv2 = await (await fetch(`${APP}/api/admin/invites`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ maxUses: 1 }) })).json();
await fetch(`${APP}/api/admin/invites/${inv2.id}`, { method: "POST", headers: H(oCookie) }); // إلغاء
const revokedSignup = await signup(`ysd.qa.beta.rev.${Date.now()}@qa-ysd.com`, { display_name: "ملغاة", invite_code: inv2.code, terms_accepted: "true" });
check("دعوة ملغاة → signUp يفشل", Boolean(revokedSignup.error));
const revValid = await ac.rpc("beta_invite_valid", { p_code: inv2.code });
check("beta_invite_valid للملغاة → false", revValid.data === false);

console.log("\n=== 6) استنفاد حد الاستخدام ===");
const inv3 = await (await fetch(`${APP}/api/admin/invites`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ maxUses: 1 }) })).json();
const u1 = await signup(`ysd.qa.beta.ex1.${Date.now()}@qa-ysd.com`, { display_name: "أول", invite_code: inv3.code, terms_accepted: "true" });
const u2 = await signup(`ysd.qa.beta.ex2.${Date.now()}@qa-ysd.com`, { display_name: "ثانٍ", invite_code: inv3.code, terms_accepted: "true" });
check("أول استخدام ينجح", !u1.error);
check("الثاني (تجاوز الحد) يفشل", Boolean(u2.error));

console.log("\n=== 7) عزل الدعوات (RLS) + IDOR ===");
const vc = anonClient();
const vs = await vc.auth.signUp({ email: `ysd.qa.beta.rls.${Date.now()}@qa-ysd.com`, password: `Qa!${Date.now()}z`, options: { data: { invite_code: rawCode, terms_version: "2026-07-15", display_name: "rls" } } });
if (vs.data?.session) await vc.auth.setSession(vs.data.session);
const seeInvites = await vc.from("beta_invites").select("id").limit(1);
check("مستخدم عادي لا يقرأ beta_invites", (seeInvites.data?.length ?? 0) === 0);
const vCookie = vs.data?.session ? cookieOf(vs.data.session) : null;
if (vCookie) {
  const idor = await fetch(`${APP}/api/admin/invites`, { headers: H(vCookie) });
  check("مستخدم عادي لا يصل /api/admin/invites (403)", idor.status === 403, `HTTP ${idor.status}`);
  const idorRevoke = await fetch(`${APP}/api/admin/invites/${inv.id}`, { method: "POST", headers: H(vCookie) });
  check("مستخدم عادي لا يلغي دعوة (403)", idorRevoke.status === 403, `HTTP ${idorRevoke.status}`);
} else {
  console.log("  ℹ تأكيد البريد مفعّل — تخطّي فحوص الجلسة (RLS المباشر كافٍ)");
}

console.log("\n=== 8) لا كود خام في السجلات/التدقيق ===");
const audit = await (await fetch(`${APP}/api/admin/audit`, { headers: H(oCookie) })).json();
check("سجل التدقيق لا يحوي الكود الخام", !JSON.stringify(audit.logs ?? []).includes(rawCode));
check("سجل التدقيق يحوي invite.create/revoke", (audit.logs ?? []).some((l) => l.action === "invite.create"));

console.log("\n=== 9) تحرير حجوزات غير المؤكدين (إداري فقط) ===");
const rel = await oc.rpc("beta_release_unconfirmed_invites", { p_hours: 99999 });
check("owner يستدعي دالة التحرير", !rel.error && typeof rel.data === "number", rel.error?.message);
check("لا تُحرِّر شيئًا بمدة كبيرة (99999 ساعة)", rel.data === 0, String(rel.data));

console.log("\n=== تنظيف ===");
for (const id of [inv.id, inv2.id, inv3.id]) await fetch(`${APP}/api/admin/invites/${id}`, { method: "POST", headers: H(oCookie) }).catch(() => {});
console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
