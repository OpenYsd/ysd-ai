/** قياس تجهيز مستند أكبر: عدد المقاطع، الزمن، والذاكرة المُبلّغة من الخادم */
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
function cookieHeader(s) {
  const v = "base64-" + Buffer.from(JSON.stringify(s), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (v.length <= 3180) return `sb-${projectRef}-auth-token=${v}`;
  const p = []; for (let i = 0; i * 3180 < v.length; i++) p.push(`sb-${projectRef}-auth-token.${i}=${v.slice(i * 3180, (i + 1) * 3180)}`);
  return p.join("; ");
}
const c = createClient(URL_, ANON, { auth: { persistSession: false } });
const ts = Date.now();
const su = await c.auth.signUp({ email: `ysd.qa.big.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
await c.auth.setSession(su.data.session);
const cookie = cookieHeader(su.data.session);

// مستند ~14 فقرة متمايزة (يفرض عدة مقاطع)
const TOPICS = [
  "قواعد البيانات العلائقية تخزن البيانات في جداول مترابطة بمفاتيح.",
  "قواعد البيانات غير العلائقية تناسب البيانات غير المهيكلة والمرنة.",
  "الفهرسة تسرّع عمليات البحث لكنها تبطئ عمليات الكتابة قليلًا.",
  "المعاملات تضمن سلامة البيانات عبر خصائص ACID الأربع.",
  "النسخ الاحتياطي المنتظم يحمي من فقدان البيانات عند الأعطال.",
  "التطبيع يقلل التكرار في قواعد البيانات ويحسّن الاتساق.",
  "واجهات برمجة التطبيقات تتيح للأنظمة التواصل بشكل موحّد وآمن.",
  "المصادقة تتحقق من هوية المستخدم قبل منحه صلاحية الوصول.",
  "التخزين المؤقت يقلل زمن الاستجابة بتخزين النتائج المتكررة.",
  "التحجيم الأفقي يوزع الحمل على عدة خوادم لزيادة الطاقة.",
  "التشفير يحمي البيانات أثناء النقل وأثناء التخزين على حد سواء.",
  "المراقبة تكشف المشاكل مبكرًا عبر تتبع المقاييس والسجلات.",
  "خطوط المعالجة تنظّم تدفق البيانات عبر مراحل متتابعة واضحة.",
  "البحث الدلالي يستخدم المتجهات لإيجاد النصوص المتقاربة معنى.",
];
const DOC = TOPICS.map((t, i) => `القسم ${i + 1}\n\n${t} ${t} وهذا شرح إضافي موسّع لكل نقطة حتى يصبح المقطع بحجم مناسب للاختبار الفعلي مع تكرار الفكرة بصياغة مختلفة قليلًا.`).join("\n\n");

const form = new FormData();
form.append("file", new File([Buffer.from(DOC, "utf8")], "مستند-كبير.txt", { type: "text/plain" }));
const up = await fetch(`${APP}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: form });
const fileId = (await up.json())?.file?.id;

const t0 = Date.now();
const rag = await fetch(`${APP}/api/files/${fileId}/rag`, { method: "POST", headers: { Cookie: cookie } });
const body = await rag.json();
const ms = Date.now() - t0;
console.log(`حجم النص: ${DOC.length} حرف`);
console.log(`عدد المقاطع: ${body?.totalChunks}`);
console.log(`زمن التجهيز: ${ms}ms (بعد تحميل النموذج مسبقًا)`);
console.log(`الحالة: ${body?.file?.status}`);

// عينة استرجاع
await fetch(`${APP}/api/files/${fileId}`, { method: "DELETE", headers: { Cookie: cookie } });
