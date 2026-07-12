/**
 * اختبارات Runtime شاملة ضد Supabase الحقيقي والخادم المحلي.
 * التشغيل: node scripts/runtime-check.mjs
 * لا يطبع أي مفاتيح أو أسرار — النتائج فقط.
 *
 * يغطي: التسجيل، إنشاء profile تلقائيًا (trigger)، الدخول/الخروج،
 * استمرار الجلسة، CRUD المحادثات والرسائل، عزل RLS بين مستخدمين،
 * ومسارات API بما فيها رسالة خطأ الرصيد العربية من /api/chat.
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

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function newClient() {
  return createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** بناء Cookie جلسة بصيغة @supabase/ssr (base64 + تقسيم) لاختبار مسارات API */
function sessionCookieHeader(session) {
  const name = `sb-${projectRef}-auth-token`;
  const value =
    "base64-" +
    Buffer.from(JSON.stringify(session), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * MAX < value.length; i++) {
    parts.push(`${name}.${i}=${value.slice(i * MAX, (i + 1) * MAX)}`);
  }
  return parts.join("; ");
}

const ts = Date.now();
const emailA = `ysd.qa.a.${ts}@qa-ysd.com`;
const emailB = `ysd.qa.b.${ts}@qa-ysd.com`;
const PASSWORD = `Qa!${ts}xYz`;

console.log("\n=== 1) التسجيل وإنشاء profile تلقائيًا ===");
const a = newClient();
const signupA = await a.auth.signUp({
  email: emailA,
  password: PASSWORD,
  options: { data: { display_name: "مستخدم أ" } },
});
check("تسجيل مستخدم أ", !signupA.error, signupA.error?.message);
check("جلسة فورية بعد التسجيل (autoconfirm)", Boolean(signupA.data.session));
const userA = signupA.data.user;
await a.auth.setSession(signupA.data.session);

const profA = await a.from("profiles").select("id, display_name, role, locale").eq("id", userA.id).single();
check("الـ trigger أنشأ profile تلقائيًا", !profA.error && profA.data?.id === userA.id, profA.error?.message);
check("display_name من بيانات التسجيل", profA.data?.display_name === "مستخدم أ", String(profA.data?.display_name));
check("role الافتراضي = user (يثبت enum user_role)", profA.data?.role === "user", String(profA.data?.role));
const subA = await a.from("subscriptions").select("tier").eq("user_id", userA.id).single();
check("اشتراك free أُنشئ تلقائيًا", subA.data?.tier === "free", subA.error?.message);

console.log("\n=== 2) الخروج والدخول واستمرار الجلسة ===");
await a.auth.signOut();
const afterOut = await a.auth.getUser();
check("بعد الخروج لا توجد جلسة", !afterOut.data.user);
const login = await a.auth.signInWithPassword({ email: emailA, password: PASSWORD });
check("تسجيل الدخول بكلمة المرور", !login.error && Boolean(login.data.session), login.error?.message);
const refreshed = await a.auth.refreshSession({ refresh_token: login.data.session.refresh_token });
check("تجديد الجلسة بـ refresh_token", !refreshed.error && Boolean(refreshed.data.session), refreshed.error?.message);
const whoami = await a.auth.getUser();
check("الجلسة مستمرة (getUser)", whoami.data.user?.id === userA.id);
const sessionA = refreshed.data.session;

console.log("\n=== 3) المحادثات والرسائل (عبر RLS مباشرة) ===");
const convIns = await a.from("conversations").insert({ user_id: userA.id, title: "محادثة اختبار" }).select("id").single();
check("إنشاء محادثة", !convIns.error, convIns.error?.message);
const convId = convIns.data?.id;
const ren = await a.from("conversations").update({ title: "عنوان معدّل" }).eq("id", convId).select("title").single();
check("إعادة تسمية المحادثة", ren.data?.title === "عنوان معدّل", ren.error?.message);
const msg1 = await a.from("messages").insert({ conversation_id: convId, role: "user", content: "سؤال تجريبي" }).select("id").single();
const msg2 = await a.from("messages").insert({ conversation_id: convId, role: "assistant", content: "رد تجريبي" }).select("id").single();
check("حفظ رسالتين", !msg1.error && !msg2.error, msg1.error?.message ?? msg2.error?.message);
const back = await a.from("messages").select("role, content").eq("conversation_id", convId).is("deleted_at", null).order("created_at");
check("استرجاع الرسائل بالترتيب", back.data?.length === 2 && back.data[0].content === "سؤال تجريبي", back.error?.message);
const edit = await a.from("messages").update({ content: "سؤال معدّل" }).eq("id", msg1.data.id).select("content").single();
check("تعديل رسالة (سياسة 0002)", edit.data?.content === "سؤال معدّل", edit.error?.message);
const usageIns = await a.from("usage_events").insert({ user_id: userA.id, conversation_id: convId, model_id: "claude-sonnet-4-6", input_tokens: 10, output_tokens: 20 });
check("تسجيل استهلاك للنفس (سياسة 0002)", !usageIns.error, usageIns.error?.message);
const rpc = await a.rpc("check_usage_allowed", { p_user_id: userA.id });
check("check_usage_allowed ترجع true", rpc.data === true, rpc.error?.message);

console.log("\n=== 4) عزل RLS بين مستخدمين ===");
const b = newClient();
const signupB = await b.auth.signUp({ email: emailB, password: PASSWORD, options: { data: { display_name: "مستخدم ب" } } });
check("تسجيل مستخدم ب", !signupB.error, signupB.error?.message);
await b.auth.setSession(signupB.data.session);

const spy1 = await b.from("conversations").select("id").eq("id", convId);
check("ب لا يرى محادثة أ (select)", spy1.data?.length === 0);
const spy2 = await b.from("messages").select("id").eq("conversation_id", convId);
check("ب لا يرى رسائل أ", spy2.data?.length === 0);
const spy3 = await b.from("conversations").update({ title: "اختراق" }).eq("id", convId).select("id");
check("ب لا يستطيع تعديل محادثة أ", spy3.data?.length === 0);
const spy4 = await b.from("messages").insert({ conversation_id: convId, role: "user", content: "حقن" });
check("ب لا يستطيع الإدراج في محادثة أ", Boolean(spy4.error));
const spy5 = await b.from("profiles").select("id").eq("id", userA.id);
check("ب لا يرى profile أ", spy5.data?.length === 0);
const spy6 = await b.from("usage_events").select("id").eq("user_id", userA.id);
check("ب لا يرى استهلاك أ", spy6.data?.length === 0);
const spy7 = await b.from("usage_events").insert({ user_id: userA.id, model_id: "x", input_tokens: 1, output_tokens: 1 });
check("ب لا يستطيع تسجيل استهلاك باسم أ", Boolean(spy7.error));
const spy8 = await b.from("admin_audit_logs").select("id").limit(1);
check("مستخدم عادي لا يقرأ سجل الإدارة", (spy8.data?.length ?? 0) === 0);

console.log("\n=== 5) مسارات API عبر الخادم المحلي ===");
const cookieA = sessionCookieHeader(sessionA);
const jsonHeaders = (cookie) => ({ "Content-Type": "application/json", Cookie: cookie });

const noAuth = await fetch(`${APP}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("بدون جلسة → 401", noAuth.status === 401, `HTTP ${noAuth.status}`);

const apiCreate = await fetch(`${APP}/api/conversations`, { method: "POST", headers: jsonHeaders(cookieA), body: "{}" });
const apiCreateBody = await apiCreate.json().catch(() => null);
check("POST /api/conversations → 201", apiCreate.status === 201, `HTTP ${apiCreate.status}`);
const apiConvId = apiCreateBody?.conversation?.id;

const apiRename = await fetch(`${APP}/api/conversations/${apiConvId}`, { method: "PATCH", headers: jsonHeaders(cookieA), body: JSON.stringify({ title: "من API" }) });
check("PATCH إعادة تسمية → 200", apiRename.status === 200, `HTTP ${apiRename.status}`);

// خطأ Anthropic (رصيد صفر) عبر المسار الكامل — ويجب أن تُحفظ رسالة المستخدم رغم ذلك
const chat = await fetch(`${APP}/api/chat`, {
  method: "POST",
  headers: jsonHeaders(cookieA),
  body: JSON.stringify({ conversationId: apiConvId, modelId: "claude-sonnet-4-6", message: "مرحبًا" }),
});
check("POST /api/chat يرجع بث SSE", chat.status === 200 && (chat.headers.get("content-type") ?? "").includes("text/event-stream"), `HTTP ${chat.status}`);
const sseText = await chat.text();
const events = [...sseText.matchAll(/data: (.+)/g)].map((m) => JSON.parse(m[1]));
const errEvent = events.find((e) => e.type === "error");
check("حدث خطأ واضح بالعربية (رصيد غير كافٍ)", Boolean(errEvent && /[؀-ۿ]/.test(errEvent.error) && errEvent.error.includes("رصيد")), JSON.stringify(errEvent ?? events.map((e) => e.type)));
check("لا تسريب أسرار في رسالة الخطأ", !/sk-ant|api[_-]?key|bearer/i.test(sseText));
const savedMsg = await a.from("messages").select("content").eq("conversation_id", apiConvId).is("deleted_at", null);
check("رسالة المستخدم حُفظت رغم فشل الموفر", savedMsg.data?.some((m) => m.content === "مرحبًا"), savedMsg.error?.message);
const autoTitle = await a.from("conversations").select("title").eq("id", apiConvId).single();
check("تحديث المحادثة بعد الإرسال", !autoTitle.error, autoTitle.error?.message);

// IDOR عبر API: ب يحاول تعديل محادثة أ
const cookieB = sessionCookieHeader(signupB.data.session);
const idor = await fetch(`${APP}/api/conversations/${apiConvId}`, { method: "PATCH", headers: jsonHeaders(cookieB), body: JSON.stringify({ title: "اختراق" }) });
check("IDOR عبر API مرفوض (404)", idor.status === 404, `HTTP ${idor.status}`);

const apiDelete = await fetch(`${APP}/api/conversations/${apiConvId}`, { method: "DELETE", headers: jsonHeaders(cookieA) });
check("DELETE حذف ناعم → 200", apiDelete.status === 200, `HTTP ${apiDelete.status}`);
const gone = await a.from("conversations").select("id").eq("id", apiConvId).is("deleted_at", null);
check("المحادثة المحذوفة لا تظهر", gone.data?.length === 0);

console.log("\n=== 6) تنظيف ===");
const clean1 = await a.from("conversations").update({ deleted_at: new Date().toISOString() }).eq("id", convId);
check("حذف ناعم لمحادثة الاختبار", !clean1.error, clean1.error?.message);
console.log(`  ℹ مستخدما الاختبار (${emailA.split("@")[0]}…, ${emailB.split("@")[0]}…) يحتاجان service role للحذف الكامل — تُركا.`);

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) {
  console.log("الإخفاقات:", failures.join(" | "));
  process.exit(1);
}
