/**
 * Regression نهائي لسلوكيات المحادثة عبر المسار الكامل (الخادم المحلي):
 * لغة عربية/إنجليزية، بث، إيقاف، تعديل، إعادة توليد، بقاء بعد التحديث،
 * تسجيل النموذج الفعلي، الحد اليومي، وعدم تكرار usage_events.
 * لا يطبع أي مفاتيح. التشغيل: node scripts/regression-chat.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = process.env.YSD_APP_URL ?? "http://localhost:3000";
const projectRef = new URL(URL_).host.split(".")[0];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function cookieHeader(session) {
  const name = `sb-${projectRef}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * MAX < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * MAX, (i + 1) * MAX)}`);
  return parts.join("; ");
}

function ratios(text) {
  const stripped = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  let arabic = 0, latin = 0, cyrillic = 0, cjk = 0, total = 0;
  for (const ch of stripped) {
    if (!/\p{L}/u.test(ch)) continue;
    const c = ch.codePointAt(0);
    total++;
    if (c >= 0x0600 && c <= 0x08ff) arabic++;
    else if (c <= 0x024f) latin++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  return { total, arabic, latin, cyrillic, cjk };
}

/** إرسال رسالة وقراءة البث كاملًا */
async function chatCall(headers, body) {
  const res = await fetch(`${APP}/api/chat`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const sse = await res.text();
  const events = [...sse.matchAll(/data: (.+)/g)].map((m) => JSON.parse(m[1]));
  return {
    status: res.status,
    events,
    text: events.filter((e) => e.type === "text").map((e) => e.text).join(""),
    textChunks: events.filter((e) => e.type === "text").length,
    model: events.find((e) => e.type === "meta")?.model ?? null,
    error: events.find((e) => e.type === "error")?.error ?? null,
    done: events.find((e) => e.type === "done") ?? null,
  };
}

const supa = createClient(URL_, ANON, { auth: { persistSession: false } });
const ts = Date.now();
const su = await supa.auth.signUp({
  email: `ysd.qa.reg.${ts}@qa-ysd.com`,
  password: `Qa!${ts}xYz`,
  options: { data: { display_name: "فاحص الانحدار" } },
});
if (su.error) { console.error("signup failed"); process.exit(1); }
await supa.auth.setSession(su.data.session);
const userId = su.data.user.id;
const headers = { "Content-Type": "application/json", Cookie: cookieHeader(su.data.session) };

const convRes = await fetch(`${APP}/api/conversations`, { method: "POST", headers, body: "{}" });
const { conversation } = await convRes.json();
const convId = conversation.id;

const usageCount = async () =>
  (await supa.from("usage_events").select("id").eq("user_id", userId)).data?.length ?? 0;
const msgs = async () =>
  (await supa.from("messages").select("id, role, content, model_id")
    .eq("conversation_id", convId).is("deleted_at", null).order("created_at")).data ?? [];

console.log("\n=== 1) رسالة عربية: بث + لغة + نموذج فعلي + usage واحد ===");
const u0 = await usageCount();
const r1 = await chatCall(headers, { conversationId: convId, modelId: "ysd/free", message: "اشرح باختصار ما هي قاعدة البيانات؟" });
const rat1 = ratios(r1.text);
check("HTTP 200 وبث SSE", r1.status === 200 && r1.done !== null, `HTTP ${r1.status}`);
check("بث حقيقي (أكثر من 3 قطع نصية)", r1.textChunks > 3, `chunks=${r1.textChunks}`);
check("الرد عربي نظيف (0% سيريلي/CJK)", rat1.total > 50 && rat1.cyrillic === 0 && rat1.cjk === 0 && rat1.arabic / rat1.total >= 0.7, `ar=${Math.round((rat1.arabic / (rat1.total || 1)) * 100)}%`);
check("النموذج الفعلي وصل عبر meta", Boolean(r1.model), String(r1.model));
const m1 = await msgs();
check("النموذج الفعلي سُجّل في الرسالة", m1.some((m) => m.role === "assistant" && m.model_id === r1.model));
const u1 = await usageCount();
check("usage_event واحد بالضبط للرد الناجح", u1 - u0 === 1, `+${u1 - u0}`);
const ue = await supa.from("usage_events").select("model_id").eq("user_id", userId).order("created_at", { ascending: false }).limit(1);
check("النموذج الفعلي سُجّل في usage_events", ue.data?.[0]?.model_id === r1.model, String(ue.data?.[0]?.model_id));

console.log("\n=== 2) رسالة إنجليزية في نفس المحادثة ===");
const r2 = await chatCall(headers, { conversationId: convId, modelId: "ysd/free", message: "Write one short sentence about databases in English." });
const rat2 = ratios(r2.text);
check("الرد إنجليزي فقط", rat2.total > 10 && rat2.latin / rat2.total >= 0.85 && rat2.arabic === 0 && rat2.cyrillic === 0 && rat2.cjk === 0, `latin=${Math.round((rat2.latin / (rat2.total || 1)) * 100)}%`);

console.log("\n=== 3) تعديل رسالة المستخدم ===");
const firstUserMsg = m1.find((m) => m.role === "user");
const uBeforeEdit = await usageCount();
const r3 = await chatCall(headers, {
  conversationId: convId, modelId: "ysd/free",
  message: "اشرح باختصار ما هو الـ API؟", editMessageId: firstUserMsg.id,
});
const m3 = await msgs();
const editedMsg = m3.find((m) => m.id === firstUserMsg.id);
check("التعديل بثّ ردًا جديدًا", r3.status === 200 && r3.text.length > 0, r3.error ?? "");
check("نص الرسالة تحدّث في قاعدة البيانات", editedMsg?.content === "اشرح باختصار ما هو الـ API؟");
check("ما بعد الرسالة المعدلة حُذف ناعمًا", !m3.some((m) => m.content.includes("databases in English")));
check("usage_event واحد للتعديل", (await usageCount()) - uBeforeEdit === 1);

console.log("\n=== 4) إعادة التوليد ===");
const beforeRegen = await msgs();
const lastAssistant = [...beforeRegen].reverse().find((m) => m.role === "assistant");
const uBeforeRegen = await usageCount();
const r4 = await chatCall(headers, { conversationId: convId, modelId: "ysd/free", regenerate: true });
const afterRegen = await msgs();
const newLastAssistant = [...afterRegen].reverse().find((m) => m.role === "assistant");
check("إعادة التوليد أنتجت ردًا", r4.status === 200 && r4.text.length > 0, r4.error ?? "");
check("الرد القديم استُبدل (حذف ناعم)", newLastAssistant && newLastAssistant.id !== lastAssistant.id);
check("usage_event واحد لإعادة التوليد", (await usageCount()) - uBeforeRegen === 1);

console.log("\n=== 5) الإيقاف (Abort) وحفظ الجزئي ===");
const ac = new AbortController();
let aborted = false;
try {
  const res = await fetch(`${APP}/api/chat`, {
    method: "POST", headers, signal: ac.signal,
    body: JSON.stringify({ conversationId: convId, modelId: "ysd/free", message: "اكتب مقالًا طويلًا جدًا عن تاريخ الحوسبة عبر العقود." }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let seen = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
    if (seen.includes('"type":"text"')) { ac.abort(); aborted = true; break; }
  }
} catch { aborted = aborted || ac.signal.aborted; }
check("الإيقاف من العميل نجح", aborted);
await new Promise((r) => setTimeout(r, 3000));
const afterStop = await msgs();
const stopAssistant = [...afterStop].reverse().find((m) => m.role === "assistant");
check("الرد الجزئي حُفظ بعد الإيقاف", Boolean(stopAssistant && stopAssistant.content.length > 0 && afterStop[afterStop.length - 1].role === "assistant"));

console.log("\n=== 6) البقاء بعد التحديث (إعادة الجلب من قاعدة البيانات) ===");
// بعد التعديل حُذف ما بعد الرسالة الأولى، ثم أُضيف زوج الإيقاف → 4 رسائل متناوبة
const fresh = await msgs();
const roles = fresh.map((m) => m.role).join(",");
check(
  "كل الرسائل مسترجعة بالترتيب الصحيح",
  fresh.length === 4 && roles === "user,assistant,user,assistant",
  roles,
);
const convRow = await supa.from("conversations").select("title").eq("id", convId).single();
check("العنوان التلقائي محفوظ", Boolean(convRow.data?.title && convRow.data.title !== "محادثة جديدة"), String(convRow.data?.title));

console.log("\n=== 7) الحد اليومي (free = 50/يوم) ===");
const before = await supa.rpc("check_usage_allowed", { p_user_id: userId });
check("قبل الامتلاء: مسموح", before.data === true);
// نملأ الحد اليومي بأحداث اصطناعية (سياسة الإدراج الذاتي تسمح بذلك)
const rows = Array.from({ length: 50 }, () => ({
  user_id: userId, model_id: "qa-fill", input_tokens: 1, output_tokens: 1,
}));
const fill = await supa.from("usage_events").insert(rows);
check("تعبئة 50 حدثًا اصطناعيًا", !fill.error, fill.error?.message);
const after = await supa.rpc("check_usage_allowed", { p_user_id: userId });
check("بعد الامتلاء: الدالة ترفض", after.data === false, String(after.data));
const blocked = await chatCall(headers, { conversationId: convId, modelId: "ysd/free", message: "هل ما زلت متاحًا؟" });
check("API يرفض بـ 403 برسالة عربية", blocked.status === 403, `HTTP ${blocked.status}`);

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
