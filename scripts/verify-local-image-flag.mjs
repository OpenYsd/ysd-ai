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
 *  ★ الثابتُ المُثبَت هنا — دلاليٌّ لا نصّيّ
 *
 *      إطفاء ⇒ دالّةُ الراية المشحونة **تُنفَّذ فتُرجع كاذبًا**
 *      إشعال ⇒ دالّةُ الراية المشحونة **تُنفَّذ فتُرجع صادقًا**
 *
 *  ولا يُشترط اختفاءُ كود الميزة من حزمةِ الإطفاء. فالمُجمِّعُ يُبقي الكودَ
 *  الميّتَ عادةً، واشتراطُ اختفائه ادّعاءُ هزٍّ للشجرة لا نملك إثباته.
 *
 *  ★ ولماذا صار الإثباتُ بالتنفيذ لا بمطابقة النصّ (الطور 3N)
 *
 *  كان المستخرِجُ يقرأ نافذةً ثابتة: ١٢٠ محرفًا قبل اسم المتغيّر وعشرةً
 *  بعده، ثم يطابقها بنمطٍ يشترط قوسَ الإغلاق داخلها.
 *
 *  وفي حزمة **الإطفاء** تكون الدالّة:
 *      function l(e){return e?"1"===e.NEXT_PUBLIC_…:"1"===r.env.NEXT_PUBLIC_…}
 *  فأوّلُ ورودٍ للاسم يقع في الفرع الأوّل، ويبقى بعده ٤١ محرفًا حتى قوسِ
 *  الإغلاق — وهي خارج العشرة. فلا يطابق النمطُ شيئًا، ويعود `null`.
 *
 *  وفي حزمة **الإشعال** يُستبدل المتغيّرُ بـ`"1"` فيُطوى الفرعُ الثاني:
 *      function a(e){return!e||"1"===e.NEXT_PUBLIC_…}
 *  فيقع قوسُ الإغلاق بعد الاسم مباشرةً — داخل النافذة — فيطابق.
 *
 *  فكان الحارسُ يرى الإشعالَ ويعمى عن الإطفاء، ثم يفسّر عماه بأنّ الكودَ
 *  «حُذف بالكامل» — وهو أقوى ادّعاءٍ ممكن، مبنيٌّ على أضعفِ دليل: **لم أجد**.
 *
 *  ودرسُه: «لم أجد» ليست «ليس موجودًا». وحارسٌ يترجم فشلَ أداتِه إلى
 *  نجاحٍ للمنتَج يقلب معنى الاختبار رأسًا على عقب.
 *
 *  فصار الاستخراجُ يوازن الأقواس من `function` المحيطة، والحكمُ يُنفّذ
 *  الدالّةَ المستخرَجة بدل مطابقة شكلها.
 * ══════════════════════════════════════════════════════════════════
 *
 * الاستعمال:  node scripts/verify-local-image-flag.mjs
 * ولا يُشغَّل ضمن مجموعة الوحدات: بناءان كاملان أبطأُ من أن يُحتملا هناك.
 * ودوالُّ الحكم مُصدَّرة كي تُختبر بمنأى عن البناء.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, existsSync, renameSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const ENV_VAR = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const CHUNKS = join(ROOT, ".next", "static", "chunks");
const SERVER = join(ROOT, ".next", "server");

/**
 * ★ علاماتٌ لا يمسّها التصغير.
 *
 * أسماءُ الدوالّ تُصغَّر (`probeEngine` تصير `l`)، فغيابُها عن الحزمة لا
 * يدلّ على شيء. أمّا نصوصُ `data-testid` وما يُعرض للمستخدم فتبقى حرفيًّا.
 * وتُستعمل هنا لتمييز «حُذفت الميزة» عن «عجز المستخرِج».
 */
const FEATURE_MARKERS = ["local-ai-settings", "local-image-panel", "47615"];

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

export function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/**
 * تُستخرج دالّةُ الراية من نصٍّ مُصغَّر بموازنة الأقواس.
 *
 * تُبدأ من `function` السابقة لموضع الاسم، ويُعدّ الفتحُ والإغلاق حتى
 * يعود العمقُ صفرًا — فلا حدَّ أعلى مصطنعًا يقطع الدالّةَ في منتصفها.
 */
export function extractGatesFromSource(src, file = "") {
  const out = [];
  const seen = new Set();
  let i = src.indexOf(ENV_VAR);
  while (i >= 0) {
    const start = src.lastIndexOf("function", i);
    /** الاسمُ يجب أن يقع داخل جسمِ الدالّة لا قبلها */
    if (start >= 0 && i - start < 300) {
      const open = src.indexOf("{", start);
      if (open >= 0 && open < i) {
        let depth = 0;
        let end = -1;
        for (let k = open; k < src.length; k++) {
          if (src[k] === "{") depth += 1;
          else if (src[k] === "}") {
            depth -= 1;
            if (depth === 0) { end = k; break; }
          }
        }
        if (end > start) {
          const expr = src.slice(start, end + 1);
          /** حدٌّ سخيٌّ يستبعد دالّةً ضخمة صادف ورودُ الاسم داخلها */
          if (expr.includes(ENV_VAR) && expr.length <= 600 && !seen.has(expr)) {
            seen.add(expr);
            out.push({ file, expr });
          }
        }
      }
    }
    i = src.indexOf(ENV_VAR, i + 1);
  }
  return out;
}

export function extractGates(dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      out.push(...extractGatesFromSource(readFileSync(file, "utf8"), file));
    }
  }
  return out;
}

/**
 * ★ تُنفَّذ الدالّةُ المشحونة — ولا يُطابَق شكلُها.
 *
 * وقد تشير إلى متغيّرٍ حرٍّ من نطاق الوحدة (`r.env…` في المتصفّح،
 * `process.env…` في الخادم). فيُلتقط اسمُه ويُحقن كائنًا فارغًا.
 *
 * ★ ويُحجب `process` الحقيقيّ عمدًا.
 *
 * فلو نُفّذت دالّةُ الخادم في هذه العمليّة وبيئتُها تحمل الرايةَ مشتعلة،
 * لأرجعت «صادقًا» فمرّ إطفاءٌ معطوب. والمقصودُ قياسُ ما خُبز في الحزمة،
 * لا ما في بيئة المُختبِر.
 */
export function evaluateGate(expr, override) {
  const m = expr.match(/([A-Za-z_$][\w$]*)\.env\.NEXT_PUBLIC_YSD_LOCAL_IMAGE/);
  const freeName = m ? m[1] : "__ysd_unused__";
  const factory = new Function(freeName, `return (${expr});`);
  const fn = factory({ env: {} });
  return fn(override);
}

/**
 * ★ الدالّةُ المستخرَجة يجب أن تكون رايةً حقًّا.
 *
 * فلو التقط المستخرِجُ دالّةً أخرى صادف ورودُ الاسم فيها، لأرجعت «كاذبًا»
 * دائمًا — فيمرّ الإطفاءُ بلا معنى. فيُشترط أن تستجيب للقيمة الصريحة.
 */
export function isGenuineGate(expr) {
  try {
    return evaluateGate(expr, { [ENV_VAR]: "1" }) === true
        && evaluateGate(expr, { [ENV_VAR]: "0" }) === false;
  } catch { return false; }
}

export function markersPresent(dirs) {
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      if (FEATURE_MARKERS.some((k) => src.includes(k))) return true;
    }
  }
  return false;
}

/**
 * ★ حكمُ الإطفاء.
 *
 * ولا يُقبل «لم أجد بوّابة» وحدَه. فإن غابت البوّابةُ وبقيت علاماتُ
 * الميزة، فالأرجحُ عجزُ المستخرِج لا حذفُ المُجمِّع — وهو العطبُ الذي
 * أُصلح في هذا الطور. فيُرفض صراحةً بدل أن يُترجم إلى نجاح.
 */
export function assessOff(gates, hasMarkers) {
  if (gates.length === 0) {
    return hasMarkers
      ? { verdict: "unsound", reason: "no gate extracted although feature markers are present — cannot prove OFF semantics" }
      : { verdict: "absent", reason: "no gate and no feature markers — feature genuinely not shipped" };
  }
  const genuine = gates.filter((g) => isGenuineGate(g.expr));
  if (genuine.length === 0) {
    return { verdict: "unsound", reason: "extracted expressions do not behave like the flag gate" };
  }
  const offending = [];
  for (const g of genuine) {
    if (evaluateGate(g.expr, undefined) !== false) offending.push(`${g.expr} (no argument)`);
    else if (evaluateGate(g.expr, {}) !== false) offending.push(`${g.expr} (empty env)`);
  }
  return offending.length === 0
    ? { verdict: "inert", reason: `${genuine.length} gate(s) evaluate false with no runtime override` }
    : { verdict: "live", reason: offending.join(" | ") };
}

export function assessOn(gates) {
  if (gates.length === 0) return { verdict: "missing", reason: "no gate found in the ON bundle" };
  const genuine = gates.filter((g) => isGenuineGate(g.expr));
  const source = genuine.length > 0 ? genuine : gates;
  const notTrue = source.filter((g) => {
    try { return evaluateGate(g.expr, undefined) !== true; } catch { return true; }
  });
  return notTrue.length === 0
    ? { verdict: "enabled", reason: `${source.length} gate(s) evaluate true with no runtime override` }
    : { verdict: "not_enabled", reason: notTrue.map((g) => g.expr).join(" | ") };
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
  return {
    client: extractGates([CHUNKS]),
    server: extractGates([SERVER]),
    markers: markersPresent([CHUNKS]),
  };
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

/**
 * ★ منعُ الإشعالِ العَرَضيّ — فحصُ مصدرٍ صغير بجوار فحصِ الحزمة.
 *
 * فالبناءُ يثبت ما خرج هذه المرّة، وهذا يثبت ألّا يخرج مشتعلًا في المرّة
 * القادمة لأنّ قيمةً افتراضية تسرّبت إلى الصورة أو إلى ملفٍّ متتبَّع.
 */
function accidentalEnableGuards() {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const argLines = dockerfile.split(/\r?\n/).filter((l) => /^\s*ARG\s+NEXT_PUBLIC_YSD_LOCAL_IMAGE/.test(l));
  ok(argLines.length === 1, "Dockerfile declares the flag exactly once as ARG", `${argLines.length} line(s)`);
  ok(
    argLines.every((l) => !l.includes("=")),
    "Dockerfile ARG carries no default value",
    argLines.join(" | ") || "none",
  );

  const tracked = [".env.example", ".env.docker.example", "env.production.example"];
  const offenders = tracked.filter((f) => {
    const p = join(ROOT, f);
    if (!existsSync(p)) return false;
    /** يُقاس وجودُ المفتاح لا قيمتُه — ولا يُطبع سطرٌ من ملفّ بيئة */
    return readFileSync(p, "utf8").split(/\r?\n/).some((l) => /^\s*NEXT_PUBLIC_YSD_LOCAL_IMAGE\s*=/.test(l));
  });
  ok(offenders.length === 0, "no tracked env example file sets the flag", offenders.join(", ") || "none");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  console.log("=== build-artifact proof of the local-image flag ===");
  console.log("builds the client twice and EXECUTES the shipped gate\n");

  if (devServerRunning()) {
    console.log("REFUSING: something is listening on :3000.");
    console.log("Building over a live dev server corrupts .next. Stop it first.");
    process.exit(2);
  }

  console.log("--- accidental-enable guards (source) ---");
  accidentalEnableGuards();

  console.log("\n--- Build A: variable ABSENT (production default) ---");
  const off = build(null);
  const offVerdict = assessOff(off.client, off.markers);
  ok(
    offVerdict.verdict === "inert" || offVerdict.verdict === "absent",
    "OFF build: feature unreachable (client gate false / not shipped)",
    `${offVerdict.verdict}: ${offVerdict.reason}`,
  );

  /**
   * ★ سياسةُ المحتوى تُبنى في الخادم من الرايةِ نفسِها.
   *
   * فبوّابةٌ كاذبة في حزمة الخادم تعني أنّ فرعَ الحلقة المحلّية لا يُضاف
   * إلى `connect-src` أصلًا. ويُقاس المعنى لا النصّ.
   */
  const offServer = assessOff(off.server, false);
  ok(
    offServer.verdict === "inert" || offServer.verdict === "absent",
    "OFF build: server gate false ⇒ CSP emits no loopback origin",
    `${offServer.verdict}: ${offServer.reason}`,
  );

  console.log("\n--- Build B: variable = 1 ---");
  const on = build("1");
  const onVerdict = assessOn(on.client);
  ok(onVerdict.verdict === "enabled", "ON build: shipped gate evaluates true", `${onVerdict.verdict}: ${onVerdict.reason}`);

  /**
   * والفرقُ بين الحزمتين هو إثباتُ وقوعِ الاستبدال أصلًا.
   * فلو تطابق النصّان لكان البناءان واحدًا ولم يقع استبدالٌ البتّة.
   */
  const offExprs = off.client.map((g) => g.expr).sort().join("|");
  const onExprs = on.client.map((g) => g.expr).sort().join("|");
  ok(offExprs !== onExprs, "the two builds differ (build-time substitution is real)",
    offExprs === onExprs ? "identical bundles" : "different shipped gates");

  /**
   * ولا يُشترط غيابُ الكود عن حزمة الإطفاء — يُذكر للعلم فقط.
   */
  console.log("\n--- notes (not assertions) ---");
  console.log(`  OFF client gates extracted : ${off.client.length}`);
  console.log(`  OFF feature markers present: ${off.markers}`);
  console.log(`  ON  client gates extracted : ${on.client.length}`);
  console.log("  presence in the OFF bundle is acceptable; the invariant is unreachability, not absence.");

  /** تُعاد الشجرةُ إلى وضع الإنتاج كي لا يُترك بناءُ الإشعال وراءنا */
  console.log("\n--- restoring the production-default build ---");
  build(null);
  console.log("  .next rebuilt with the variable absent");

  console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
  process.exit(fail ? 1 : 0);
}
