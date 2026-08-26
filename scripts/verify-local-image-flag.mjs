/**
 * إثباتُ الرايةِ في الحزمة المُجمَّعة — لا في المصدر.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا لا يكفي اختبارُ المصدر
 *
 *  `NEXT_PUBLIC_*` رايةُ **وقتِ بناء**: يستبدل المُجمِّعُ نصَّها بقيمتها،
 *  ثم يطوي المُصغِّرُ الشرطَ إلى ثابت. فاختبارُ الوحدة يقرأ `process.env`
 *  في Node — وهو مأهولٌ هناك دائمًا — فينجح ولو لم يقع الاستبدالُ أصلًا.
 *
 *  وذلك بعينه ما وقع في الطور 3C: الرايةُ تشتعل في الخادم وتنطفئ في
 *  المتصفّح، و3735 اختبارًا خضراء.
 *
 *  فهذا السكربتُ يبني الحزمةَ مرّتين ويقرأ **ما شُحن فعلًا**.
 *
 *  ★ وما لا يُدّعى هنا
 *
 *  لا يُشترط اختفاءُ كود الميزة من حزمةِ الإطفاء. فالمُجمِّعُ يُبقي الكودَ
 *  الميّتَ عادةً، واشتراطُ اختفائه ادّعاءُ هزٍّ للشجرة لا نملك إثباته.
 *
 *  والثابتُ الصحيح:
 *      إطفاء ⇒ الشرطُ يطوى إلى «كاذب»، فلا يُبلَغ عبر الواجهة
 *      إشعال ⇒ الشرطُ يطوى إلى «صادق»
 * ══════════════════════════════════════════════════════════════════
 *
 * الاستعمال:  node scripts/verify-local-image-flag.mjs
 * ولا يُشغَّل ضمن مجموعة الوحدات: بناءان كاملان أبطأُ من أن يُحتملا هناك.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, existsSync, renameSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const ENV_VAR = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const CHUNKS = join(ROOT, ".next", "static", "chunks");

let pass = 0;
let fail = 0;
function ok(cond, label, detail = "") {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * ★ لا يُبنى فوق خادمِ تطوير حيّ.
 *
 * البناءُ يكتب في `.next` نفسه، فيفسد رسمُ الوحدات تحت الخادم العامل
 * ويبدأ في ردّ 500. وقد وقع ذلك فعلًا — فيُفحص المنفذُ قبل البدء.
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

/**
 * تُستخرج دالّةُ الراية من الحزمة كما شُحنت.
 *
 * والبحثُ بالاسم المُصغَّر متعذّر — فيُبحث عن اسم المتغيّر نفسه، وهو
 * يبقى في الشيفرة لأنه مفتاحُ كائنٍ لا اسمُ متغيّر يُصغَّر.
 */
function extractFlagExpression() {
  for (const file of walk(CHUNKS)) {
    const src = readFileSync(file, "utf8");
    const i = src.indexOf(ENV_VAR);
    if (i < 0) continue;
    const window = src.slice(Math.max(0, i - 120), i + ENV_VAR.length + 10);
    const m = window.match(/function\s+\w*\(\w*\)\{return[^}]*\}/);
    if (m) return { file, expr: m[0] };
  }
  return null;
}

/**
 * ★ ملفّاتُ البيئة تُنحّى عند اختبار حالة «غائب».
 *
 * وهذا العطبُ وقع فعلًا في أوّل تشغيل: حُذف المتغيّرُ من بيئة العمليّة،
 * فبنى Next وهو يقرأ `.env.local` من المستودع — وفيه الرايةُ مشتعلة
 * لأجل التطوير المحلّيّ. فخرجت حزمةُ «الإطفاء» مشتعلةً، والاختبارُ يظنّ
 * أنه يقيس الإطفاء.
 *
 * ودرسُه أوسعُ من السكربت: أيُّ ملفِّ بيئةٍ في شجرة النشر يَسبق ما يُضبط
 * في لوحة الاستضافة. فالإنتاجُ يجب أن يخلو من الرايةِ في الاثنين معًا.
 */
const ENV_FILES = [".env.local", ".env.development.local", ".env.production.local", ".env"];

/**
 * ★ النسخُ الاحتياطيّ يخرج من المستودع بالكامل.
 *
 * كان يُكتب بجوار الأصل باسم `.env.local.__flagproof_backup__`، فظهر ملفٌّ
 * غيرُ متتبَّع في شجرة العمل يحمل **نفسَ الأسرار**: مفتاحَ الخدمة في
 * Supabase ومفاتيحَ المزوّدين. و`.gitignore` لا يغطّي ذلك الاسم.
 *
 * ★ ولم يُعالَج بإضافته إلى `.gitignore`.
 *
 * فذلك يُبقي الأسرارَ في شجرة العمل ويعتمد على قاعدةٍ نصّية تُنسى أو
 * تُخالَف بـ`git add -f`. وإخراجُ الملفّ من المستودع يزيل الاحتمالَ نفسَه:
 * لا يوجد ما يُتجاهَل لأنه ليس هناك أصلًا.
 *
 * ويُنشأ مجلّدٌ فريد لكلّ تشغيل — فتشغيلان متوازيان لا يدوس أحدُهما نسخةَ
 * الآخر.
 */

function withEnvFilesHidden(fn) {
  /**
   * ★ مجلّدٌ جديد لكلّ نداء — لا واحدٌ عند تحميل الوحدة.
   *
   * فأوّلُ نداءٍ ينظّف المجلّدَ في `finally`، والنداءُ الثاني (إعادةُ
   * بناء الإطفاء في الآخر) يجدُه محذوفًا فيسقط بـENOENT.
   */
  const backupDir = mkdtempSync(join(tmpdir(), "ysd-flagproof-"));
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
    /**
     * ★ الاستعادةُ تفشل معلنةً — ولا تُبتلع.
     *
     * فلو تعذّرت إعادةُ ملفِّ بيئةِ المطوّر وسكت السكربت، لبحث صاحبُه عن
     * ملفٍّ يظنّه ضائعًا. والمكانُ يُذكر، والمحتوى لا يُطبع أبدًا.
     */
    const failed = [];
    for (const [src, dst] of moved) {
      try {
        renameSync(dst, src);
      } catch (e) {
        failed.push(`${src.replace(ROOT, ".")} (copy kept at ${dst})`);
      }
    }
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* قد يبقى إن فشلت الاستعادة */ }
    if (failed.length > 0) {
      console.error("FATAL: could not restore env file(s): " + failed.join(", "));
      process.exitCode = 3;
      throw new Error("env_restore_failed");
    }
  }
}

function runBuild(env) {
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  execFileSync("npm", ["run", "build"], { env, stdio: "pipe", timeout: 600_000, shell: true });
  return extractFlagExpression();
}

function build(value) {
  const env = { ...process.env };
  if (value === null) {
    delete env[ENV_VAR];
    /** «غائب» يعني غائبًا من البيئة **ومن ملفّاتها** */
    return withEnvFilesHidden(() => runBuild(env));
  }
  env[ENV_VAR] = value;
  return runBuild(env);
}

console.log("=== build-artifact proof of the local-image flag ===");
console.log("builds the client twice and reads the shipped constant\n");

if (devServerRunning()) {
  console.log("REFUSING: something is listening on :3000.");
  console.log("Building over a live dev server corrupts .next. Stop it first.");
  process.exit(2);
}

console.log("--- Build A: variable ABSENT (production default) ---");
const off = build(null);

/**
 * ★ الثابتُ المطلوب: **ألّا تُبلَغ الميزة** — لا شكلٌ بعينه في الحزمة.
 *
 * وللإطفاء مخرجان صحيحان، وكلاهما مقبول:
 *
 *   (أ) يختفي الكودُ كلَّه — لأنّ الشرطَ طُوي إلى «كاذب» فحُذف الفرعُ
 *       الميّت وما يتفرّع عنه.
 *   (ب) يبقى الكودُ والشرطُ ثابتٌ كاذب، فلا يُبلَغ عبر الواجهة.
 *
 * ★ ولا يُشترط أحدُهما بعينه.
 *
 * فأوّلُ صيغةٍ كتبتُها اشترطت وجودَ الدالّة في حزمة الإطفاء، فسقطت حين
 * حذفها المُجمِّعُ فعلًا — أي أنّ الحارسَ رسب على أفضلِ نتيجةٍ ممكنة.
 * واشتراطُ الاختفاء عكسُه: ادّعاءُ هزٍّ للشجرة لا يضمنه المُجمِّع.
 */
if (off === null) {
  ok(true, "OFF build: feature code eliminated entirely (strongest outcome)", "no flag expression in any chunk");
} else {
  // eslint-disable-next-line no-eval
  const fn = eval(`(${off.expr})`);
  ok(fn() === false, "OFF build: code present but folded to false (acceptable)", off.expr);
}

console.log("\n--- Build B: variable = 1 ---");
const on = build("1");
ok(Boolean(on), "flag expression found in the ON bundle", on?.expr ?? "not found");
if (on) {
  // eslint-disable-next-line no-eval
  const fn = eval(`(${on.expr})`);
  ok(fn() === true, "ON build evaluates to true with no argument", String(fn()));
}

/**
 * والفرقُ بين الحزمتين هو إثباتُ وقوعِ الاستبدال أصلًا.
 * وغيابُ الدالّة في الإطفاء ووجودُها في الإشعال فرقٌ كافٍ.
 */
if (on) {
  const differs = off === null ? true : off.expr !== on.expr;
  ok(differs, "the two builds differ (build-time substitution is real)",
    off === null ? "absent vs present" : "different folded constants");
}

/**
 * ولا يُشترط غيابُ الكود عن حزمة الإطفاء — يُذكر للعلم فقط.
 */
console.log("\n--- note (not an assertion) ---");
console.log(`  feature code present in the OFF bundle: ${off !== null}`);
console.log("  either outcome is fine; the invariant asserted is unreachability, not absence.");

/** تُعاد الشجرةُ إلى وضع الإنتاج كي لا يُترك بناءُ الإشعال وراءنا */
console.log("\n--- restoring the production-default build ---");
build(null);
console.log("  .next rebuilt with the variable absent");

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
