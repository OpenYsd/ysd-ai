/**
 * اختبار حد 20 تذكرة/ساعة لكل دعوة (beta_claim_invite بعد 0013).
 * يتطلب: 0013 مطبّقة + دعوة بسعة واسعة في scripts/.qa-invite.txt + owner
 *         في scripts/.qa-owner.json (لقراءة used_count من beta_invites).
 *
 * لماذا RPC مباشرة لا /api/invite/claim: المسار يُثبّت TTL على 600ث، فدورات
 * الانتهاء كانت ستستغرق ~70 دقيقة ويبدأ الحد الساعي بالانزلاق. الدالة هي نقطة
 * الإنفاذ الحقيقية (ومسار الهجوم: مُصرَّحة لـanon عبر PostgREST).
 *
 * منهج العزل: حد الـ3 النشطة وحدّ الـ20/ساعة يُرجعان false كلاهما. لعزل السبب
 * ننتظر انتهاء كل التذاكر قبل المحاولة 21 → النشطة = 0 → لا سبب ممكن للرفض
 * إلا الحد الزمني.
 *
 * لا يطبع الكود ولا التذاكر ولا أي مفتاح.
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
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const anon = () => createClient(URL_, ANON, { auth: { persistSession: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? ` — ${d}` : ""}`); } };

const MAX_ACTIVE = 3, MAX_HOURLY = 20, TTL = 60;

let code;
try { code = readFileSync(new URL("./.qa-invite.txt", import.meta.url), "utf8").trim(); }
catch { console.error("❌ لا يوجد scripts/.qa-invite.txt"); process.exit(1); }
const creds = JSON.parse(readFileSync(new URL("./.qa-owner.json", import.meta.url), "utf8"));
const oc = anon();
const li = await oc.auth.signInWithPassword({ email: creds.email, password: creds.password });
if (li.error) { console.error("owner login failed"); process.exit(1); }

const claim = async () => {
  const t = randomBytes(32).toString("base64url");
  const r = await anon().rpc("beta_claim_invite", { p_code: code, p_ticket_hash: sha256(t), p_ttl_seconds: TTL });
  return { granted: r.data === true, error: r.error?.message };
};
const validNow = async () => (await anon().rpc("beta_invite_valid", { p_code: code })).data === true;
const inviteState = async () => {
  const r = await oc.from("beta_invites").select("used_count, max_uses").eq("code_hash", sha256(code)).single();
  return r.data;
};

console.log(`قُرئ كود الدعوة (طوله ${code.length} — لا يُطبع)`);

// ---------- شرط الصحة: لا نُكمل بدعوة غير صالحة ----------
const startState = await inviteState();
const startValid = await validNow();
check("الدعوة صالحة عند البداية", startValid);
if (!startValid || !startState) {
  console.error("\n❌ الدعوة غير صالحة (مستنفدة/ملغاة/منتهية) — الاختبار باطل ويتوقف.");
  console.error("   كل رفض سيكون بسبب حالة الدعوة لا بسبب الحد الزمني.");
  process.exit(2);
}
check("سعة الدعوة تكفي (لا استنفاد أثناء الاختبار)", startState.max_uses - startState.used_count >= 1, `${startState.used_count}/${startState.max_uses}`);
console.log(`   الحالة الابتدائية: used_count = ${startState.used_count} / ${startState.max_uses}\n`);

// ---------- الدورات: 3 تذاكر ثم انتظار انتهائها ----------
console.log(`=== إصدار التذاكر بدورات انتهاء (TTL=${TTL}ث، ${MAX_ACTIVE} لكل دورة) ===`);
const attempts = [];
for (let i = 1; i <= MAX_HOURLY + 1; i++) {
  if (i > 1 && (i - 1) % MAX_ACTIVE === 0) {
    process.stdout.write(`   … انتظار انتهاء التذاكر النشطة (${TTL + 5}ث)\n`);
    await sleep((TTL + 5) * 1000);
  }
  const r = await claim();
  attempts.push(r);
  console.log(`   محاولة ${String(i).padStart(2)}: ${r.granted ? "✔ مُنحت" : "✘ رُفضت"}${r.error ? ` (خطأ: ${r.error.slice(0, 40)})` : ""}`);
}

const grantedCount = attempts.filter((a) => a.granted).length;
const first20 = attempts.slice(0, 20);
const attempt21 = attempts[20];

console.log("\n=== النتائج ===");
check("لا أخطاء قاعدة بيانات", attempts.every((a) => !a.error), attempts.find((a) => a.error)?.error?.slice(0, 60));
check(`★ أول ${MAX_HOURLY} claim نجحت كلها`, first20.every((a) => a.granted), `مُنحت=${first20.filter((a) => a.granted).length}/20`);
check("★ claim رقم 21 مرفوض", attempt21 && !attempt21.granted);
check("الإجمالي المُصدَر = 20 بالضبط", grantedCount === MAX_HOURLY, `الإجمالي=${grantedCount}`);

// ---------- عزل السبب: انتظر انتهاء كل التذاكر ثم أعد المحاولة ----------
console.log(`\n=== عزل السبب: انتظار انتهاء كل التذاكر (النشطة → 0) ===`);
await sleep((TTL + 5) * 1000);
const afterExpiry = await claim();
const stillValid = await validNow();
check("الدعوة ما زالت صالحة بعد كل المحاولات", stillValid);
check("★ الرفض بسبب الحد الزمني تحديدًا (النشطة = 0 بعد الانتهاء)", !afterExpiry.granted && stillValid,
  afterExpiry.granted ? "مُنحت بعد الانتهاء ⇒ الرفض السابق كان بحد الـ3 لا بالحد الزمني" : "الدعوة غير صالحة ⇒ السبب ليس الحد");
check("★ التنظيف لا يُصفّر الحد الزمني (لا حذف داخل النافذة)", !afterExpiry.granted);

// ---------- claim لا يستهلك الدعوة ----------
const endState = await inviteState();
check("★ used_count لم يتغيّر بسبب claim", endState.used_count === startState.used_count,
  `قبل=${startState.used_count} بعد=${endState.used_count}`);

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
