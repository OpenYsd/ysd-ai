/**
 * إثباتُ رايةِ الاقتران في الحزمة المُجمَّعة — لا في المصدر.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا لا يكفي اختبارُ المصدر
 *
 *  `NEXT_PUBLIC_*` رايةُ **وقتِ بناء**: يستبدل المُجمِّعُ نصَّها بقيمتها،
 *  ثم يطوي المُصغِّرُ الشرطَ إلى ثابت. واختبارُ الوحدة يقرأ `process.env`
 *  في Node — وهو مأهولٌ هناك دائمًا — فينجح ولو لم يقع الاستبدالُ أصلًا.
 *
 *  وذلك بعينه ما وقع في رايةِ الصورة (الطور 3C): تشتعل في الخادم وتنطفئ
 *  في المتصفّح، وآلافُ الاختبارات خضراء.
 *
 *  ★ وما لا يُدّعى هنا
 *
 *  لا يُشترط اختفاءُ كود الميزة من حزمةِ الإطفاء. فالمُجمِّعُ يُبقي الكودَ
 *  الميّتَ عادةً، واشتراطُ اختفائه ادّعاءُ هزٍّ للشجرة لا نملك إثباته.
 *
 *  والثابتُ المطلوب: **ألّا تُبلَغ الميزة**، لا أن تختفي.
 * ══════════════════════════════════════════════════════════════════
 *
 * الاستعمال:  node scripts/verify-local-pairing-flag.mjs
 * ولا يُشغَّل ضمن مجموعة الوحدات: ثلاثةُ بناءاتٍ كاملة أبطأُ من أن تُحتمل.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const PAIRING_VAR = "NEXT_PUBLIC_YSD_LOCAL_PAIRING";
const IMAGE_VAR = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const CHUNKS = join(ROOT, ".next", "static", "chunks");

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

/**
 * ★ لا يُبنى فوق خادمِ تطوير حيّ.
 *
 * البناءُ يكتب في `.next` نفسه، فيفسد رسمُ الوحدات تحت الخادم العامل
 * ويبدأ في ردّ 500. وقد وقع ذلك فعلًا في نظير هذا السكربت.
 */
function devServerRunning() {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 20000 });
    return out.split("\n").some((l) => /:3000\s/.test(l) && /LISTENING/i.test(l));
  } catch { return false; }
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/** يستخرج دالّةَ الراية كما شُحنت — اسمُ المتغيّر يبقى لأنه نصٌّ لا معرّف */
function extractFlagExpression(envVar) {
  for (const file of walk(CHUNKS)) {
    const src = readFileSync(file, "utf8");
    const i = src.indexOf(envVar);
    if (i < 0) continue;
    const window = src.slice(Math.max(0, i - 120), i + envVar.length + 10);
    const m = window.match(/function\s+\w*\(\w*\)\{return[^}]*\}/);
    if (m) return { file, expr: m[0] };
  }
  return null;
}

/**
 * ★ ملفّاتُ البيئة تُنحّى عند اختبار حالة «غائب».
 *
 * فملفٌّ في شجرة النشر يَسبق ما يُضبط في لوحة الاستضافة، وحزمةُ «الإطفاء»
 * تخرج مشتعلةً والاختبارُ يظنّ أنه يقيس الإطفاء.
 *
 * ★ والنسخُ الاحتياطيّ يخرج من المستودع بالكامل — فملفُّ بيئةٍ منسوخٌ
 *   بجوار أصله يحمل الأسرارَ نفسَها في شجرةٍ غيرِ متتبَّعة.
 */
const ENV_FILES = [".env.local", ".env.development.local", ".env.production.local", ".env"];

function withEnvFilesHidden(fn) {
  const backupDir = mkdtempSync(join(tmpdir(), "ysd-pairproof-"));
  const moved = [];
  try {
    for (const name of ENV_FILES) {
      const src = join(ROOT, name);
      if (existsSync(src)) {
        const dst = join(backupDir, name);
        renameSync(src, dst);
        moved.push([src, dst]);
      }
    }
    return fn();
  } finally {
    const failed = [];
    for (const [src, dst] of moved) {
      try { renameSync(dst, src); } catch { failed.push(`${src.replace(ROOT, ".")} (copy kept at ${dst})`); }
    }
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* قد يبقى إن فشلت الاستعادة */ }
    if (failed.length > 0) {
      console.error(`FATAL: could not restore env file(s): ${failed.join(", ")}`);
      process.exitCode = 3;
      throw new Error("env_restore_failed");
    }
  }
}

function runBuild(env) {
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  execFileSync("npm", ["run", "build"], { env, stdio: "pipe", timeout: 900_000, shell: true });
}

/** يبني بمصفوفةِ رايات، ثم يُعيد ما يلزم للحكم */
function build(flags) {
  const env = { ...process.env };
  const absent = [];
  for (const [name, value] of Object.entries(flags)) {
    if (value === null) { delete env[name]; absent.push(name); }
    else env[name] = value;
  }
  const run = () => {
    runBuild(env);
    return {
      pairing: extractFlagExpression(PAIRING_VAR),
      image: extractFlagExpression(IMAGE_VAR),
      chunks: walk(CHUNKS),
    };
  };
  return absent.length > 0 ? withEnvFilesHidden(run) : run();
}

/**
 * يُقيّم الدالّةَ المشحونة **بلا وسيط** — وهذا هو ما يُميّز.
 *
 * ★ المُصغِّر يطوي `env ? A : <literal>` إلى شكلين مختلفين:
 *
 *     الحرفيُّ صادق  ⇒  `!env || A`   ⇒  fn() === true
 *     الحرفيُّ كاذب  ⇒  `env && A`    ⇒  fn() === undefined
 *
 *   فالقيمةُ العائدة تقول أيَّ ثابتٍ وُضع مكان `process.env.…` وقتَ
 *   البناء. ولا تُقارَن بـ`false` حرفيًّا: الشكلُ الكاذب يعيد `undefined`
 *   لا `false`، ومقارنةٌ صارمة كانت ستسقط على النتيجة الصحيحة.
 */
const folds = (found) => {
  if (!found) return null;
  // eslint-disable-next-line no-eval
  return eval(`(${found.expr})`)();
};

/** يبحث في كلّ ما شُحن عن نصٍّ لا يجوز أن يكون فيه */
function scanShipped(chunks, needles) {
  const hits = [];
  for (const file of chunks) {
    const src = readFileSync(file, "utf8");
    for (const [label, re] of needles) if (re.test(src)) hits.push(`${label} in ${file.replace(ROOT, ".")}`);
  }
  return hits;
}

const FORBIDDEN = [
  ["hardcoded bearer", /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ["owner path", /[A-Za-z]:\\{1,2}Users\\{1,2}/],
  ["pairing code literal", /pairing\s*code\s*[:=]\s*["']\d{8}["']/i],
  ["private key material", /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/],
];

console.log("=== build-artifact proof of the local-pairing flag ===");
console.log("builds the client three times and reads what actually shipped\n");

if (devServerRunning()) {
  console.log("REFUSING: something is listening on :3000.");
  console.log("Building over a live dev server corrupts .next. Stop it first.");
  process.exit(2);
}

// ── المصفوفة A: كلُّ الرايات غائبة (نظيرُ الإنتاج) ────────────────
console.log("--- Matrix A: pairing ABSENT, image ABSENT (production-equivalent) ---");
const a = build({ [PAIRING_VAR]: null, [IMAGE_VAR]: null });

if (a.pairing === null) {
  ok(true, "A · pairing code eliminated entirely (strongest outcome)", "no flag expression in any chunk");
} else {
  ok(folds(a.pairing) !== true, "A · pairing flag folded to a falsy constant (acceptable)", a.pairing.expr);
}
ok(a.image === null || folds(a.image) !== true, "A · image flag is off too");

const aLeaks = scanShipped(a.chunks, FORBIDDEN);
ok(aLeaks.length === 0, "A · no secret, bearer or owner path in the shipped bundle", aLeaks.join(" | ") || "none");

// ── المصفوفة B: الاقترانُ وحدَه ───────────────────────────────────
console.log("\n--- Matrix B: pairing = 1, image ABSENT ---");
const b = build({ [PAIRING_VAR]: "1", [IMAGE_VAR]: null });

ok(Boolean(b.pairing), "B · pairing flag expression is present", b.pairing?.expr ?? "not found");
ok(folds(b.pairing) === true, "B · and it evaluates to true", String(folds(b.pairing)));
ok(b.image === null || folds(b.image) !== true, "B · image stays off — the flags are independent");

const differs = a.pairing === null ? true : a.pairing.expr !== b.pairing?.expr;
ok(differs, "B · the two builds differ (build-time substitution is real)",
  a.pairing === null ? "absent vs present" : "different folded constants");

const bLeaks = scanShipped(b.chunks, FORBIDDEN);
ok(bLeaks.length === 0, "B · no secret, bearer or owner path in the shipped bundle", bLeaks.join(" | ") || "none");

// ── المصفوفة D: الصورةُ وحدَها — لا انحدار ────────────────────────
console.log("\n--- Matrix D: pairing ABSENT, image = 1 (existing configuration) ---");
const d = build({ [PAIRING_VAR]: null, [IMAGE_VAR]: "1" });

ok(Boolean(d.image), "D · image flag expression is present", d.image?.expr ?? "not found");
ok(folds(d.image) === true, "D · and it evaluates to true — no regression");
ok(d.pairing === null || folds(d.pairing) !== true, "D · pairing stays off");

/**
 * ★ المصفوفة C (اقتران + صوت) لا تُبنى هنا.
 *
 *   شيفرةُ الصوت في الوِبّ ليست على فرع التطوير هذا بعد
 *   (`feature/local-voice-staging` لم يُدمَج). فبناءُ مصفوفةٍ برايةٍ لا
 *   تُقرأ في أيّ ملفّ يُثبت لا شيء — ويُقال ذلك بدل أن يُدَّعى.
 */
console.log("\n--- Matrix C: pairing + voice ---");
console.log("  SKIPPED: local-voice web code is not on this branch's base (staging).");
console.log("  Nothing would be measured. See docs/local-pairing.md.");

console.log("\n--- restoring the production-default build ---");
build({ [PAIRING_VAR]: null, [IMAGE_VAR]: null });
console.log("  .next rebuilt with every local flag absent");

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
