/**
 * إثباتُ رايةِ الصوت المحلّيّ من الحزمة المشحونة — لا من نصّ المصدر.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا مُحقِّقٌ ثانٍ لا تعميمُ الأوّل
 *
 *  `verify-local-image-flag.mjs` يحرس الإنتاجَ منذ الطور 3N وقد أُثبت
 *  عمليًّا. وتعميمُه ليخدم رايتين يعني تعديلَ حارسٍ يعمل — ومكسبُ الصوت
 *  لا يستحقّ المخاطرةَ بإثبات الصور. فهذا ملفٌّ مستقلّ، وذاك يبقى كما هو.
 *
 *  ★ وما يُقاس
 *
 *  `NEXT_PUBLIC_*` رايةُ **وقتِ بناء**: يستبدل المُجمِّعُ نصَّها بقيمتها،
 *  فما يُشحن إلى المتصفّح ثابتٌ لا يقرأ بيئةً. فلا يُجدي فحصُ المصدر ولا
 *  فحصُ `process.env` وقتَ التشغيل: تُنتزع البوّابةُ من الحزمة و**تُنفَّذ**.
 *
 *  ★ والترويسةُ تُقرأ من خادمٍ حقيقيّ
 *
 *  `Permissions-Policy` تُخبَز في بيان المسارات، و`Content-Security-Policy`
 *  يبنيها الوسيطُ عند الطلب. فلا سبيلَ إلى قياسهما معًا إلا بتشغيل البناء
 *  وقراءةِ استجابةٍ فعليّة. وأربعُ تركيباتٍ تُبنى وتُخدَم، لأنّ الصوتَ
 *  والصورةَ يتقاسمان الأصلَ الحلقيَّ نفسَه فيلزم قياسُ تداخلهما.
 * ══════════════════════════════════════════════════════════════════
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const VOICE = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const IMAGE = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const CHUNKS = join(ROOT, ".next", "static", "chunks");
const SERVER = join(ROOT, ".next", "server");
const PORT = Number(process.env.YSD_VERIFY_PORT ?? 3287);

/** علاماتُ الميزة — لو بقيت وغابت البوّابةُ فالاستخراجُ فشل، لا الميزةُ اختفت */
const VOICE_MARKERS = ["voice-mic", "voice-privacy", "/voice/transcribe", "local-voice"];

/**
 * ★ كلُّ ما يجب أن يُقرأ «مطفأة».
 *
 * القيمةُ التي تبدو مشتعلةً للناظر وهي مطفأةٌ للكود هي بذرةُ العطب —
 * فتُقاس كلُّها، لا الغيابُ وحدَه.
 */
const MUST_BE_OFF = ["", "0", "false", "true", "yes", "on", " 1", "1 ", "01"];

const LOOPBACK = "http://127.0.0.1:47615";

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/** تُنتزع الدالّةُ المحيطةُ بالراية كاملةً لتكون قابلةً للتنفيذ */
export function extractVoiceGates(dirs) {
  const found = new Set();
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      let i = src.indexOf(VOICE);
      while (i >= 0) {
        const start = src.lastIndexOf("function", i);
        if (start >= 0 && i - start < 300) {
          const open = src.indexOf("{", start);
          if (open >= 0 && open < i) {
            let depth = 0, end = -1;
            for (let k = open; k < src.length; k++) {
              if (src[k] === "{") depth++;
              else if (src[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
            }
            if (end > start) {
              const expr = src.slice(start, end + 1);
              if (expr.includes(VOICE) && expr.length <= 600) found.add(expr);
            }
          }
        }
        i = src.indexOf(VOICE, i + 1);
      }
    }
  }
  return [...found];
}

/** يُنفَّذ التعبيرُ ببيئةٍ مُحقونة — لا يُطابَق شكلُه */
export function runGate(expr, override) {
  const m = expr.match(new RegExp(`([A-Za-z_$][\\w$]*)\\.env\\.${VOICE}`));
  return new Function(m ? m[1] : "__unused__", `return (${expr});`)({ env: {} })(override);
}

function markersPresent(dirs) {
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      if (VOICE_MARKERS.some((mk) => src.includes(mk))) return true;
    }
  }
  return false;
}

function build(env) {
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  execFileSync("npm", ["run", "build"], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe", timeout: 900_000, shell: true,
  });
}

async function serve(env) {
  const child = spawn("npm", ["start"], {
    cwd: ROOT, env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: "pipe", shell: true,
  });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "follow" }); return child; } catch { /* لم يستمع */ }
  }
  child.kill();
  throw new Error("the built server did not start");
}

/**
 * تُقرأ الترويسةُ بلا اتّباع تحويل.
 *
 * ★ ولا يُستعمل `fetch` هنا: مع `redirect:"manual"` يُعيد استجابةً معتِمة
 *   ترويساتُها فارغة، فتمرّ الفحوصُ على نصٍّ فارغ مرورًا كاذبًا.
 */
function header(name) {
  let out = "";
  try {
    out = execFileSync("curl", ["-s", "-D", "-", "-o", "/dev/null", "--max-time", "25", `http://127.0.0.1:${PORT}/`], { encoding: "utf8" });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const line = out.split(NL).map((l) => l.split(CR).join(""))
    .find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(name.length + 1).trim() : "";
}

function killPort() {
  try {
    const list = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" })
      .split(String.fromCharCode(10))
      .filter((l) => l.includes(":" + PORT + " ") && /LISTENING/i.test(l));
    for (const pid of [...new Set(list.map((l) => l.trim().split(/\s+/).pop()))]) {
      try { execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" }); } catch { /* ذهب */ }
    }
  } catch { /* لا netstat — بيئةٌ غيرُ ويندوز */ }
}

let pass = 0, fail = 0;
const failed = [];
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; failed.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

/**
 * ★ الغيابُ يُفضَّل، و«0» بديلٌ مُعلَن.
 *
 * في CI لا وجودَ لملفّات بيئةٍ غيرِ متتبَّعة، فالغيابُ حقيقيّ. أمّا على جهاز
 * مطوّرٍ فقد يضبط `.env.local` رايةً، وNext لا يدهس ما في `process.env` —
 * فيُضبط صراحةً بـ«0» ويُعلَن ذلك. والغيابُ نفسُه يُقاس على البوّابة
 * المشحونة بحقن `undefined`، وهو الإثباتُ الدلاليّ المطلوب.
 */
function offValue(name) {
  const files = [".env.local", ".env.development.local", ".env.production.local", ".env"];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    if (new RegExp(`^\\s*${name}\\s*=`, "m").test(readFileSync(p, "utf8"))) return "0";
  }
  return undefined;
}
function envFor(voiceOn, imageOn) {
  const e = {};
  const vOff = offValue(VOICE);
  const iOff = offValue(IMAGE);
  if (voiceOn) e[VOICE] = "1"; else if (vOff !== undefined) e[VOICE] = vOff; else delete e[VOICE];
  if (imageOn) e[IMAGE] = "1"; else if (iOff !== undefined) e[IMAGE] = iOff;
  return e;
}

console.log("=== local-voice flag: semantic proof from the shipped build ===");
console.log("builds four combinations, serves each, and EXECUTES the shipped gate\n");
{
  const v = offValue(VOICE), i = offValue(IMAGE);
  console.log(`  OFF is expressed as: ${VOICE}=${v ?? "<absent>"} · ${IMAGE}=${i ?? "<absent>"}`);
  if (v !== undefined || i !== undefined) {
    console.log('  (an untracked env file sets a flag on this machine, so "0" is used instead of absence;');
    console.log("   absence itself is still proven by executing the shipped gate with no value)\n");
  }
}

const CASES = [
  { label: "voice OFF + image OFF (production default)", voice: false, image: false, mic: "()", loopback: 0 },
  { label: "voice ON  + image OFF", voice: true, image: false, mic: "(self)", loopback: 1 },
  { label: "voice OFF + image ON", voice: false, image: true, mic: "()", loopback: 1 },
  { label: "voice ON  + image ON", voice: true, image: true, mic: "(self)", loopback: 1 },
];

for (const c of CASES) {
  console.log(`\n--- ${c.label} ---`);
  const env = envFor(c.voice, c.image);
  build(env);
  let child = null;
  try {
    child = await serve(env);

    const pp = header("permissions-policy");
    const csp = header("content-security-policy");
    ok(pp.length > 0, "a Permissions-Policy header is actually present");
    ok(csp.length > 0, "a Content-Security-Policy header is actually present");
    if (!pp.length || !csp.length) continue;

    ok(pp === `camera=(), microphone=${c.mic}, geolocation=()`, "Permissions-Policy matches exactly", pp);
    ok(/(^|[ ;])camera=\(\)/.test(pp), "camera stays blocked");
    ok(/(^|[ ;])geolocation=\(\)/.test(pp), "geolocation stays blocked");
    ok(!/microphone=\*|microphone=\("?\*/.test(pp), "microphone is never a wildcard");
    ok(!/camera=\(self\)|geolocation=\(self\)/.test(pp), "camera and geolocation never gain self");
    ok(!/https?:\/\/|127\.0\.0\.1|localhost/.test(pp), "no origin or loopback address inside Permissions-Policy");

    const n = (csp.match(/http:\/\/127\.0\.0\.1:47615/g) ?? []).length;
    ok(n === c.loopback, `connect-src carries the loopback origin ${c.loopback} time(s)`, `found ${n}`);
    ok(!/localhost/.test(csp), "no localhost alias in CSP");
    ok(!/127\.0\.0\.1:\*/.test(csp), "no wildcard port on the loopback");
    ok(!/ws:\/\/127\.|wss:\/\/127\./.test(csp), "no websocket loopback origin");
    ok(!/192\.168\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\./.test(csp), "no LAN origin");
    const connect = csp.split(";").find((s) => s.includes("connect-src")) ?? "";
    ok(!/127\.0\.0\.1:(?!47615)\d+/.test(connect), "no second loopback port");
    if (c.loopback === 0) ok(!/127\.0\.0\.1/.test(csp), "production-default CSP names no loopback at all");

    const gates = extractVoiceGates([CHUNKS]);
    const serverGates = extractVoiceGates([SERVER]);
    const markers = markersPresent([CHUNKS]);

    /**
     * ★ «لم أجد بوّابة» ليست «الميزةُ غائبة».
     *
     * لو بقيت علاماتُ الميزة في الحزمة وغابت البوّابةُ فالاستخراجُ عجز —
     * وتحويلُ العجز إلى نجاحٍ هو ما يجعل الحارسَ يكذب يومَ يتغيّر المُصغِّر.
     */
    if (gates.length === 0 && markers) {
      ok(false, "UNSOUND: voice markers ship but no gate could be extracted");
    } else if (gates.length === 0) {
      ok(!c.voice, "no voice gate shipped and no voice markers", "absent");
    } else {
      const want = c.voice;
      const live = gates.map((g) => runGate(g, undefined));
      ok(live.every((v) => v === want), `every shipped client gate executes ${want}`, JSON.stringify(live));
      if (serverGates.length) {
        const sv = serverGates.map((g) => runGate(g, undefined));
        ok(sv.every((v) => v === want), `every shipped server gate executes ${want}`, JSON.stringify(sv));
      }
      if (!want) {
        const offs = MUST_BE_OFF.filter((val) => gates.some((g) => runGate(g, { [VOICE]: val }) !== false));
        ok(offs.length === 0, "no near-miss value enables it", offs.length ? JSON.stringify(offs) : MUST_BE_OFF.map((v) => `"${v}"`).join(" "));
        ok(gates.some((g) => runGate(g, { [VOICE]: "1" }) === true), 'literal "1" does enable it (so the extracted expression really is the gate)');
      }
    }
  } finally {
    if (child) child.kill();
    await new Promise((r) => setTimeout(r, 1500));
    killPort();
  }
}

console.log("\n--- restoring the production-default build ---");
build(envFor(false, false));
console.log("  .next rebuilt with both local flags off");

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
if (failed.length) console.log("failed:\n" + failed.map((f) => "  - " + f).join("\n"));
console.log("\nLocal Voice remains OFF unless NEXT_PUBLIC_YSD_LOCAL_VOICE is literal 1 at build time.");
process.exitCode = fail ? 1 : 0;
