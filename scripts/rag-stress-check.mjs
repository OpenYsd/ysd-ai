/**
 * اختبارات ضغط وفشل لطابور RAG (بعد تطبيق migration 0008).
 * يتطلب: الخادم على 3000 + 0008 مطبقة. لا يطبع أسرارًا ولا نصوص ملفات.
 * التشغيل: node scripts/rag-stress-check.mjs
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
function cookieHeader(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
async function newUser(label) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const ts = Date.now() + Math.floor(Math.random() * 1e4);
  const su = await c.auth.signUp({ email: `ysd.qa.stress.${label}.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
  if (su.error) throw new Error(su.error.message);
  await c.auth.setSession(su.data.session);
  return { client: c, cookie: cookieHeader(su.data.session), userId: su.data.user.id };
}
async function uploadTxt(cookie, name, content, extra = {}) {
  const form = new FormData();
  form.append("file", new File([Buffer.from(content, "utf8")], name, { type: "text/plain" }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(`${APP}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: form });
  return (await res.json())?.file;
}
const ragPost = (cookie, id) => fetch(`${APP}/api/files/${id}/rag`, { method: "POST", headers: { Cookie: cookie } });
const chunkCount = async (client, fileId) => (await client.from("file_chunks").select("id", { count: "exact", head: true }).eq("file_id", fileId)).count ?? 0;

const A = await newUser("a");
const B = await newUser("b");
const DOC = (tag) => `وثيقة اختبار الضغط ${tag}.\n\nالقسم الأول: يحتوي معلومة فريدة رقمها ${tag}.\n\nالقسم الثاني: نص إضافي كافٍ لإنتاج مقاطع متعددة عند التقسيم مع تكرار الفكرة بصياغات مختلفة لضمان تجاوز حجم المقطع الواحد وإنتاج أكثر من مقطع فعلي.\n\nالقسم الثالث: خاتمة عربية موسّعة تشرح الفكرة بتفصيل إضافي.`;

console.log("\n=== 1) طلبان متزامنان لنفس الملف: وظيفة واحدة فقط ===");
const f1 = await uploadTxt(A.cookie, "متزامن.txt", DOC("A1"));
const [r1, r2] = await Promise.all([ragPost(A.cookie, f1.id), ragPost(A.cookie, f1.id)]);
check("كلا الطلبين رجعا بلا خطأ خادم", r1.status < 500 && r2.status < 500, `HTTP ${r1.status}/${r2.status}`);
const jobsForFile = await A.client.from("rag_jobs").select("id, status").eq("file_id", f1.id);
check("وظيفة واحدة فقط أُنشئت للملف", (jobsForFile.data?.length ?? 0) === 1, `jobs=${jobsForFile.data?.length}`);
const c1 = await chunkCount(A.client, f1.id);
const st1 = (await A.client.from("files").select("status,rag_total_chunks").eq("id", f1.id).single()).data;
check("الملف جاهز والمقاطع غير مكررة", st1?.status === "ready_for_rag" && c1 === st1?.rag_total_chunks, `status=${st1?.status} chunks=${c1}`);

console.log("\n=== 2) خمسة ملفات متزامنة ===");
const five = await Promise.all([1, 2, 3, 4, 5].map((i) => uploadTxt(A.cookie, `ملف-${i}.txt`, DOC(`M${i}`))));
const t0 = Date.now();
const results = await Promise.all(five.map((f) => ragPost(A.cookie, f.id)));
const okCount = results.filter((r) => r.status === 200).length;
check("الخمسة اكتملت (200)", okCount === 5, `ok=${okCount}/5 in ${Date.now() - t0}ms`);
let noDup = true;
for (const f of five) {
  const cc = await chunkCount(A.client, f.id);
  const total = (await A.client.from("files").select("rag_total_chunks").eq("id", f.id).single()).data?.rag_total_chunks;
  if (cc !== total) noDup = false;
}
check("لا تكرار مقاطع في أي ملف", noDup);
console.log(`  ℹ راقب [rag-worker] rss_start/rss_end في سجل الخادم لأعلى RAM.`);

console.log("\n=== 3) استكمال بعد \"توقف العامل\" أثناء embedding ===");
// حاكِ توقف العامل: صفّر embedding لبعض المقاطع + أعد الحالة + أنشئ وظيفة queued
const f3 = five[0];
const before3 = await chunkCount(A.client, f3.id);
const someChunks = (await A.client.from("file_chunks").select("id").eq("file_id", f3.id).limit(2)).data ?? [];
for (const ch of someChunks) await A.client.from("file_chunks").update({ embedding: null }).eq("id", ch.id);
await A.client.from("files").update({ status: "embedding" }).eq("id", f3.id);
// أعد التجهيز → يجب أن يستكمل (chunksCurrent=true عبر hash) دون إعادة chunking
const resume = await ragPost(A.cookie, f3.id);
const after3 = await chunkCount(A.client, f3.id);
const nullAfter = (await A.client.from("file_chunks").select("id", { count: "exact", head: true }).eq("file_id", f3.id).is("embedding", null)).count ?? 0;
check("الاستكمال أكمل embedding المتبقي", resume.status === 200 && nullAfter === 0, `HTTP ${resume.status} null=${nullAfter}`);
check("لا تكرار مقاطع بعد الاستكمال", after3 === before3, `${before3}→${after3}`);

console.log("\n=== 4) انتهاء Lease/Heartbeat: استرجاع الوظيفة ===");
const f4 = await uploadTxt(A.cookie, "lease.txt", DOC("L4"));
// أنشئ وظيفة running بنبضة قديمة يدويًا
const ins = await A.client.from("rag_jobs").insert({
  user_id: A.userId, file_id: f4.id, job_type: "rag_prepare",
  idempotency_key: `${f4.id}:manual:rag_prepare`, status: "running",
  locked_by: "dead-worker", heartbeat_at: new Date(Date.now() - 600000).toISOString(),
}).select("id").single();
check("أُنشئت وظيفة معلّقة", !ins.error, ins.error?.message);
const claim = await A.client.rpc("claim_rag_job", { p_worker_id: "new-worker", p_lease_seconds: 120 });
const claimed = (claim.data ?? [])[0];
check("عامل جديد استرجع الوظيفة المنتهية", Boolean(claimed && claimed.id === ins.data?.id && claimed.locked_by === "new-worker"), JSON.stringify(claim.error ?? claimed?.status));
// نظّف
await A.client.from("rag_jobs").delete().eq("id", ins.data?.id);

console.log("\n=== 5) خطأ دائم → failed دون حلقة ===");
const f5 = await uploadTxt(A.cookie, "دائم.txt", "نص كافٍ للاستخراج والتقسيم بشكل طبيعي تمامًا.");
// أفرغ النص المستخرج لفرض خطأ دائم (no_text)
await A.client.from("files").update({ extracted_text: "" }).eq("id", f5.id);
const permRes = await ragPost(A.cookie, f5.id);
check("الخطأ الدائم يُرفض بوضوح (400)", permRes.status === 400, `HTTP ${permRes.status}`);

console.log("\n=== 6) حذف ملف أثناء المعالجة ===");
const f6 = await uploadTxt(A.cookie, "حذف.txt", DOC("D6"));
await A.client.from("files").update({ status: "embedding" }).eq("id", f6.id);
await A.client.from("rag_jobs").insert({
  user_id: A.userId, file_id: f6.id, job_type: "rag_prepare",
  idempotency_key: `${f6.id}:x:rag_prepare`, status: "running", locked_by: "w",
  heartbeat_at: new Date().toISOString(),
});
const del6 = await fetch(`${APP}/api/files/${f6.id}`, { method: "DELETE", headers: { Cookie: A.cookie } });
check("الحذف نجح", del6.status === 200);
const jobsAfterDel = await A.client.from("rag_jobs").select("status").eq("file_id", f6.id);
check("الوظائف أُلغيت أو حُذفت", (jobsAfterDel.data ?? []).every((j) => j.status === "cancelled") || jobsAfterDel.data?.length === 0);
const chunksAfterDel = await chunkCount(A.client, f6.id);
check("المقاطع حُذفت", chunksAfterDel === 0);
const reprep6 = await ragPost(A.cookie, f6.id);
check("لا يمكن إعادة تجهيز ملف محذوف (404)", reprep6.status === 404, `HTTP ${reprep6.status}`);

console.log("\n=== 7) عزل المستخدم الثاني ===");
const bSees = await B.client.from("rag_jobs").select("id").eq("file_id", f1.id);
check("ب لا يرى وظائف أ", (bSees.data?.length ?? 0) === 0);
const bClaim = await B.client.rpc("claim_rag_job", { p_worker_id: "b", p_lease_seconds: 120 });
check("ب لا يلتقط وظائف أ", (bClaim.data ?? []).every((j) => j.user_id === B.userId));
const bCancel = await fetch(`${APP}/api/files/${f1.id}/rag/cancel`, { method: "POST", headers: { Cookie: B.cookie } });
check("ب لا يلغي تجهيز ملف أ (404)", bCancel.status === 404, `HTTP ${bCancel.status}`);

console.log("\n=== 8) عدم تراجع RAG (إجابة + مصدر) ===");
const qConv = (await (await fetch(`${APP}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: A.cookie }, body: "{}" })).json())?.conversation?.id;
await fetch(`${APP}/api/files/${f1.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: A.cookie }, body: JSON.stringify({ conversationId: qConv }) });
const chatRes = await fetch(`${APP}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: A.cookie }, body: JSON.stringify({ conversationId: qConv, modelId: "ysd/free", message: "ما المعلومة الفريدة في القسم الأول؟" }) });
const sse = await chatRes.text();
const events = [...sse.matchAll(/data: (.+)/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
check("الاسترجاع ما زال يرجع مصادر", (events.find((e) => e.type === "sources")?.sources?.length ?? 0) > 0);

console.log("\n=== تنظيف ===");
for (const f of [f1, ...five, f4, f5]) if (f?.id) await fetch(`${APP}/api/files/${f.id}`, { method: "DELETE", headers: { Cookie: A.cookie } });

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
