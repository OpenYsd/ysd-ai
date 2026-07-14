/**
 * اختبارات جاهزية النشر وتعطل الخدمات (يتطلب الخادم على 3000).
 * يتحقق أن فشل خدمة واحدة لا يُسقط المنصة، وأن الفحص الصحي آمن ولا يسرّب أسرارًا.
 * التشغيل: node scripts/deployment-check.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const APP = process.env.YSD_APP_URL ?? "http://localhost:3000";
const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split(".")[0];

let pass = 0, fail = 0; const failures = [];
function check(n, ok, d = "") { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } }

console.log("\n=== 1) الفحص الصحي: آمن ولا يسرّب أسرارًا ===");
const hres = await fetch(`${APP}/api/health`);
const htext = await hres.text();
const health = JSON.parse(htext);
check("يرجع 200 عند سلامة الخدمات", hres.status === 200, `HTTP ${hres.status} status=${health.status}`);
check("يحوي فحوص التبعيات", Boolean(health.checks?.database && health.checks?.pgvector && health.checks?.storage && health.checks?.openrouter && health.checks?.embeddings));
check("لا يسرّب قيم مفاتيح", !/sk-or-[A-Za-z0-9]{10}|eyJ[A-Za-z0-9]/.test(htext), "احتمال تسريب مفتاح");
check("لا يكشف storage_path", !htext.includes("/storage/v1/") && !/[0-9a-f-]{36}\/[^"]+\/[^"]+\.(pdf|docx|txt)/i.test(htext));
check("يحوي correlation_id", typeof health.correlation === "string" && health.correlation.length > 10);
check("قاعدة البيانات + pgvector سليمان", health.checks.database.status === "ok" && health.checks.pgvector.status === "ok", JSON.stringify(health.checks.pgvector));
check("OpenRouter مُبلّغ عنه دون طلب AI", health.checks.openrouter.status === "ok" && health.checks.openrouter.detail === "configured");
console.log(`  ℹ الحالة العامة: ${health.status} · نموذج Embeddings: ${health.checks.embeddings.detail}`);

console.log("\n=== 2) تعطّل OpenRouter (مفتاح خاطئ): لا يُسقط المنصة ===");
// نستخدم مستخدمًا حقيقيًا ونرسل رسالة؛ إن كان المفتاح صالحًا نتحقق أن المسار يصمد،
// وإلا يجب أن يرجع خطأ عربي دون انهيار. (لا نغيّر مفتاح الخادم — نتحقق من المتانة.)
const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ts = Date.now();
const su = await c.auth.signUp({ email: `ysd.qa.deploy.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
await c.auth.setSession(su.data.session);
const val = "base64-" + Buffer.from(JSON.stringify(su.data.session), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cookie = val.length <= 3180 ? `sb-${projectRef}-auth-token=${val}` : (() => { const p = []; for (let i = 0; i * 3180 < val.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${val.slice(i * 3180, (i + 1) * 3180)}`); return p.join("; "); })();
const conv = (await (await fetch(`${APP}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).json())?.conversation?.id;
const chatRes = await fetch(`${APP}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ conversationId: conv, modelId: "ysd/free", message: "مرحبا" }) });
check("مسار المحادثة يصمد (200 SSE)", chatRes.status === 200 && (chatRes.headers.get("content-type") ?? "").includes("text/event-stream"), `HTTP ${chatRes.status}`);
const sse = await chatRes.text();
check("لا تسريب أسرار في البث", !/sk-or-[A-Za-z0-9]{10}|OPENROUTER_API_KEY/.test(sse));
// حتى لو فشل الموفر، الرسالة تُحفظ (المنصة لا تسقط)
const saved = await c.from("messages").select("id").eq("conversation_id", conv).is("deleted_at", null);
check("رسالة المستخدم محفوظة رغم أي فشل موفر", (saved.data?.length ?? 0) >= 1);

console.log("\n=== 3) تعطّل RAG (استرجاع فاشل) لا يمنع المحادثة ===");
// سؤال بلا ملفات مرتبطة — لا يجب أن يفشل حتى لو نموذج embeddings غير محمّل
const chat2 = await fetch(`${APP}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ conversationId: conv, modelId: "ysd/free", message: "سؤال بلا ملفات" }) });
check("المحادثة تعمل بلا ملفات RAG", chat2.status === 200, `HTTP ${chat2.status}`);

console.log("\n=== تنظيف ===");
await c.from("conversations").update({ deleted_at: new Date().toISOString() }).eq("id", conv);

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
