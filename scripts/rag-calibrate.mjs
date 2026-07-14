/**
 * معايرة عتبة التشابه على بيانات حقيقية:
 * يرفع مستندًا، يجهّزه، ثم يقيس أعلى تشابه لكل سؤال متعلق/غير متعلق
 * عبر RPC مباشرة (min_similarity=0) — لاختيار threshold مبني على القياس.
 * يحمّل نموذج Embeddings محليًا داخل السكربت (نفس النموذج والبادئات).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { pipeline, env as hfEnv } from "@huggingface/transformers";

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
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * MAX < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * MAX, (i + 1) * MAX)}`);
  return parts.join("; ");
}

hfEnv.cacheDir = `${process.cwd()}/.cache/transformers`;
const extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
async function embedQuery(text) {
  const out = await extractor([`query: ${text.slice(0, 2000)}`], { pooling: "mean", normalize: true });
  return out.tolist()[0];
}

const c = createClient(URL_, ANON, { auth: { persistSession: false } });
const ts = Date.now();
const su = await c.auth.signUp({ email: `ysd.qa.cal.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
await c.auth.setSession(su.data.session);
const cookie = cookieHeader(su.data.session);

const DOC = `دليل منصة YSD AI

التعريف: منصة YSD AI نظام ذكاء اصطناعي عربي للمحادثة وإدارة المشاريع ورفع الملفات ومعالجتها.

الأرقام: الحد الأقصى لحجم الملف في الباقة المجانية خمسون ميجابايت. رمز الدعم الفني الرسمي هو YSD-7788-SUPPORT.
عدد الباقات المتاحة أربع باقات: المجانية وPlus وPro وBusiness.

المعالجة: تُقسّم الملفات إلى مقاطع نصية، ثم تُولّد لها متجهات دلالية محلية، وتُخزّن للبحث الدلالي.

السياسات: تحتفظ المنصة ببيانات المستخدم وفق سياسة الخصوصية ولا تشارك الملفات مع أطراف خارجية. كل مستخدم يرى بياناته فقط.`;

const form = new FormData();
form.append("file", new File([Buffer.from(DOC, "utf8")], "دليل-المعايرة.txt", { type: "text/plain" }));
const up = await fetch(`${APP}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: form });
const fileId = (await up.json())?.file?.id;
const rag = await fetch(`${APP}/api/files/${fileId}/rag`, { method: "POST", headers: { Cookie: cookie } });
const ragBody = await rag.json();
console.log(`ملف مُجهّز: ${ragBody?.totalChunks} مقطع، حالة ${ragBody?.file?.status}\n`);

const RELATED = [
  "ما هو رمز الدعم الفني الرسمي؟",
  "كم الحد الأقصى لحجم الملف في الباقة المجانية؟",
  "كم عدد الباقات المتاحة في المنصة؟",
  "كيف تعالج المنصة الملفات المرفوعة؟",
  "هل تشارك المنصة ملفات المستخدمين مع جهات خارجية؟",
  "ما وظيفة منصة YSD AI؟",
];
const UNRELATED = [
  "ما هي عاصمة اليابان؟",
  "كيف أطبخ الأرز البسمتي؟",
  "من فاز بكأس العالم عام 2022؟",
  "ما هو قانون الجاذبية لنيوتن؟",
  "كم عدد أيام السنة الكبيسة؟",
  "ما أفضل وقت لزيارة باريس؟",
];

async function topSim(question) {
  const emb = await embedQuery(question);
  const { data } = await c.rpc("match_file_chunks", {
    p_query_embedding: JSON.stringify(emb),
    p_file_ids: [fileId],
    p_match_count: 5,
    p_min_similarity: 0,
  });
  const sims = (data ?? []).map((r) => r.similarity);
  return { top: sims[0] ?? 0, second: sims[1] ?? 0, all: sims };
}

console.log("=== أسئلة متعلقة ===");
const relTops = [];
for (const q of RELATED) {
  const r = await topSim(q);
  relTops.push(r.top);
  console.log(`  ${r.top.toFixed(3)} (2nd ${r.second.toFixed(3)}) — ${q}`);
}
console.log("\n=== أسئلة غير متعلقة ===");
const unrTops = [];
for (const q of UNRELATED) {
  const r = await topSim(q);
  unrTops.push(r.top);
  console.log(`  ${r.top.toFixed(3)} (2nd ${r.second.toFixed(3)}) — ${q}`);
}

const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log("\n=== الإحصاء ===");
console.log(`متعلق:    min=${min(relTops).toFixed(3)} avg=${avg(relTops).toFixed(3)} max=${max(relTops).toFixed(3)}`);
console.log(`غير متعلق: min=${min(unrTops).toFixed(3)} avg=${avg(unrTops).toFixed(3)} max=${max(unrTops).toFixed(3)}`);
console.log(`الفجوة: أدنى متعلق ${min(relTops).toFixed(3)} ↔ أعلى غير متعلق ${max(unrTops).toFixed(3)}`);
const suggested = ((min(relTops) + max(unrTops)) / 2);
console.log(`عتبة مقترحة (منتصف الفجوة): ${suggested.toFixed(3)}`);

await fetch(`${APP}/api/files/${fileId}`, { method: "DELETE", headers: { Cookie: cookie } });
