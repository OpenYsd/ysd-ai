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
 *
 *  ══ ما تعلّمه هذا الملفُّ من إخفاقه على GitHub Actions (4G.2) ══
 *
 *  ★ كان يُشغّل `npm start`، فينشأ `npm → sh → next-server`. و`child.kill()`
 *    يقتل الغلافَ ويترك الحفيدَ حيًّا، فتبقى مقابضُ Node مفتوحةً ولا تخرج
 *    العمليّةُ أبدًا — طُبع الملخّصُ كاملًا ثم عُلّقت الوظيفةُ 45 دقيقة حتى
 *    قتلتها المهلة. فصار يُشغّل الخرجَ المستقلّ بـNode مباشرةً، ويقتل
 *    **مجموعةَ العمليّات** لا الابنَ وحدَه.
 *
 *  ★ وكان يقيس على `/` بلا بيئةِ تشغيل. والوسيطُ يبني عميلَ Supabase قبل
 *    عودته المبكّرة، فبغير إعدادٍ صالحٍ نحويًّا لا تصل استجابةٌ تُقرأ
 *    ترويستُها. فصار يقيس على `/api/live` — مسارٌ عامٌّ يعود قبل أيّ نداءٍ
 *    شبكيّ — ببيئةٍ صوريّة على نطاق `.invalid` المحجوز. ولا سرَّ ولا نداءَ
 *    خارجيّ.
 *
 *  ★ والمهلُ محدودةٌ في كلّ مرحلة. فحارسٌ يعلّق حتى مهلةِ الوظيفة لا يقول
 *    شيئًا، ويُضيّع خمسًا وأربعين دقيقةً من كلّ مراجعة.
 * ══════════════════════════════════════════════════════════════════
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

const ROOT = process.cwd();
const VOICE = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const IMAGE = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const CHUNKS = join(ROOT, ".next", "static", "chunks");
const SERVER_DIR = join(ROOT, ".next", "server");
const STANDALONE = join(ROOT, ".next", "standalone", "server.js");
const HOST = "127.0.0.1";
const PORT = Number(process.env.YSD_VERIFY_PORT ?? 3287);
const PROBE = "/api/live";
const IS_WINDOWS = process.platform === "win32";

/** مهلٌ محدودةٌ لكلّ مرحلة — لا انتظارَ مفتوح */
const T_BOOT_MS = 30_000;
const T_FETCH_MS = 10_000;
const T_SHUTDOWN_MS = 5_000;

/**
 * ★ بيئةُ تشغيلٍ صوريّة — لا سرَّ فيها ولا نداءَ إليها.
 *
 * الوسيطُ يستدعي `createServerClient(url, key)` قبل عودته المبكّرة، فيلزم
 * إعدادٌ **صالحٌ نحويًّا** لا أكثر. و`/api/live` يعود قبل أيّ نداءٍ شبكيّ،
 * فلا يُطرق هذا العنوانُ أصلًا.
 *
 * والنطاقُ `.invalid` محجوزٌ بنصّ RFC 2606: لا يُحلّ في DNS البتّة، فلو
 * حاول الكودُ الاتّصالَ يومًا لسقط الطلبُ فورًا بدل أن يبلغ جهةً حقيقيّة.
 */
const RUNTIME_FIXTURE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://ysd-ci.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "ysd-ci-nonsecret-placeholder",
};

/** علاماتُ الميزة — لو بقيت وغابت البوّابةُ فالاستخراجُ فشل، لا الميزةُ اختفت */
const VOICE_MARKERS = ["voice-mic", "voice-privacy", "/voice/transcribe", "local-voice"];

/**
 * ★ كلُّ ما يجب أن يُقرأ «مطفأة».
 *
 * القيمةُ التي تبدو مشتعلةً للناظر وهي مطفأةٌ للكود هي بذرةُ العطب —
 * فتُقاس كلُّها، لا الغيابُ وحدَه.
 */
const MUST_BE_OFF = ["", "0", "false", "true", "yes", "on", " 1", "1 ", "01"];

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
      if (VOICE_MARKERS.some((mk) => readFileSync(file, "utf8").includes(mk))) return true;
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

/** طلبٌ بمهلةٍ صارمة — يُعيد الحالةَ والترويسات، ولا يعلّق */
function probe(path = PROBE) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: HOST, port: PORT, path, method: "GET", timeout: T_FETCH_MS }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, headers: {}, error: "fetch timeout" }); });
    req.on("error", (e) => resolve({ status: 0, headers: {}, error: e.code ?? String(e.message) }));
    req.end();
  });
}

/**
 * ★ يُشغَّل الخرجُ المستقلُّ بـNode مباشرةً.
 *
 * لا `npm start`: ذاك ينشئ `npm → sh → next-server`، فيبقى الحفيدُ حيًّا
 * بعد قتل الأب. وهنا العمليّةُ واحدة، وعلى POSIX تُفصل في مجموعةٍ خاصّةٍ
 * بها لتُقتل كاملةً.
 */
async function startServer(env) {
  if (!existsSync(STANDALONE)) throw new Error("standalone server.js not found after build");
  const child = spawn(process.execPath, [STANDALONE], {
    cwd: join(ROOT, ".next", "standalone"),
    env: { ...process.env, ...env, ...RUNTIME_FIXTURE, HOSTNAME: HOST, PORT: String(PORT), NODE_ENV: "production" },
    stdio: "ignore",
    detached: !IS_WINDOWS,
  });
  const deadline = Date.now() + T_BOOT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    const r = await probe();
    if (r.status > 0) return child;
  }
  await stopServer(child);
  throw new Error(`TIMEOUT[boot]: no response within ${T_BOOT_MS / 1000}s`);
}

/** يُنهي **الشجرة**، ثم ينتظر بحدّ، ثم يقسو — ولا يمسّ عمليّةً أخرى */
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  const exited = new Promise((r) => child.once("exit", () => r(true)));
  try {
    if (IS_WINDOWS) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch { /* ذهبت سلفًا */ }
  const graceful = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), T_SHUTDOWN_MS))]);
  if (!graceful) {
    try { if (!IS_WINDOWS) process.kill(-pid, "SIGKILL"); } catch { /* ذهبت */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
}

/**
 * ★ إثباتُ تحرُّرِ المنفذ — محمولٌ ولا يعتمد على `netstat`.
 *
 * يُربط خادمٌ مؤقّتٌ على العنوان نفسِه ثم يُغلق. فإن فشل الربطُ فثمّة
 * خادمٌ مُسرَّب — وهو الانحدارُ الذي أوقع 4G.2 بعينه.
 */
function portFree() {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(PORT, HOST);
  });
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
  for (const f of [".env.local", ".env.development.local", ".env.production.local", ".env"]) {
    const p = join(ROOT, f);
    if (existsSync(p) && new RegExp(`^\\s*${name}\\s*=`, "m").test(readFileSync(p, "utf8"))) return "0";
  }
  return undefined;
}
function envFor(voiceOn, imageOn) {
  const e = {};
  const vOff = offValue(VOICE), iOff = offValue(IMAGE);
  if (voiceOn) e[VOICE] = "1"; else if (vOff !== undefined) e[VOICE] = vOff;
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
    console.log("   absence itself is still proven by executing the shipped gate with no value)");
  }
  console.log(`  probe: http://${HOST}:${PORT}${PROBE} · launcher: .next/standalone/server.js\n`);
}

/**
 * ★ حارسُ سلامةِ البيئة الصوريّة.
 *
 * يُقاس أنّها لا تحمل مضيفًا حقيقيًّا ولا شيئًا يشبه مفتاحًا. فبيئةُ اختبارٍ
 * تتسرّب إليها قيمةُ إنتاجٍ يومًا تجعل الحارسَ يطرق جهةً حيّة.
 */
{
  const url = RUNTIME_FIXTURE.NEXT_PUBLIC_SUPABASE_URL;
  const key = RUNTIME_FIXTURE.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  ok(/^https:\/\/[a-z0-9-]+\.invalid$/.test(url), "the runtime fixture host is a reserved .invalid name");
  ok(!/supabase\.co|railway\.app|\.com|\.net|\.org/i.test(url), "the fixture names no real host");
  ok(!/^eyJ/.test(key) && key.length < 60, "the fixture key is a placeholder, not a JWT");
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
    child = await startServer(env);
    const res = await probe();

    /**
     * ★ الاستجابةُ نفسُها تُفحص قبل ترويساتها.
     *
     * فترويسةٌ غائبةٌ على ردّ 500 تجعل كلَّ فحصِ «لا يحوي الممنوع» يمرّ على
     * نصٍّ فارغ — نجاحٌ أجوف. وهذا ما أوقع 4G.2، والحارسُ يُبقيه أحمر.
     */
    ok(res.status === 200, `${PROBE} answers 200`, res.error ? `${res.status} ${res.error}` : String(res.status));
    const pp = String(res.headers["permissions-policy"] ?? "");
    const csp = String(res.headers["content-security-policy"] ?? "");
    ok(pp.length > 0, "a Permissions-Policy header is actually present");
    ok(csp.length > 0, "a Content-Security-Policy header is actually present");
    if (res.status !== 200 || !pp.length || !csp.length) continue;

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
    const serverGates = extractVoiceGates([SERVER_DIR]);

    /**
     * ★ «لم أجد بوّابة» ليست «الميزةُ غائبة».
     *
     * لو بقيت علاماتُ الميزة في الحزمة وغابت البوّابةُ فالاستخراجُ عجز —
     * وتحويلُ العجز إلى نجاحٍ هو ما يجعل الحارسَ يكذب يومَ يتغيّر المُصغِّر.
     */
    if (gates.length === 0 && markersPresent([CHUNKS])) {
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
  } catch (e) {
    ok(false, `stage error in "${c.label}"`, String(e.message).slice(0, 120));
  } finally {
    await stopServer(child);
    ok(await portFree(), `the verifier port is released after "${c.label}"`, `${HOST}:${PORT}`);
  }
}

console.log("\n--- restoring the production-default build ---");
build(envFor(false, false));
console.log("  .next rebuilt with both local flags off");

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
if (failed.length) console.log("failed:\n" + failed.map((f) => "  - " + f).join("\n"));
console.log("\nLocal Voice remains OFF unless NEXT_PUBLIC_YSD_LOCAL_VOICE is literal 1 at build time.");
/** ★ خروجٌ صريح: لا مقبضَ عالقٌ يُبقي العمليّةَ حيّةً بعد انتهاء عملها */
process.exit(fail ? 1 : 0);
