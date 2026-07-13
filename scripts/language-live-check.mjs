/**
 * اختبار حي لجودة اللغة عبر المسار الكامل (/api/chat على الخادم المحلي).
 * يرسل الرسائل الأربع المعتمدة ويقيس نقاء لغة كل رد + النموذج الفعلي.
 * لا يطبع أي مفاتيح. التشغيل: node scripts/language-live-check.mjs
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

function cookieHeader(session) {
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
  for (let i = 0; i * MAX < value.length; i++)
    parts.push(`${name}.${i}=${value.slice(i * MAX, (i + 1) * MAX)}`);
  return parts.join("; ");
}

function ratios(text) {
  const stripped = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  let arabic = 0, latin = 0, cyrillic = 0, cjk = 0, total = 0;
  for (const ch of stripped) {
    if (!/\p{L}/u.test(ch)) continue;
    const c = ch.codePointAt(0);
    total++;
    if ((c >= 0x0600 && c <= 0x08ff)) arabic++;
    else if (c <= 0x024f) latin++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
  }
  return { total, arabic, latin, cyrillic, cjk };
}

const supa = createClient(URL_, ANON, { auth: { persistSession: false } });
const ts = Date.now();
const su = await supa.auth.signUp({
  email: `ysd.qa.lang.${ts}@qa-ysd.com`,
  password: `Qa!${ts}xYz`,
  options: { data: { display_name: "فاحص اللغة" } },
});
if (su.error) {
  console.error("signup failed:", su.error.message);
  process.exit(1);
}
const cookie = cookieHeader(su.data.session);
const headers = { "Content-Type": "application/json", Cookie: cookie };

const convRes = await fetch(`${APP}/api/conversations`, { method: "POST", headers, body: "{}" });
const { conversation } = await convRes.json();

const TESTS = [
  { q: "السلام عليكم، عرفني بنفسك.", expect: "ar" },
  { q: "اكتب خطة بسيطة لتطوير مشروع YSD AI.", expect: "ar" },
  { q: "اشرح الفرق بين API وقاعدة البيانات بالعربية.", expect: "ar" },
  { q: "Write a short introduction in English.", expect: "en" },
];

let pass = 0, fail = 0;
for (const t of TESTS) {
  const res = await fetch(`${APP}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ conversationId: conversation.id, modelId: "ysd/free", message: t.q }),
  });
  const sse = await res.text();
  const events = [...sse.matchAll(/data: (.+)/g)].map((m) => JSON.parse(m[1]));
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  const model = events.find((e) => e.type === "meta")?.model ?? "?";
  const err = events.find((e) => e.type === "error")?.error;

  const r = ratios(text);
  const pct = (n) => (r.total ? Math.round((n / r.total) * 100) : 0);
  let ok;
  if (err && !text) ok = false;
  else if (t.expect === "ar") ok = pct(r.arabic) >= 70 && pct(r.cyrillic) === 0 && pct(r.cjk) === 0;
  else ok = pct(r.latin) >= 85 && pct(r.cyrillic) === 0 && pct(r.cjk) === 0;

  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} [${t.expect}] ${t.q.slice(0, 40)}`);
  console.log(`   model: ${model}`);
  console.log(`   arabic=${pct(r.arabic)}% latin=${pct(r.latin)}% cyrillic=${pct(r.cyrillic)}% cjk=${pct(r.cjk)}% letters=${r.total}${err ? ` | error: ${err}` : ""}`);
  console.log(`   ${text.slice(0, 110).replace(/\n/g, " ")}`);
}

// التحقق أن الرسائل حُفظت
await supa.auth.setSession(su.data.session);
const saved = await supa
  .from("messages")
  .select("role")
  .eq("conversation_id", conversation.id)
  .is("deleted_at", null);
console.log(`\nsaved messages: ${saved.data?.length ?? 0} (متوقع ${TESTS.length * 2})`);

console.log(`\nالنتيجة: ${pass}/${TESTS.length}`);
if (fail) process.exit(1);
