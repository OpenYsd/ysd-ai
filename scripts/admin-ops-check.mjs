/**
 * اختبارات عمليات الإدارة المكمّلة (owner جلسة من scripts/.qa-owner.json):
 * tier، تفعيل/تعطيل النماذج، تعديل الحدود (Zod + رفض السالب)، RAG jobs،
 * IDOR، mass assignment، وتفاصيل سجل التدقيق. لا يطبع أسرارًا.
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
const APP = "http://localhost:3000";
const projectRef = new URL(URL_).host.split(".")[0];
const creds = JSON.parse(readFileSync(new URL("./.qa-owner.json", import.meta.url), "utf8"));

let pass = 0, fail = 0; const failures = [];
function check(n, ok, d = "") { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } }
function cookieOf(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
const H = (cookie) => ({ Cookie: cookie, "Content-Type": "application/json" });

const oc = createClient(URL_, ANON, { auth: { persistSession: false } });
const login = await oc.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (login.error) { console.error("owner login failed"); process.exit(1); }
const oCookie = cookieOf(login.data.session);

// مستخدم هدف
const vc = createClient(URL_, ANON, { auth: { persistSession: false } });
const ts = Date.now();
const vs = await vc.auth.signUp({ email: `ysd.qa.ops.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
await vc.auth.setSession(vs.data.session);
const vId = vs.data.user.id;

console.log("=== 1) تعديل الباقة (tier) ===");
const setTier = await fetch(`${APP}/api/admin/users/${vId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "tier", tier: "pro" }) });
check("owner يغيّر tier → 200", setTier.status === 200, `HTTP ${setTier.status}`);
const tierNow = (await oc.from("subscriptions").select("tier").eq("user_id", vId).single()).data?.tier;
check("tier أصبح pro في قاعدة البيانات", tierNow === "pro", String(tierNow));

console.log("\n=== 2) تفعيل/تعطيل نموذج ===");
const disable = await fetch(`${APP}/api/admin/models`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ target: "model", id: "ysd/free", enabled: false }) });
check("تعطيل نموذج → 200", disable.status === 200, `HTTP ${disable.status}`);
const modOff = (await oc.from("ai_models").select("enabled").eq("id", "ysd/free").single()).data?.enabled;
check("النموذج مُعطّل في قاعدة البيانات", modOff === false, String(modOff));
await fetch(`${APP}/api/admin/models`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ target: "model", id: "ysd/free", enabled: true }) });
check("إعادة تفعيل النموذج", (await oc.from("ai_models").select("enabled").eq("id", "ysd/free").single()).data?.enabled === true);

console.log("\n=== 3) تعديل الحدود (Zod + رفض السالب) ===");
const goodLimit = { tier: "free", monthly_messages: 250, monthly_tokens: 600000, daily_messages: 60, max_file_mb: 10, max_files: 50, max_storage_mb: 200, max_chunks_per_file: 200, max_total_chunks: 2000 };
const okLim = await fetch(`${APP}/api/admin/usage-limits`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify(goodLimit) });
check("تعديل الحدود بقيم صحيحة → 200", okLim.status === 200, `HTTP ${okLim.status}`);
const negLim = await fetch(`${APP}/api/admin/usage-limits`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ ...goodLimit, monthly_messages: -5 }) });
check("رفض القيمة السالبة (400)", negLim.status === 400, `HTTP ${negLim.status}`);
// أعِد free للقيمة الأصلية 200/يوم؟ (كانت daily 50)
await fetch(`${APP}/api/admin/usage-limits`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ ...goodLimit, daily_messages: 50 }) });

console.log("\n=== 4) RAG jobs: إعادة/إلغاء + منع IDOR ===");
// أنشئ وظيفة فاشلة عبر رفع ملف ثم إتلاف نصه (خطأ دائم)
const form = new FormData();
form.append("file", new File([Buffer.from("نص تجريبي كافٍ للتقسيم والمعالجة بشكل طبيعي.", "utf8")], "ops.txt", { type: "text/plain" }));
form.append("conversationId", "");
const up = await fetch(`${APP}/api/files/upload`, { method: "POST", headers: { Cookie: cookieOf(vs.data.session) }, body: form });
const fileId = (await up.json())?.file?.id;
await vc.from("files").update({ extracted_text: "" }).eq("id", fileId); // يفشل التجهيز
// أدرج وظيفة failed مباشرة (بجلسة الهدف)
const jobIns = await vc.from("rag_jobs").insert({ user_id: vId, file_id: fileId, job_type: "rag_prepare", idempotency_key: `${fileId}:x:rag_prepare`, status: "failed", error_code: "no_text" }).select("id").single();
const jobId = jobIns.data?.id;
check("أُنشئت وظيفة فاشلة", Boolean(jobId), jobIns.error?.message);
const requeue = await fetch(`${APP}/api/admin/rag/${jobId}`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ op: "requeue" }) });
check("owner يعيد وظيفة فاشلة → 200", requeue.status === 200, `HTTP ${requeue.status}`);
const jobStatus = (await oc.from("rag_jobs").select("status").eq("id", jobId).single()).data?.status;
check("الوظيفة عادت queued", jobStatus === "queued", String(jobStatus));
const cancel = await fetch(`${APP}/api/admin/rag/${jobId}`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ op: "cancel" }) });
check("owner يلغي وظيفة → 200", cancel.status === 200, `HTTP ${cancel.status}`);
// IDOR: معرّف عشوائي غير موجود
const idorJob = await fetch(`${APP}/api/admin/rag/00000000-0000-4000-8000-000000000000`, { method: "POST", headers: H(oCookie), body: JSON.stringify({ op: "cancel" }) });
check("وظيفة غير موجودة → 404 (لا IDOR)", idorJob.status === 404, `HTTP ${idorJob.status}`);

console.log("\n=== 5) mass assignment مرفوض ===");
// إرسال حقول متعددة/غير متوقعة في PATCH المستخدم
const mass = await fetch(`${APP}/api/admin/users/${vId}`, { method: "PATCH", headers: H(oCookie), body: JSON.stringify({ op: "tier", tier: "free", role: "owner", status: "banned" }) });
const massBody = await mass.json().catch(() => null);
// discriminatedUnion يتجاهل الحقول الزائدة؛ يجب أن تُنفَّذ tier فقط
const roleAfterMass = (await oc.from("profiles").select("role, status").eq("id", vId).single()).data;
check("mass assignment لا يغيّر role/status", roleAfterMass?.role === "user" && roleAfterMass?.status !== "banned", JSON.stringify(roleAfterMass));

console.log("\n=== 6) تفاصيل سجل التدقيق ===");
const audit = await (await fetch(`${APP}/api/admin/audit`, { headers: H(oCookie) })).json();
const actions = new Set((audit.logs ?? []).map((l) => l.action));
check("يحوي user.tier و model.enabled و usage_limit.update و rag_job.requeue", ["user.tier", "model.enabled", "usage_limit.update", "rag_job.requeue"].every((a) => actions.has(a)), [...actions].join(","));
const withBeforeAfter = (audit.logs ?? []).find((l) => l.action === "usage_limit.update");
check("سجل الحدود يحوي before/after", Boolean(withBeforeAfter?.before && withBeforeAfter?.after));
check("سجل التدقيق يحوي correlation_id", (audit.logs ?? []).every((l) => l.correlation_id));
check("لا أسرار في السجل", !/sk-or|sk-ant|password|access_token|eyJ[A-Za-z0-9]{8}/i.test(JSON.stringify(audit.logs)));

console.log("\n=== تنظيف ===");
await vc.from("files").update({ deleted_at: new Date().toISOString() }).eq("id", fileId);

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
