/**
 * اختبار تزامن beta_claim_invite (بعد 0013).
 * ينادي الـRPC **مباشرة** بالمفتاح العلني متجاوزًا /api/invite/claim عمدًا —
 * لأن هذا هو مسار الهجوم الذي يُغلقه الحد داخل قاعدة البيانات. الـRate Limit
 * في المسار طبقة إضافية فقط، لا الحماية الأساسية.
 *
 * التشغيل: node scripts/claim-concurrency-check.mjs [--hourly]
 *   --hourly يختبر أيضًا حد 20/ساعة عبر دورات انتهاء (يستغرق ~8 دقائق).
 * يتطلب: 0013 مطبّقة + كود دعوة في scripts/.qa-invite.txt (لا يُطبع).
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } };

let code;
try { code = readFileSync(new URL("./.qa-invite.txt", import.meta.url), "utf8").trim(); }
catch { console.error("❌ لا يوجد scripts/.qa-invite.txt"); process.exit(1); }
console.log(`قُرئ كود الدعوة (طوله ${code.length} — لا يُطبع)\n`);

/** claim مباشر عبر RPC — لا يمرّ بمسارنا ولا بالـRate Limit */
async function claimDirect(ttl = 600) {
  const ticket = randomBytes(32).toString("base64url");
  const hash = sha256(ticket);
  const r = await anon().rpc("beta_claim_invite", { p_code: code, p_ticket_hash: hash, p_ttl_seconds: ttl });
  return { granted: r.data === true, hash, ticket, error: r.error?.message };
}
const validNow = async () => (await anon().rpc("beta_invite_valid", { p_code: code })).data === true;

console.log("=== 1) 20 طلب claim متوازيًا لنفس الدعوة (RPC مباشر) ===");
const before = await validNow();
check("الدعوة صالحة قبل البدء", before);
const results = await Promise.all(Array.from({ length: 20 }, () => claimDirect()));
const granted = results.filter((r) => r.granted);
const errored = results.filter((r) => r.error);
check("لا أخطاء قاعدة بيانات (لا تسابق ولا jamود)", errored.length === 0, errored[0]?.error?.slice(0, 60));
check("★ لا تتجاوز التذاكر الممنوحة 3", granted.length <= 3, `مُنحت=${granted.length}/20`);
check("مُنحت تذكرة واحدة على الأقل", granted.length >= 1, `مُنحت=${granted.length}`);
check("★ لا تكرار في ticket_hash", new Set(results.map((r) => r.hash)).size === 20);
check("الرفض عام: false لا استثناء يكشف السبب", results.every((r) => r.granted || r.error === undefined));

console.log("\n=== 2) claim لا يستهلك الدعوة — التسجيل وحده يستهلكها ===");
check("★ الدعوة ما زالت صالحة بعد 20 claim (used_count لم يتغير)", await validNow());

console.log("\n=== 3) طلب إضافي والحد النشط ممتلئ → رفض عام ===");
const extra = await claimDirect();
check("claim إضافي مرفوض (3 نشطة)", !extra.granted);
check("الرفض لا يميّز عن كود خاطئ (نفس false)", extra.granted === false);
const badCode = await anon().rpc("beta_claim_invite", { p_code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ", p_ticket_hash: sha256("x"), p_ttl_seconds: 600 });
check("كود خاطئ → false أيضًا (لا تمييز)", badCode.data === false);

console.log("\n=== 4) hash غير صالح مرفوض ===");
const badHash = await anon().rpc("beta_claim_invite", { p_code: code, p_ticket_hash: "not-a-hash", p_ttl_seconds: 600 });
check("ticket_hash غير سداسي/64 → false", badHash.data === false);

console.log("\n=== 5) التسجيل بتذكرة صالحة يستهلك الدعوة ===");
if (granted.length) {
  const email = `ysd.qa.conc.${Date.now()}@qa-ysd.com`;
  const su = await anon().auth.signUp({
    email, password: `Ysd!Qa${Math.random().toString(36).slice(2, 12)}Z9`,
    options: { data: { display_name: "QA تزامن", terms_accepted: "true", invite_ticket: granted[0].ticket } },
  });
  check("التسجيل بتذكرة ممنوحة نجح", !su.error, su.error?.message?.slice(0, 60));
  const reuse = await anon().auth.signUp({
    email: `ysd.qa.conc2.${Date.now()}@qa-ysd.com`, password: `Ysd!Qa${Math.random().toString(36).slice(2, 12)}Z9`,
    options: { data: { display_name: "إعادة", terms_accepted: "true", invite_ticket: granted[0].ticket } },
  });
  check("★ إعادة استخدام نفس التذكرة مرفوضة", Boolean(reuse.error));
  console.log(`  ℹ حساب QA: ${email}`);
}

if (process.argv.includes("--hourly")) {
  console.log("\n=== 6) حد 20/ساعة عبر دورات انتهاء (~8 دقائق) ===");
  // TTL الأدنى 60ث (مثبَّت داخل الدالة). كل دورة: 3 تذاكر ثم ننتظر انتهاءها.
  let total = granted.length;
  let blocked = false;
  for (let round = 0; round < 8 && !blocked; round++) {
    await sleep(65_000); // انتظر انتهاء التذاكر النشطة
    const batch = await Promise.all([claimDirect(60), claimDirect(60), claimDirect(60), claimDirect(60)]);
    const g = batch.filter((b) => b.granted).length;
    total += g;
    console.log(`  دورة ${round + 1}: مُنحت ${g} (الإجمالي ${total})`);
    if (g === 0) blocked = true;
  }
  check("★ الحد الزمني يوقف الإصدار عند 20/ساعة", blocked && total <= 20, `الإجمالي=${total}`);
  check("التنظيف لا يُصفّر الحدّ الزمني (لا حذف داخل النافذة)", total <= 20, `الإجمالي=${total}`);
} else {
  console.log("\n=== 6) حد 20/ساعة — تُخطّى (شغّل بـ --hourly لاختبارها حيًا) ===");
}

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
