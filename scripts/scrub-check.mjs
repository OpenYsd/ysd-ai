/**
 * تحقق من إصلاح 0012 + 0013: لا كود دعوة في أي موضع، والتذكرة (إن ظهرت) مستهلَكة.
 * يتطلب: 0012+0013 مطبّقتين + الخادم على 3000 + Confirm email = OFF مؤقتًا
 * + كود دعوة صالح في scripts/.qa-invite.txt (لا يُطبع — نفحص المفاتيح لا القيم).
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
const APP = "http://localhost:3000";
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } };
const has = (o, k) => Boolean(o) && k in o;
const keys = (o) => Object.keys(o ?? {}).join(",");
const jwtMeta = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64").toString("utf8")).user_metadata ?? {};
const identityDatas = (u) => (u?.identities ?? []).map((i) => i.identity_data ?? {});
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
/** كل المواضع التي قد يظهر فيها مفتاح تسجيل */
const spots = (user, token) => [user?.user_metadata ?? {}, ...identityDatas(user), token ? jwtMeta(token) : {}];
const anywhere = (user, token, k) => spots(user, token).some((o) => has(o, k));

let code;
try { code = readFileSync(new URL("./.qa-invite.txt", import.meta.url), "utf8").trim(); }
catch { console.error("❌ لا يوجد scripts/.qa-invite.txt"); process.exit(1); }
console.log(`قُرئ كود الدعوة (طوله ${code.length} — لا يُطبع)\n`);

console.log("=== 1) استبدال الكود بتذكرة (/api/invite/claim) ===");
const cl = await fetch(`${APP}/api/invite/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
const clj = await cl.json();
check("كود صالح → 201 مع تذكرة", cl.status === 201 && typeof clj.ticket === "string" && clj.ticket.length >= 40, `HTTP ${cl.status}`);
check("الاستجابة لا تُعيد الكود", !JSON.stringify(clj).includes(code));
const ticket = clj.ticket;
const bad = await fetch(`${APP}/api/invite/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }) });
check("كود خاطئ → لا تذكرة", bad.status === 400 && !(await bad.json()).ticket);

console.log("\n=== 2) التسجيل بالتذكرة (الكود لا يصل GoTrue إطلاقًا) ===");
const email = `ysd.qa.scrub.${Date.now()}@qa-ysd.com`;
const password = `Ysd!Qa${Math.random().toString(36).slice(2, 12)}Z9`;
const c = anon();
const su = await c.auth.signUp({ email, password, options: { data: { display_name: "QA Scrub", terms_accepted: "true", invite_ticket: ticket } } });
if (su.error) { console.error(`❌ فشل التسجيل بالتذكرة: ${su.error.message}`); process.exit(1); }
check("البوابة لم تنكسر — التسجيل بالتذكرة نجح", Boolean(su.data.user));
if (!su.data.session) { console.error("❌ لا جلسة — اضبط Confirm email = OFF مؤقتًا لهذا الفحص"); process.exit(2); }
const suTok = su.data.session.access_token;
check("signUp: لا invite_code في user_metadata", !has(su.data.user.user_metadata, "invite_code"), keys(su.data.user.user_metadata));
check("signUp: لا invite_code في identity_data", identityDatas(su.data.user).every((d) => !has(d, "invite_code")));
check("signUp: لا invite_code في JWT", !has(jwtMeta(suTok), "invite_code"), keys(jwtMeta(suTok)));
check("★ لا كود دعوة في أي موضع من استجابة التسجيل", !anywhere(su.data.user, suTok, "invite_code"));

console.log("\n=== 3) التذكرة إن ظهرت فهي مستهلَكة ومنتهية (بلا قيمة) ===");
const ticketVisible = anywhere(su.data.user, suTok, "invite_ticket");
console.log(`  ℹ التذكرة ${ticketVisible ? "ظاهرة" : "غير ظاهرة"} في استجابة/JWT التسجيل (متوقع: ظاهرة — GoTrue يبنيهما من الذاكرة)`);
const reuse = await anon().auth.signUp({ email: `ysd.qa.reuse.${Date.now()}@qa-ysd.com`, password, options: { data: { display_name: "إعادة", terms_accepted: "true", invite_ticket: ticket } } });
check("★ إعادة استخدام التذكرة مرفوضة (أحادية الاستخدام)", Boolean(reuse.error), reuse.error?.message?.slice(0, 50) ?? "نجح (خطأ!)");

console.log("\n=== 4) القاعدة: تسجيل دخول جديد + getUser + refreshSession ===");
const li = await anon().auth.signInWithPassword({ email, password });
check("تسجيل الدخول نجح", !li.error, li.error?.message);
check("auth.users: لا مفاتيح تسجيل", !has(li.data.user?.user_metadata, "invite_code") && !has(li.data.user?.user_metadata, "invite_ticket"), keys(li.data.user?.user_metadata));
check("auth.identities: لا مفاتيح تسجيل", identityDatas(li.data.user).every((d) => !has(d, "invite_code") && !has(d, "invite_ticket")), identityDatas(li.data.user).map(keys).join(" | "));
check("JWT بعد تسجيل الدخول: نظيف", !has(jwtMeta(li.data.session.access_token), "invite_code") && !has(jwtMeta(li.data.session.access_token), "invite_ticket"));
const c2 = anon();
await c2.auth.setSession(li.data.session);
const gu = await c2.auth.getUser();
check("getUser(): نظيف", !anywhere(gu.data.user, null, "invite_code") && !anywhere(gu.data.user, null, "invite_ticket"));
const rs = await c2.auth.refreshSession();
check("refreshSession + JWT الجديد: نظيف", !anywhere(rs.data.user, rs.data.session.access_token, "invite_code") && !anywhere(rs.data.user, rs.data.session.access_token, "invite_ticket"));

console.log("\n=== 5) البوابة سليمة: الاستهلاك مرة واحدة + الموافقة + لا تراجع ===");
check("الموافقة محفوظة للوثيقتين", ((await c2.from("user_consents").select("document").eq("user_id", su.data.user.id)).data?.length ?? 0) === 2);
check("terms_accepted و display_name باقيان", has(rs.data.user?.user_metadata, "terms_accepted") && has(rs.data.user?.user_metadata, "display_name"));
check("مطالبات الهوية باقية (sub/email)", identityDatas(rs.data.user).every((d) => has(d, "sub") || has(d, "email")));
check("الدعوة مربوطة بالمستخدم مرة واحدة بالضبط", ((await c2.from("beta_invite_uses").select("invite_id").eq("user_id", su.data.user.id)).data?.length ?? 0) === 1);
check("جدول التذاكر غير مقروء لأي دور (RLS بلا سياسات)", ((await c2.from("invite_tickets").select("ticket_hash").limit(1)).data?.length ?? 0) === 0);
check("التذكرة الخام غير مخزّنة (hash فقط)", sha256(ticket).length === 64);

console.log("\n=== 6) بلا تذكرة / تذكرة مزوّرة ===");
check("signUp بلا تذكرة يفشل", Boolean((await anon().auth.signUp({ email: `ysd.qa.not.${Date.now()}@qa-ysd.com`, password, options: { data: { display_name: "بلا", terms_accepted: "true" } } })).error));
check("signUp بتذكرة مزوّرة يفشل", Boolean((await anon().auth.signUp({ email: `ysd.qa.fake.${Date.now()}@qa-ysd.com`, password, options: { data: { display_name: "مزوّرة", terms_accepted: "true", invite_ticket: "x".repeat(43) } } })).error));
check("signUp بالكود الخام (عميل قديم) يفشل — الكود لم يعد مقبولًا", Boolean((await anon().auth.signUp({ email: `ysd.qa.old.${Date.now()}@qa-ysd.com`, password, options: { data: { display_name: "قديم", terms_accepted: "true", invite_code: code } } })).error));

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
console.log(`حسابات QA المُنشأة تبدأ بـ ysd.qa. — احذفها لاحقًا`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
