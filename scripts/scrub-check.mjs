/**
 * تحقق من إصلاح 0012: invite_code لا يظهر في أي موضع.
 * يتطلب: migration 0012 مطبّقة + Confirm email = OFF مؤقتًا + كود دعوة صالح
 * في scripts/.qa-invite.txt (لا يُطبع أبدًا — نفحص وجود المفتاح لا قيمته).
 *
 * يفحص: signUp / auth.users / auth.identities / getUser / تسجيل دخول جديد /
 * refreshSession + JWT، ويتحقق أن البوابة لم تنكسر.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } };
/** وجود المفتاح فقط — لا نطبع أي قيمة إطلاقًا */
const hasCode = (o) => Boolean(o) && "invite_code" in o;
const keys = (o) => Object.keys(o ?? {}).join(",");
const jwtMeta = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64").toString("utf8")).user_metadata ?? {};
/** identity_data لكل هويات المستخدم (auth.identities غير مكشوف عبر PostgREST،
 *  لكن GoTrue يُعيدها ضمن كائن المستخدم في حقل identities) */
const identityDatas = (u) => (u?.identities ?? []).map((i) => i.identity_data ?? {});

let code;
try { code = readFileSync(new URL("./.qa-invite.txt", import.meta.url), "utf8").trim(); }
catch { console.error("❌ لا يوجد scripts/.qa-invite.txt"); process.exit(1); }
console.log(`قُرئ كود الدعوة (طوله ${code.length} — لا يُطبع)\n`);

const email = `ysd.qa.scrub.${Date.now()}@qa-ysd.com`;
const password = `Ysd!Qa${Math.random().toString(36).slice(2, 12)}Z9`;
const c = anon();

console.log("=== 1) نتيجة signUp الأولية ===");
const su = await c.auth.signUp({ email, password, options: { data: { display_name: "QA Scrub", terms_accepted: "true", invite_code: code } } });
if (su.error) { console.error(`❌ فشل التسجيل بالدعوة: ${su.error.message}`); process.exit(1); }
check("البوابة لم تنكسر — التسجيل بالدعوة نجح", Boolean(su.data.user));
if (!su.data.session) { console.error("❌ لا جلسة — اضبط Confirm email = OFF مؤقتًا لهذا الفحص"); process.exit(2); }
const suUserClean = !hasCode(su.data.user.user_metadata);
const suIdentClean = identityDatas(su.data.user).every((d) => !hasCode(d));
const suJwtClean = !hasCode(jwtMeta(su.data.session.access_token));
check("signUp: لا invite_code في user_metadata", suUserClean, keys(su.data.user.user_metadata));
check("signUp: لا invite_code في identities[].identity_data", suIdentClean, identityDatas(su.data.user).map(keys).join(" | "));
check("signUp: لا invite_code في JWT", suJwtClean, keys(jwtMeta(su.data.session.access_token)));

console.log("\n=== 2+3) تسجيل دخول جديد (GoTrue يقرأ من القاعدة) ===");
const li = await anon().auth.signInWithPassword({ email, password });
check("تسجيل الدخول نجح", !li.error, li.error?.message);
check("auth.users: لا invite_code في user_metadata", !hasCode(li.data.user?.user_metadata), keys(li.data.user?.user_metadata));
check("auth.identities: لا invite_code في identity_data", identityDatas(li.data.user).every((d) => !hasCode(d)), identityDatas(li.data.user).map(keys).join(" | "));
check("JWT بعد تسجيل الدخول: لا invite_code", !hasCode(jwtMeta(li.data.session.access_token)));

console.log("\n=== 4) getUser() ===");
const c2 = anon();
await c2.auth.setSession(li.data.session);
const gu = await c2.auth.getUser();
check("getUser(): لا invite_code في user_metadata", !hasCode(gu.data.user?.user_metadata), keys(gu.data.user?.user_metadata));
check("getUser(): لا invite_code في identity_data", identityDatas(gu.data.user).every((d) => !hasCode(d)));

console.log("\n=== 5) refreshSession + JWT الجديد ===");
const rs = await c2.auth.refreshSession();
check("refreshSession نجح", !rs.error, rs.error?.message);
check("JWT بعد التحديث: لا invite_code", !hasCode(jwtMeta(rs.data.session.access_token)), keys(jwtMeta(rs.data.session.access_token)));
check("user_metadata بعد التحديث: لا invite_code", !hasCode(rs.data.user?.user_metadata));

console.log("\n=== 6) البوابة سليمة: الاستهلاك مرة واحدة + الموافقة محفوظة ===");
const consents = await c2.from("user_consents").select("document, version").eq("user_id", su.data.user.id);
check("الموافقة محفوظة للوثيقتين", (consents.data?.length ?? 0) === 2, JSON.stringify(consents.data?.map((x) => x.document)));
check("terms_accepted باقٍ (لم نُجرّد إلا الكود)", "terms_accepted" in (rs.data.user?.user_metadata ?? {}));
check("display_name باقٍ", "display_name" in (rs.data.user?.user_metadata ?? {}));
check("مطالبات الهوية باقية (sub/email)", identityDatas(rs.data.user).every((d) => "sub" in d || "email" in d), identityDatas(rs.data.user).map(keys).join(" | "));
const uses = await c2.from("beta_invite_uses").select("invite_id").eq("user_id", su.data.user.id);
check("الدعوة مربوطة بالمستخدم مرة واحدة بالضبط", (uses.data?.length ?? 0) === 1, String(uses.data?.length));

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
console.log(`حساب QA المُنشأ (احذفه لاحقًا): ${email}`);
if (!suUserClean || !suJwtClean || !suIdentClean) {
  console.log("\n⚠️  الكود ظهر في استجابة signUp أو JWT رغم مُحفّزات التجريد:");
  console.log("    GoTrue يبني الاستجابة والـJWT من كائنه في الذاكرة، لا من القاعدة.");
  console.log("    ⇒ حل الـTriggers غير كافٍ — انتقل إلى رمز تسجيل مؤقت أحادي الاستخدام.");
}
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
