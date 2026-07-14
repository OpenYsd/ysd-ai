/**
 * عامل RAG مستقل (سطر أوامر): npm run worker:rag
 *
 * ⚠️ حالة معماريّة صريحة:
 * الطابور دائم في قاعدة البيانات (rag_jobs) وهو مصدر الحقيقة. لكن معالجة وظائف
 * أي مستخدم من عملية خلفية مستقلة تتطلب تجاوز RLS — أي مفتاح service_role.
 * لم يُضَف أي مفتاح سري (بأمر منك). لذلك هذا العامل يعمل بأحد وضعين:
 *
 *   (أ) SUPABASE_SERVICE_ROLE_KEY متوفر في .env.local  → عامل حقيقي عبر كل المستخدمين.
 *       (يجب موافقتك على إضافة المفتاح أولًا — غير مُضاف الآن.)
 *   (ب) بلا مفتاح خدمة  → لا يمكنه معالجة وظائف المستخدمين (RLS يمنعه)،
 *       ويكتفي بالإبلاغ. المعالجة الفعلية حاليًا request-driven عبر /api/files/[id]/rag.
 *
 * لا يعتمد على متصفح مفتوح. الالتقاط ذري (claim_rag_job / SKIP LOCKED)،
 * فيمكن تشغيل عدة نسخ منه بأمان عند توفر مفتاح الخدمة.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const workerId = `worker:${randomUUID().slice(0, 8)}`;

if (!serviceKey) {
  console.log("=".repeat(60));
  console.log("عامل RAG — وضع (ب): لا يوجد SUPABASE_SERVICE_ROLE_KEY.");
  console.log("الطابور موجود في قاعدة البيانات (مصدر الحقيقة)، لكن معالجة");
  console.log("وظائف المستخدمين من عملية مستقلة تتطلب مفتاح خدمة (بموافقتك).");
  console.log("المعالجة الفعلية حاليًا request-driven عبر /api/files/[id]/rag.");
  console.log("لتفعيل العامل المستقل: أضف SUPABASE_SERVICE_ROLE_KEY ثم أعد التشغيل.");
  console.log("=".repeat(60));
  process.exit(0);
}

// وضع (أ): عامل حقيقي عبر service role — يتجاوز RLS، فالالتقاط عبر كل المستخدمين.
console.log(`عامل RAG (${workerId}) — وضع الخدمة.`);
createClient(url, serviceKey, { auth: { persistSession: false } });

// Graceful shutdown — لا نقطع وظيفة جارية؛ ننتظر انتهاء الحالية ثم نخرج.
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    console.log(`\n[${sig}] إيقاف لطيف — بانتظار انتهاء الوظيفة الحالية…`);
  });
}

// ملاحظة: claim_rag_job مقيّد بـ auth.uid()؛ عبر service role نحتاج التقاطًا إداريًا
// (claim_rag_job_admin عبر كل المستخدمين) يُضاف عند اعتماد مفتاح الخدمة والموافقة.
console.log("تنبيه: منطق التقاط الخدمة الإداري غير مُفعّل — بانتظار موافقتك على المعمارية.");
console.log("الإيقاف اللطيف مُهيّأ (SIGINT/SIGTERM). لا التقاط عبر المستخدمين بعد.");
process.exit(0);
